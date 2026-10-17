import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker,{parseEvents,drain,command,verifySignature,markIncomingRead,DOWNLOAD_REPLY,DOWNLOAD_URL,GUIDE_VIDEO_URL,readiness} from './worker.mjs';

function fixture(overrides={}) {
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...args){return {
  async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},
  async first(){return sqlite.prepare(sql).get(...args)||null;},
  async all(){return {results:sqlite.prepare(sql).all(...args)};},
 };}};},async batch(items){return Promise.all(items.map(i=>i.run()));}};
 return {sqlite,env:{DB,VERIFY_TOKEN:'test-verify',META_APP_SECRET:'test-secret',WHATSAPP_ACCESS_TOKEN:'test-meta',WHATSAPP_PHONE_NUMBER_ID:'1234567',WHATSAPP_WABA_ID:'2345678',GRAPH_API_VERSION:'v26.0',SEND_ENABLED:'true',...overrides}};
}
function payload(id='inbound-1',text='Hi',timestamp=Date.now(),phone='919999999999') {return {object:'whatsapp_business_account',entry:[{id:'2345678',changes:[{field:'messages',value:{metadata:{phone_number_id:'1234567'},messages:[{id,from:phone,timestamp:String(Math.floor(timestamp/1000)),type:'text',text:{body:text}}]}}]}]};}
function signed(body,secret='test-secret'){const raw=JSON.stringify(body);return new Request('https://example.com/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(raw).digest('hex')},body:raw});}
async function ingest(f,body){const waits=[],enabled=f.env.SEND_ENABLED;f.env.SEND_ENABLED='false';try{const response=await worker.fetch(signed(body),f.env,{waitUntil(p){waits.push(p);}});await Promise.all(waits);return response;}finally{f.env.SEND_ENABLED=enabled;}}
function fakeNetwork({timeout=false,metaError=false,readError=false}={}){const calls=[];return {calls,async fetch(url,options){assert(url.startsWith('https://graph.facebook.com/'),'No OpenAI or media fetching allowed');const body=JSON.parse(options.body);calls.push({url,body});if(body.status==='read')return readError?Response.json({error:{code:190}},{status:401}):Response.json({success:true});if(timeout)throw new Error('timeout');return metaError?Response.json({error:{code:190}},{status:401}):Response.json({messages:[{id:'wamid.test'}]});}};}

test('signature rejects missing, wrong and modified payloads',async()=>{
 const raw=new TextEncoder().encode('hello'),sig='sha256='+createHmac('sha256','secret').update(raw).digest('hex');
 assert.equal(await verifySignature(raw,sig,'secret'),true);assert.equal(await verifySignature(raw,sig,'wrong'),false);assert.equal(await verifySignature(raw,null,'secret'),false);assert.equal(await verifySignature(new TextEncoder().encode('changed'),sig,'secret'),false);
});
test('challenge, bad signatures and oversized events never mark read or send',async()=>{
 const f=fixture();assert.equal(await(await worker.fetch(new Request('https://x/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123'),f.env,{})).text(),'123');
 assert.equal((await worker.fetch(signed(payload(),'wrong'),f.env,{})).status,401);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_read_receipts').get().n,0);
 assert.equal((await worker.fetch(new Request('https://x/webhook',{method:'POST',body:'x'.repeat(262145)}),f.env,{})).status,413);
});
test('only configured account and valid timestamps are accepted; delayed messages remain available in the inbox',()=>{
 const f=fixture(),body=payload();assert.equal(parseEvents(body,f.env).messages.length,1);body.entry[0].id='different';assert.equal(parseEvents(body,f.env).messages.length,0);
 assert.equal(parseEvents(payload('old','hi',Date.now()-86500000),f.env).messages.length,1);
 assert.equal(parseEvents(payload('future','hi',Date.now()+600000),f.env).messages.length,0);
});
test('one video attachment with the exact owner caption and only the homepage link; no OpenAI dependency',async()=>{
 const f=fixture(),net=fakeNetwork();assert.deepEqual(readiness(f.env).missing,[]);
 await ingest(f,payload());await drain(f.env,net.fetch);
 assert.equal(net.calls.length,1);assert.equal(net.calls[0].body.type,'video');
 assert.deepEqual(net.calls[0].body.video,{link:GUIDE_VIDEO_URL,caption:DOWNLOAD_REPLY});
 assert.equal(DOWNLOAD_URL,'https://rekhaastrology.in');assert.deepEqual(DOWNLOAD_REPLY.match(/https?:\/\/\S+/g),[DOWNLOAD_URL]);
 assert(!DOWNLOAD_REPLY.includes('.apk'));assert.equal(net.calls[0].body.document,undefined);assert.equal(net.calls[0].body.text,undefined);
 assert.equal(DOWNLOAD_REPLY,'इस video को देखिए और app में मुझसे  बात कीजिए free\nhttps://rekhaastrology.in');
 assert(DOWNLOAD_REPLY.length<=1024,'Caption must fit the provider limit');assert.equal(new URL(GUIDE_VIDEO_URL).protocol,'https:');assert(GUIDE_VIDEO_URL.endsWith('/download-guide.mp4'));
 assert.equal(f.sqlite.prepare('SELECT state FROM lead_downloads').get().state,'accepted');
});

test('health reports video delivery without AI replies',async()=>{
 const f=fixture();const health=await(await worker.fetch(new Request('https://x/health'),f.env,{})).json();
 assert.equal(health.mode,'app_download_video');assert.equal(health.aiReplies,false);assert.equal(health.guideVideo,GUIDE_VIDEO_URL);
 assert.equal(health.dailyLeadLimit,null);assert.equal(health.duplicateProtection,'cloudflare_d1_per_phone');
});

test('existing once-only markers from the link flow do not trigger a new video campaign',async()=>{
 const f=fixture(),net=fakeNetwork();
 f.sqlite.prepare("INSERT INTO lead_downloads(phone,job_id,state,created_at,updated_at) VALUES('919999999999','old-link','accepted',1,1)").run();
 await ingest(f,payload('new-inbound'));await drain(f.env,net.fetch);assert.equal(net.calls.length,0);
});
test('duplicates, concurrent jobs and later messages send only once per lead',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload());await ingest(f,payload());
 await Promise.all([drain(f.env,net.fetch),drain(f.env,net.fetch)]);
 await ingest(f,payload('second'));await drain(f.env,net.fetch);
 assert.equal(net.calls.length,1);assert.equal(f.sqlite.prepare("SELECT error_code FROM lead_jobs WHERE id='second'").get().error_code,'app_link_already_sent');
});
test('each incoming message gets a separate genuine read request, including repeat leads and media',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload('one'));
 const audio=payload('two');audio.entry[0].changes[0].value.messages[0]={...audio.entry[0].changes[0].value.messages[0],type:'audio',audio:{id:'never-download'}};
 await ingest(f,audio);await Promise.all([markIncomingRead(f.env,net.fetch),markIncomingRead(f.env,net.fetch)]);await markIncomingRead(f.env,net.fetch);
 assert.equal(net.calls.length,2);assert.deepEqual(net.calls.map(x=>x.body.message_id).sort(),['one','two']);assert(net.calls.every(x=>x.body.status==='read'&&!x.body.to));
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_read_receipts WHERE state='accepted'").get().n,2);
});
test('live webhook path marks two incoming messages read and sends only one app invitation',async()=>{
 const f=fixture(),net=fakeNetwork(),original=globalThis.fetch;globalThis.fetch=net.fetch;
 try {
  for(const id of ['first','second']) {
   const waits=[];const r=await worker.fetch(signed(payload(id)),f.env,{waitUntil(p){waits.push(p);}});
   assert.equal(r.status,200);await Promise.all(waits);
  }
  assert.equal(net.calls.filter(x=>x.body.status==='read').length,2);
  assert.equal(net.calls.filter(x=>x.body.to).length,1);
 }finally{globalThis.fetch=original;}
});
test('read failures retry at most three times and do not falsify outgoing delivery state',async()=>{
 const f=fixture(),net=fakeNetwork({readError:true});await ingest(f,payload());
 for(let i=0;i<5;i++)await markIncomingRead(f.env,net.fetch);
 assert.equal(net.calls.length,3);assert.equal(f.sqlite.prepare('SELECT state FROM lead_read_receipts').get().state,'failed');
 assert.equal(f.sqlite.prepare('SELECT delivery_status FROM lead_jobs').get().delivery_status,null);
});
test('interrupted read marking can recover without resending the app link',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload());f.sqlite.prepare("UPDATE lead_read_receipts SET state='processing',updated_at=1,attempts=1").run();
 await markIncomingRead(f.env,net.fetch);assert.equal(net.calls.length,1);assert.equal(f.sqlite.prepare('SELECT state FROM lead_read_receipts').get().state,'accepted');
});
test('STOP and human handoff pause app sends; their read receipts still work',async()=>{
 for(const text of ['STOP','Please let me talk to a human']){
  const f=fixture(),net=fakeNetwork(),now=Date.now();await ingest(f,payload('first','hi',now-5000));await ingest(f,payload('stop',text,now));await ingest(f,payload('stale-start','START',now-10000));
  await drain(f.env,net.fetch,5);assert.equal(net.calls.length,0);assert.equal(f.sqlite.prepare('SELECT paused FROM lead_contacts').get().paused,1);
  await markIncomingRead(f.env,net.fetch);assert(net.calls.every(x=>x.body.status==='read'));
 }
 assert.equal(command('बंद करो'),'stop');
});
test('more than 100 distinct leads send without a daily cap, ignoring old budget settings',async()=>{
 const f=fixture({DAILY_SEND_LIMIT:'1'}),net=fakeNetwork(),day=new Date().toISOString().slice(0,10);
 f.sqlite.prepare('INSERT INTO lead_budget(day,requests) VALUES(?,10000)').run(day);
 for(let i=0;i<125;i++){
  await ingest(f,payload('lead-'+i,'Hi',Date.now(),String(919000000000+i)));await drain(f.env,net.fetch);
 }
 assert.equal(net.calls.length,125);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_downloads').get().n,125);
 assert.equal(f.sqlite.prepare('SELECT requests FROM lead_budget WHERE day=?').get(day).requests,10000,'Old daily counters are no longer used');
});

test('disabled sending remains respected after removing the daily cap',async()=>{
 const f=fixture({SEND_ENABLED:'false'}),net=fakeNetwork();await ingest(f,payload());await drain(f.env,net.fetch);await markIncomingRead(f.env,net.fetch);assert.equal(net.calls.length,0);
});

test('Cloudflare D1 once-only marker survives history pruning and a fresh worker environment',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload('first'));await drain(f.env,net.fetch);
 f.sqlite.prepare('UPDATE lead_jobs SET created_at=1').run();f.sqlite.prepare('DELETE FROM lead_contacts').run();
 await ingest(f,payload('after-restart'));await drain({...f.env},net.fetch);
 assert.equal(net.calls.length,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_jobs WHERE id='first'").get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_downloads').get().n,1);
 assert.equal(f.sqlite.prepare("SELECT error_code FROM lead_jobs WHERE id='after-restart'").get().error_code,'app_link_already_sent');
});
test('ambiguous send is never repeated, even on a later inbound message',async()=>{
 const f=fixture(),net=fakeNetwork({timeout:true});await ingest(f,payload());await drain(f.env,net.fetch);await ingest(f,payload('again'));await drain(f.env,net.fetch);
 assert.equal(net.calls.length,1);assert.equal(f.sqlite.prepare('SELECT state FROM lead_downloads').get().state,'unknown');
});
test('Meta failure is recorded instead of generating an extra reply',async()=>{
 const f=fixture(),net=fakeNetwork({metaError:true});await ingest(f,payload());await drain(f.env,net.fetch);
 assert.equal(net.calls.length,1);assert.equal(f.sqlite.prepare('SELECT error_code FROM lead_downloads').get().error_code,'meta_190');
});
test('received delivery callbacks remain truthful and never downgrade read to sent',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload());await drain(f.env,net.fetch);
 for(const status of ['read','sent']){const body=payload();body.entry[0].changes[0].value.messages=[];body.entry[0].changes[0].value.statuses=[{id:'wamid.test',status,timestamp:String(Math.floor(Date.now()/1000))}];await ingest(f,body);}
 assert.equal(f.sqlite.prepare('SELECT delivery_status FROM lead_downloads').get().delivery_status,'read');assert.equal(f.sqlite.prepare('SELECT delivery_status FROM lead_jobs').get().delivery_status,'read');
});
test('retention removes old text while keeping opt-outs and once-only app delivery records',async()=>{
 const f=fixture(),net=fakeNetwork();await ingest(f,payload('old'));await drain(f.env,net.fetch);
 f.sqlite.prepare('UPDATE lead_jobs SET created_at=1').run();f.sqlite.prepare('UPDATE lead_read_receipts SET created_at=1').run();f.sqlite.prepare('UPDATE lead_contacts SET paused=1').run();
 await ingest(f,payload('new'));assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_jobs WHERE id='old'").get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_downloads').get().n,1);assert.equal(f.sqlite.prepare('SELECT paused FROM lead_contacts').get().paused,1);
});
