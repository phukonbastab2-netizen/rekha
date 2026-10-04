import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
// Local transient-failure regression. No cloud requests, credentials or persistent data.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = './';
const files = ['cloudflare/rewards.mjs', 'cloudflare/messaging.mjs', 'cloudflare/calls.mjs', 'cloudflare/workflow.mjs', 'cloudflare/app-settings.mjs', 'cloudflare/owner.mjs', 'src/ai.mjs', 'cloudflare/kundli-followup.mjs', 'cloudflare/worker.mjs'];
let source = files.map(file => fs.readFileSync(root + file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export (async function|function|const)/g, '$1')).join('\n');
const hook = 'async function onCustomerMessage(chat,message){if(automationEnabled)await flowOnCustomer(workflowCtx,chat,message);}';
assert.equal(source.split(hook).length - 1, 1, 'The current worker must have one guarded customer workflow hook.');
source = 'let fixtureHookFailed=false,fixtureBackgroundFailed=false;\n' + source.replace(hook,
  "async function onCustomerMessage(chat,message){if(!automationEnabled)return;if(!fixtureHookFailed){fixtureHookFailed=true;throw Error('Local injected transient hook failure');}await flowOnCustomer(workflowCtx,chat,message);}");
const backgroundHook='const run=async()=>{';assert.ok(source.includes(backgroundHook),'The current worker must have its deferred background callback.');
source=source.replace(backgroundHook,"const run=async()=>{if(!fixtureBackgroundFailed){fixtureBackgroundFailed=true;throw Error('Local interrupted background fixture');}");
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: source, compatibilityDate: '2026-09-24',
  d1Databases: { DB: 'workflow-retry-test' }, r2Buckets: { MEDIA: 'workflow-retry-media' },
  bindings: { CUSTOMER_AUTOMATION_ENABLED:'true', ADMIN_PASSWORD_HASH: createHash('sha256').update('local-retry-fixture').digest('hex') }
}));
console.log('Local workflow retry fixture starting.');
try {
  const db = await mf.getD1Database('DB');
  for (const sql of splitSqlStatements(fs.readFileSync(root + 'cloudflare/schema.sql', 'utf8'))) await db.prepare(sql).run();
  const config = {
    enabled: true, paymentEnabled: false, revision: 1,
    timings: { firstDelayMs: 5000, itemGapMs: 5000, reminderDelayMs: 60000, mediaDelayMs: 3600000 }, assets: {},
    content: { greeting: 'Local recovered greeting', firstCaption: 'Video', testimonialsCaption: 'Experiences', final: '₹49 preview', reminder: '₹49 preview', kundliCaption: 'Illustrative', solutionCaption: 'Example', pujaCaption: 'Example', qrCaption: 'Inactive' },
    translations: { en: {}, hinglish: {} }
  };
  for (const [key, type] of Object.entries({ firstVideo: 'video', testimonials: 'video', kundli: 'image', solution: 'image', puja: 'image', voice: 'audio' })) {
    const id = randomUUID(); config.assets[key] = id;
    await db.prepare('INSERT INTO media_items(id,title,type,object_key,mime,size,created) VALUES(?,?,?,?,?,?,?)')
      .bind(id, key, type, 'fixture/' + id, type === 'video' ? 'video/mp4' : type === 'audio' ? 'audio/mpeg' : 'image/png', 20, Date.now()).run();
  }
  await db.prepare('INSERT INTO workflow_settings(key,value) VALUES(?,?)').bind('config', JSON.stringify(config)).run();
  async function api(route, method = 'GET', data, cookie = '') {
    const response = await mf.dispatchFetch('https://rekha.test' + route, {
      method, headers: { Origin: 'https://rekha.test', 'Content-Type': 'application/json', Cookie: cookie },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
  }
  const signup = await api('/api/start', 'POST', { name: 'Local workflow retry fixture', dob: '1990-01-01', language: 'hi', consent: true, preferences: {} });
  assert.equal(signup.status, 201); const cookie = signup.cookie, id = signup.data.id, clientId = randomUUID(), payload = { body: 'Synthetic first message', clientId };
  const failed = await api('/api/messages', 'POST', payload, cookie);
  assert.equal(failed.status, 202, 'The saved message is acknowledged despite interrupted subsequent scheduling.');
  const stored = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role=?').bind(id, 'user').first();
  assert.equal(stored.n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workflow_jobs WHERE conversation_id=?').bind(id).first()).n, 0);
  let recovered;for(let attempt=0;attempt<60;attempt++){recovered=await api('/api/chat','GET',undefined,cookie);if(recovered.data.messages.some(message=>message.body===config.content.greeting))break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(recovered.status, 200, 'Customer polling repairs the event without requiring a resend.');
  assert.equal(recovered.data.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(recovered.data.messages.filter(message => message.kind === 'owner-message').length, 1);
  assert.equal(recovered.data.messages.at(-1).body, config.content.greeting);
  assert.equal(recovered.data.freeUsed, 0); assert.equal(recovered.data.guidedConversation, true);
  const once = await api('/api/messages', 'POST', payload, cookie);
  assert.equal(once.status, 200); assert.equal(once.data.messages.filter(message => message.kind === 'owner-message').length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workflow_events WHERE conversation_id=?').bind(id).first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workflow_jobs WHERE conversation_id=?').bind(id).first()).n, 1);
  console.log('Workflow retry regression passed: committed message is acknowledged immediately and recovers on polling after interrupted scheduling, no duplicate messages/events/jobs and no free credit increment.');
} finally {
  await mf.dispose();
}
