import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker,{parseEvents,drain,command,safeReply,generateReply,verifySignature} from './worker.mjs';

function fixture(overrides={}) {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){return {bind(...args){return {
    async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},
    async first(){return sqlite.prepare(sql).get(...args)||null;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},
  };}};},async batch(items){return Promise.all(items.map(i=>i.run()));}};
  return {sqlite,env:{DB,VERIFY_TOKEN:'test-verify',META_APP_SECRET:'test-secret',WHATSAPP_ACCESS_TOKEN:'test-meta',WHATSAPP_PHONE_NUMBER_ID:'1234567',WHATSAPP_WABA_ID:'2345678',OPENAI_API_KEY:'test-ai',OPENAI_MODEL:'configured-model',GRAPH_API_VERSION:'v23.0',SEND_ENABLED:'true',...overrides}};
}
function payload(id='inbound-1',text='How do I download?', timestamp=Date.now()) {return {object:'whatsapp_business_account',entry:[{id:'2345678',changes:[{field:'messages',value:{metadata:{phone_number_id:'1234567'},messages:[{id,from:'919999999999',timestamp:String(Math.floor(timestamp/1000)),type:'text',text:{body:text}}]}}]}]};}
function signed(body,secret='test-secret'){const raw=JSON.stringify(body);return new Request('https://example.com/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(raw).digest('hex')},body:raw});}
async function ingest(f,body){const waits=[];const enabled=f.env.SEND_ENABLED;f.env.SEND_ENABLED='false';const response=await worker.fetch(signed(body),f.env,{waitUntil(p){waits.push(p);}});await Promise.all(waits);f.env.SEND_ENABLED=enabled;return response;}
function fakeNetwork({timeout=false,metaError=false}={}){const calls=[];return {calls,async fetch(url,options){calls.push({url,body:JSON.parse(options.body)});if(url.includes('openai'))return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Download Rekha Astrology here: https://rekhaastrology.in'}]}]});if(timeout)throw new Error('timeout');return metaError?Response.json({error:{code:190}},{status:401}):Response.json({messages:[{id:'wamid.test'}]});}};}

test('signature rejects missing, wrong and modified payloads',async()=>{
 const raw=new TextEncoder().encode('hello'),sig='sha256='+createHmac('sha256','secret').update(raw).digest('hex');
 assert.equal(await verifySignature(raw,sig,'secret'),true);assert.equal(await verifySignature(raw,sig,'wrong'),false);assert.equal(await verifySignature(raw,null,'secret'),false);assert.equal(await verifySignature(new TextEncoder().encode('changed'),sig,'secret'),false);
});
test('webhook challenge and rejection cause no external sends',async()=>{
 const f=fixture();assert.equal(await(await worker.fetch(new Request('https://x/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123'),f.env,{})).text(),'123');
 assert.equal((await worker.fetch(signed(payload(),'wrong'),f.env,{})).status,401);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_jobs').get().n,0);
 assert.equal((await worker.fetch(new Request('https://x/webhook',{method:'POST',body:'x'.repeat(262145)}),f.env,{})).status,413);
});
test('only configured account and recent inbound text is accepted',()=>{
 const f=fixture(),body=payload();assert.equal(parseEvents(body,f.env).messages.length,1);
 body.entry[0].id='different';assert.equal(parseEvents(body,f.env).messages.length,0);
 assert.equal(parseEvents(payload('old','hi',Date.now()-86500000),f.env).messages.length,0);
});
test('authenticated traffic prunes old content while preserving opt-outs without cron',async()=>{
 const f=fixture();
 f.sqlite.prepare('INSERT INTO lead_contacts(phone,last_inbound,created_at,paused) VALUES(?,?,?,1)').run('918888888888',1,1);
 f.sqlite.prepare("INSERT INTO lead_jobs(id,phone,body,inbound_at,created_at,state) VALUES('expired','918888888888','private old text',1,1,'accepted')").run();
 f.sqlite.prepare("INSERT INTO lead_budget(day,requests) VALUES('2020-01-01',1)").run();
 const bad=await worker.fetch(signed(payload(),'wrong'),f.env,{});
 assert.equal(bad.status,401);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_jobs WHERE id='expired'").get().n,1);
 await ingest(f,payload('fresh'));
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_jobs WHERE id='expired'").get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_jobs WHERE id='fresh'").get().n,1);
 assert.equal(f.sqlite.prepare("SELECT paused FROM lead_contacts WHERE phone='918888888888'").get().paused,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_budget').get().n,0);
});
test('duplicate webhooks and competing processors send once',async()=>{
 const f=fixture(),body=payload();assert.equal((await ingest(f,body)).status,200);await ingest(f,body);
 const net=fakeNetwork();await Promise.all([drain(f.env,net.fetch),drain(f.env,net.fetch)]);await drain(f.env,net.fetch);
 assert.equal(net.calls.length,2);assert.equal(net.calls[0].body.store,false);assert.equal(net.calls[1].body.to,'919999999999');
 assert.equal(f.sqlite.prepare('SELECT state FROM lead_jobs').get().state,'accepted');
});
test('STOP pauses earlier queued messages and a stale START cannot undo it',async()=>{
 const f=fixture();const now=Date.now();await ingest(f,payload('first','hi',now-5000));await ingest(f,payload('stop','STOP',now));await ingest(f,payload('old-start','START',now-10000));
 const net=fakeNetwork();await drain(f.env,net.fetch,5);assert.equal(net.calls.length,0);assert.equal(f.sqlite.prepare('SELECT paused FROM lead_contacts').get().paused,1);
});
test('opt-out arriving during generation cancels the send',async()=>{
 const f=fixture();await ingest(f,payload());let calls=0;
 await drain(f.env,async()=>{calls++;f.sqlite.prepare('UPDATE lead_contacts SET paused=1').run();return Response.json({output:[{type:'message',content:[{type:'output_text',text:'Hello'}]}]});});
 assert.equal(calls,1);assert.equal(f.sqlite.prepare('SELECT state FROM lead_jobs').get().state,'skipped');
});
test('daily budget bounds API requests and disabled service sends nothing',async()=>{
 const f=fixture({DAILY_AI_LIMIT:'1'}),net=fakeNetwork();await ingest(f,payload('one'));await ingest(f,payload('two'));await drain(f.env,net.fetch,5);
 assert.equal(net.calls.filter(c=>c.url.includes('openai')).length,1);
 f.env.SEND_ENABLED='false';await ingest(f,payload('three'));await drain(f.env,net.fetch);assert.equal(net.calls.length,2);
});
test('ambiguous Meta timeout is never automatically resent',async()=>{
 const f=fixture(),net=fakeNetwork({timeout:true});await ingest(f,payload());await drain(f.env,net.fetch);await drain(f.env,net.fetch);
 assert.equal(net.calls.length,2);assert.equal(f.sqlite.prepare('SELECT state FROM lead_jobs').get().state,'unknown');
});
test('acceptance is separate from receipts and out-of-order sent cannot downgrade read',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload());await drain(f.env,net.fetch);
 assert.equal(f.sqlite.prepare('SELECT delivery_status FROM lead_jobs').get().delivery_status,null);
 for(const status of ['read','sent']){const body=payload();body.entry[0].changes[0].value.messages=[];body.entry[0].changes[0].value.statuses=[{id:'wamid.test',status,timestamp:String(Math.floor(Date.now()/1000))}];await ingest(f,body);}
 assert.equal(f.sqlite.prepare('SELECT delivery_status FROM lead_jobs').get().delivery_status,'read');
});
test('model failures and unapproved URLs produce no WhatsApp send',async()=>{
 const f=fixture();await ingest(f,payload());let count=0;await drain(f.env,async()=>{count++;return Response.json({error:{}},{status:429});});assert.equal(count,1);assert.equal(f.sqlite.prepare('SELECT state FROM lead_jobs').get().state,'failed');
 assert.throws(()=>safeReply('visit https://evil.example'));assert.throws(()=>safeReply('visit https://rekhaastrology.in.evil.example'));assert.equal(safeReply('Go to https://rekhaastrology.in.'),'Go to https://rekhaastrology.in.');
 assert.equal(command('बंद करो'),'stop');assert.equal(command('Please let me talk to a human'),'human');
 await assert.rejects(generateReply(f.env,[],async()=>Response.json({status:'incomplete',output:[]})),/incomplete/);
});
