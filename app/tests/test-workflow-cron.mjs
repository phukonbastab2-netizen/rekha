// Runs the exact bundled scheduled handler against temporary local Miniflare D1/R2.
// No production connections, private credentials or customer data are used.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = './';
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: fs.readFileSync(root + 'cloudflare/worker-bundle.mjs', 'utf8'),
  compatibilityDate: '2026-09-24', host: '127.0.0.1', port: 0,
  d1Databases: { DB: 'workflow-cron-test' }, r2Buckets: { MEDIA: 'workflow-cron-media' },
  bindings: { ADMIN_PASSWORD_HASH: createHash('sha256').update('local-cron-fixture').digest('hex') }
}));
console.log('Local bundled Worker cron fixture starting.');
try {
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('MEDIA');
  for (const sql of fs.readFileSync(root + 'cloudflare/schema.sql', 'utf8').split(';').filter(value => value.trim())) await db.prepare(sql).run();
  const config = {
    enabled: true, paymentEnabled: false, revision: 1,
    timings: { firstDelayMs: 5000, itemGapMs: 5000, reminderDelayMs: 60000, mediaDelayMs: 3600000 }, assets: {},
    content: { greeting: 'Cron fixture greeting', firstCaption: 'Instruction', testimonialsCaption: 'Shared experiences', final: '₹49 preview final', reminder: '₹49 preview reminder', kundliCaption: 'Illustrative chart', solutionCaption: 'Example', pujaCaption: 'Information', qrCaption: 'Inactive' },
    translations: { en: {}, hinglish: {} }
  };
  const png = fs.readFileSync(root + 'public/icon-192.png');
  // Format-valid MP4 container header and a tiny PCM WAV fixture are sufficient
  // for this storage/scheduling test; it does not exercise a media decoder.
  const mp4 = Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0,105,115,111,109,109,112,52,49]);
  const wav = Buffer.alloc(76); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32, 40);
  for (const [key, type] of Object.entries({ firstVideo: 'video', testimonials: 'video', kundli: 'image', solution: 'image', puja: 'image', voice: 'audio' })) {
    const id = randomUUID(), objectKey = 'fixture-library/' + id, bytes = type === 'video' ? mp4 : type === 'audio' ? wav : png,
      mime = type === 'video' ? 'video/mp4' : type === 'audio' ? 'audio/wav' : 'image/png';
    config.assets[key] = id;
    await db.prepare('INSERT INTO media_items(id,title,type,object_key,mime,size,created) VALUES(?,?,?,?,?,?,?)')
      .bind(id, key, type, objectKey, mime, bytes.length, Date.now()).run();
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: mime } });
  }
  await db.prepare('INSERT INTO workflow_settings(key,value) VALUES(?,?)').bind('config', JSON.stringify(config)).run();
  async function api(route, method = 'GET', data, cookie = '') {
    const response = await mf.dispatchFetch('https://rekha.test' + route, {
      method, headers: { Origin: 'https://rekha.test', 'Content-Type': 'application/json', Cookie: cookie },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
  }
  const signup = await api('/api/start', 'POST', { name: 'Local cron fixture', dob: '1990-01-01', language: 'hi', consent: true, preferences: {} });
  assert.equal(signup.status, 201); const id = signup.data.id, cookie = signup.cookie;
  const first = await api('/api/messages', 'POST', { body: 'Synthetic cron question', clientId: randomUUID() }, cookie);
  assert.equal(first.status, 202); assert.equal(first.data.messages.filter(message => message.kind === 'owner-message').length, 1);
  let job = await db.prepare('SELECT * FROM workflow_jobs WHERE conversation_id=? AND kind=?').bind(id, 'first').first();
  assert.equal(job.step, 1); assert.equal(job.status, 'pending');
  const payload = JSON.parse(job.payload); payload.timings.firstDelayMs = 200; payload.timings.itemGapMs = 200;
  // Only the local fixture job changes: production/source/config remain untouched.
  await db.prepare('UPDATE workflow_jobs SET due=?,payload=? WHERE id=?').bind(Date.now(), JSON.stringify(payload), job.id).run();

  const oldId = randomUUID(), oldAttachmentId = randomUUID(), oldKey = 'fixture-attachments/' + oldAttachmentId,
    oldTime = Date.now() - 32 * 86400000, pdf = Buffer.from('%PDF-1.4\n% Local expired fixture\n%%EOF');
  await db.prepare('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .bind(oldId, randomUUID(), 'Local expired fixture', '1990-01-01', 'hi', '{}', oldTime, oldTime).run();
  await db.prepare('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,ready,created) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(oldAttachmentId, oldId, 'expired.pdf', 'document', oldKey, 'application/pdf', pdf.length, 1, oldTime).run();
  await bucket.put(oldKey, pdf, { httpMetadata: { contentType: 'application/pdf' } });
  await db.prepare('INSERT INTO admin_sessions(token_hash,expires) VALUES(?,?)').bind('local-expired-admin-fixture', Date.now() - 1000).run();
  await db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,?,?)').bind('local-expired-rate-fixture', 1, Date.now() - 1000).run();

  // Miniflare#getWorker returns its Fetcher. Installed core scheduled.ts uses
  // service.scheduled({scheduledTime: Date, cron: string}); there is no separate
  // dispatchScheduled method in this installed version.
  const worker = await mf.getWorker();
  const dispatch = async cron => {
    const began = Date.now(), outcome = await worker.scheduled({ scheduledTime: new Date(), cron });
    assert.equal(outcome.outcome, 'ok', 'The actual scheduled handler must succeed.');
    return Date.now() - began;
  };
  console.log('Dispatching actual minute cron; no customer chat polling occurs.');
  const sequenceElapsed = await dispatch('* * * * *');
  job = await db.prepare('SELECT * FROM workflow_jobs WHERE id=?').bind(job.id).first();
  assert.equal(job.status, 'done'); assert.equal(job.step, 4);
  const flow = await db.prepare('SELECT stage FROM chat_workflow WHERE conversation_id=?').bind(id).first();
  assert.equal(flow.stage, 'WAITING_FOR_DETAILS');
  const replies = (await db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='assistant' AND kind!='welcome' ORDER BY id").bind(id).all()).results;
  assert.equal(replies.length, 4); assert.equal(replies[0].body, config.content.greeting);
  assert.equal(JSON.parse(replies[1].body).items[0].id, config.assets.firstVideo);
  assert.equal(JSON.parse(replies[2].body).items[0].id, config.assets.testimonials);
  assert.equal(replies[3].body, config.content.final);
  // The first due is shortened explicitly above; remaining gaps must be observed.
  for (let index = 2; index < replies.length; index++) assert.ok(replies[index].created - replies[index - 1].created >= 200);
  assert.ok(sequenceElapsed < 10000, 'The shortened sequence must finish within a bounded timer window.');
  assert.equal((await db.prepare('SELECT free_used FROM conversations WHERE id=?').bind(id).first()).free_used, 0);
  assert.ok(await db.prepare('SELECT id FROM conversations WHERE id=?').bind(oldId).first());
  assert.ok(await db.prepare('SELECT id FROM chat_attachments WHERE id=?').bind(oldAttachmentId).first());
  assert.ok(await bucket.head(oldKey), 'The minute cron must not delete expired private objects.');
  assert.ok(await db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash=?').bind('local-expired-admin-fixture').first());
  assert.ok(await db.prepare('SELECT 1 FROM rate_limits WHERE key=?').bind('local-expired-rate-fixture').first());

  const trigger = await api('/api/messages', 'POST', { body: 'Synthetic reminder details', clientId: randomUUID() }, cookie);
  assert.equal(trigger.status, 202);
  const futureJob = await db.prepare("SELECT * FROM workflow_jobs WHERE conversation_id=? AND kind='reminder'").bind(id).first();
  assert.equal(futureJob.status, 'pending'); assert.ok(futureJob.due > Date.now() + 20000);
  const futureElapsed = await dispatch('* * * * *');
  assert.ok(futureElapsed < 5000, 'Cron must return promptly instead of waiting for a job beyond its 20-second deadline.');
  assert.equal((await db.prepare('SELECT status FROM workflow_jobs WHERE id=?').bind(futureJob.id).first()).status, 'pending');
  assert.ok(await bucket.head(oldKey));

  console.log('Dispatching actual daily cron; checking local retention cleanup.');
  const dailyElapsed = await dispatch('17 2 * * *');
  assert.ok(dailyElapsed < 5000);
  assert.equal(await db.prepare('SELECT id FROM conversations WHERE id=?').bind(oldId).first(), null);
  assert.equal(await db.prepare('SELECT id FROM chat_attachments WHERE id=?').bind(oldAttachmentId).first(), null);
  assert.equal(await bucket.head(oldKey), null);
  assert.equal(await db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash=?').bind('local-expired-admin-fixture').first(), null);
  assert.equal(await db.prepare('SELECT 1 FROM rate_limits WHERE key=?').bind('local-expired-rate-fixture').first(), null);
  assert.ok(await db.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first(), 'Daily retention must preserve the active synthetic chat.');
  assert.equal((await db.prepare('SELECT status FROM workflow_jobs WHERE id=?').bind(futureJob.id).first()).status, 'pending');
  for (const assetId of Object.values(config.assets)) assert.ok(await bucket.head('fixture-library/' + assetId), 'Owner library files must survive customer retention.');
  console.log(JSON.stringify({ exactBundledWorkerScheduledHandler: true, sequenceWithoutCustomerPolling: true,
    minuteCronPreservesExpiredChatAndAttachment: true, dailyCronDeletesExpiredChatAndAttachment: true,
    dailyCronPreservesActiveChatAndOwnerLibrary: true, distantJobsDoNotBlockTimer: true,
    shortFixtureGapsMs: 200, sequenceElapsedMs: sequenceElapsed, futureTimerElapsedMs: futureElapsed, dailyElapsedMs: dailyElapsed,
    productionWrites: false }));
} finally {
  await mf.dispose();
}
