import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac,randomUUID} from 'node:crypto';
import worker,{drain} from './worker.mjs';
import {inboxOwnerRoute,inboxArchiveMedia} from './inbox.mjs';
import {waCsvCell} from '../app/public/whatsapp-admin.js';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...args){return {async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};}};},async batch(statements){return Promise.all(statements.map(s=>s.run()));}};
 return {sqlite,env:{DB,VERIFY_TOKEN:'verify',META_APP_SECRET:'secret',WHATSAPP_ACCESS_TOKEN:'meta',WHATSAPP_PHONE_NUMBER_ID:'1234567',WHATSAPP_WABA_ID:'2345678',GRAPH_API_VERSION:'v26.0',SEND_ENABLED:'false',WHATSAPP_ADMIN_TOKEN:'owner-only-secret'}};
}
function payload(id='one',body='Hello',phone='919999999999',timestamp=Date.now()){
 return {object:'whatsapp_business_account',entry:[{id:'2345678',changes:[{field:'messages',value:{metadata:{phone_number_id:'1234567'},contacts:[{wa_id:phone,profile:{name:'Customer <script>'}}],messages:[{id,from:phone,timestamp:String(Math.floor(timestamp/1000)),type:'text',text:{body}}]}}]}]};
}
async function ingest(f,data){const enabled=f.env.SEND_ENABLED;f.env.SEND_ENABLED='false';try{const raw=JSON.stringify(data),waits=[],r=await worker.fetch(new Request('https://x/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','secret').update(raw).digest('hex')},body:raw}),f.env,{waitUntil(p){waits.push(p);}});assert.equal(r.status,200);await Promise.all(waits);}finally{f.env.SEND_ENABLED=enabled;}}
async function owner(f,path,method='GET',body,fetcher=async()=>{throw Error('Unexpected external request');},token=f.env.WHATSAPP_ADMIN_TOKEN){
 const r=await inboxOwnerRoute(new Request('https://internal/owner/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env,fetcher);
 return {status:r.status,data:await r.json()};
}
function network({unknown=false,fail=false}={}){const calls=[];return {calls,async fetch(url,options){assert.ok(String(url).startsWith('https://graph.facebook.com/'));calls.push(JSON.parse(options.body));if(unknown)throw Error('Disconnected');return fail?Response.json({error:{code:190}},{status:401}):Response.json({messages:[{id:'wamid.manual.'+calls.length}]});}};}

test('complete 4096-character messages, profiles, raw media details and deduplicated unread counts are saved',async()=>{
 const f=fixture(),long='अ'.repeat(4096);await ingest(f,payload('long',long));await ingest(f,payload('long',long));
 const raw=payload('image','');raw.entry[0].changes[0].value.messages[0]={id:'image',from:'919999999999',timestamp:String(Math.floor(Date.now()/1000)),type:'image',image:{id:'123456789',mime_type:'image/jpeg',caption:'Photo caption'}};await ingest(f,raw);
 const data=(await owner(f,'contacts/919999999999/messages')).data;
 assert.equal(data.messages.length,2);assert.equal(data.messages.find(m=>m.type==='text').body.length,4096);assert.equal(data.contact.name,'Customer <script>');assert.equal(data.contact.unread,2);
 const image=data.messages.find(m=>m.type==='image');assert.equal(image.media_id,'123456789');assert.equal(image.body,'Photo caption');assert.equal(JSON.parse(image.details_json).image.mime_type,'image/jpeg');
});
test('owner inbox rejects missing/wrong credentials before touching storage',async()=>{
 const env={WHATSAPP_ADMIN_TOKEN:'secret',get DB(){throw Error('Must not read DB');}};
 for(const token of ['','Bearer wrong']){const r=await inboxOwnerRoute(new Request('https://x/owner/contacts',{headers:{Authorization:token}}),env);assert.equal(r.status,404);}
});
test('old incoming messages are saved but cannot trigger the guide or free-text manual reply',async()=>{
 const f=fixture(),net=network();await ingest(f,payload('delayed','An older customer message','919999999999',Date.now()-2*86400000));f.env.SEND_ENABLED='true';await drain(f.env,net.fetch);
 assert.equal(net.calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wa_messages').get().n,1);
 assert.equal((await owner(f,'contacts/919999999999/send','POST',{text:'Hello',clientId:randomUUID()},net.fetch)).status,409);
});
test('manual replies are idempotent across concurrent requests while separate deliberate replies remain possible',async()=>{
 const f=fixture(),net=network();await ingest(f,payload());f.env.SEND_ENABLED='true';const body={text:'आपकी बात पढ़ ली।',clientId:randomUUID()};
 const results=await Promise.all([owner(f,'contacts/919999999999/send','POST',body,net.fetch),owner(f,'contacts/919999999999/send','POST',body,net.fetch)]);
 assert.ok(results.every(r=>[200,202].includes(r.status)));assert.equal(net.calls.length,1);assert.equal(net.calls[0].type,'text');assert.equal(net.calls[0].text.body,body.text);
 await owner(f,'contacts/919999999999/send','POST',{text:'Another personal reply.',clientId:randomUUID()},net.fetch);assert.equal(net.calls.length,2);
 assert.equal((await owner(f,'contacts/919999999999/send','POST',{...body,text:'Changed text'},net.fetch)).status,409);
});
test('manual sends fail closed on opt-out, paused service, invalid text and expired windows',async()=>{
 const f=fixture(),net=network();await ingest(f,payload('stop','STOP'));f.env.SEND_ENABLED='true';
 const send=()=>owner(f,'contacts/919999999999/send','POST',{text:'Hello',clientId:randomUUID()},net.fetch);
 assert.equal((await send()).status,409);assert.equal(net.calls.length,0);
 await ingest(f,payload('stale-start','START','919999999999',Date.now()-60000));assert.equal((await send()).status,409);
 await ingest(f,payload('fresh-start','START','919999999999',Date.now()+1000));assert.equal((await send()).status,202);
 f.env.SEND_ENABLED='false';assert.equal((await send()).status,409);
 assert.equal((await owner(f,'contacts/919999999999/send','POST',{text:'x'.repeat(4097),clientId:randomUUID()},net.fetch)).status,400);
});
test('a human request pauses automation but permits the owner to reply personally',async()=>{
 const f=fixture(),net=network();await ingest(f,payload('human','Please let me talk to a human'));f.env.SEND_ENABLED='true';await drain(f.env,net.fetch);assert.equal(net.calls.length,0);
 assert.equal((await owner(f,'contacts/919999999999/send','POST',{text:'I can help you here.',clientId:randomUUID()},net.fetch)).status,202);assert.equal(net.calls.length,1);
});
test('unknown or failed manual provider outcomes never create an automatic repeat',async()=>{
 for(const options of [{unknown:true},{fail:true}]){
  const f=fixture(),net=network(options);await ingest(f,payload());f.env.SEND_ENABLED='true';const body={text:'One attempt',clientId:randomUUID()};
  await owner(f,'contacts/919999999999/send','POST',body,net.fetch);const result=await owner(f,'contacts/919999999999/send','POST',body,net.fetch);assert.equal(net.calls.length,1);assert.equal(result.data.message.state,options.unknown?'unknown':'failed');
 }
});
test('manual delivery receipts are truthful and do not downgrade a read message',async()=>{
 const f=fixture(),net=network();await ingest(f,payload());f.env.SEND_ENABLED='true';await owner(f,'contacts/919999999999/send','POST',{text:'Hello',clientId:randomUUID()},net.fetch);f.env.SEND_ENABLED='false';
 for(const status of ['read','sent']){const p=payload();const v=p.entry[0].changes[0].value;v.messages=[];v.statuses=[{id:'wamid.manual.1',status,timestamp:String(Math.floor(Date.now()/1000))}];await ingest(f,p);}
 assert.equal(f.sqlite.prepare("SELECT delivery_status FROM wa_messages WHERE source='manual'").get().delivery_status,'read');
});
test('reading only visible message IDs preserves an unread concurrent message at the same timestamp',async()=>{
 const f=fixture(),now=Date.now();await ingest(f,payload('first','Hi','919999999999',now));await ingest(f,payload('second','Hi again','919999999999',now));
 assert.equal((await owner(f,'contacts/919999999999/read','POST',{ids:['in:first']})).status,200);
 assert.equal(f.sqlite.prepare('SELECT unread FROM wa_inbox_contacts').get().unread,1);
});
test('seek pagination covers equal-timestamp histories and indexed Hindi name searches without missing messages',async()=>{
 const f=fixture();await ingest(f,payload('first'));
 const insert=f.sqlite.prepare("INSERT INTO wa_messages(id,phone,direction,type,body,source,created_at,received_at,state) VALUES(?,'919999999999','in','text',?,'customer',10,10,'received')");for(let i=0;i<120;i++)insert.run('fixture-'+String(i).padStart(3,'0'),'message '+i);
 const one=await owner(f,'contacts/919999999999/messages'),two=await owner(f,'contacts/919999999999/messages?cursor='+encodeURIComponent(one.data.nextCursor));
 assert.equal(one.data.messages.length,100);assert.equal(two.data.messages.length,21);assert.equal(new Set([...one.data.messages,...two.data.messages].map(m=>m.id)).size,121);
 const add=f.sqlite.prepare("INSERT INTO wa_inbox_contacts(phone,name,last_at) VALUES(?,?,1)");for(let i=0;i<60;i++)add.run(String(918000000000+i),'रीना '+i);
 const names=await owner(f,'contacts?search='+encodeURIComponent('रीना')),more=await owner(f,'contacts?search='+encodeURIComponent('रीना')+'&cursor='+encodeURIComponent(names.data.nextCursor));assert.equal(names.data.contacts.length,50);assert.equal(more.data.contacts.length,10);
 const plan=f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM wa_inbox_contacts WHERE name>=? COLLATE NOCASE AND name<? COLLATE NOCASE ORDER BY name COLLATE NOCASE,phone LIMIT 51").all('रीना','रीना\uffff');assert.ok(plan.some(row=>row.detail.includes('wa_inbox_name')));
});
test('legacy history import is repeatable and does not send or reset once-only markers',async()=>{
 const f=fixture();await ingest(f,payload());f.sqlite.exec("INSERT INTO lead_downloads(phone,job_id,state,created_at,updated_at) VALUES('919999999999','one','accepted',1,1)");
 const sql=readFileSync(new URL('./inbox-backfill.sql',import.meta.url),'utf8');f.sqlite.exec(sql);f.sqlite.exec(sql);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wa_messages').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lead_downloads').get().n,1);
});
test('an incoming image is archived privately and served only through an authenticated owner route',async()=>{
 const f=fixture(),objects=new Map(),bucket={async put(key,body,options){objects.set(key,{bytes:new Uint8Array(await new Response(body).arrayBuffer()),mime:options.httpMetadata.contentType});},async head(key){const v=objects.get(key);return v?{size:v.bytes.length,httpMetadata:{contentType:v.mime}}:null;},async get(key,options){const v=objects.get(key),range=options?.range;return {body:range?v.bytes.slice(range.offset,range.offset+range.length):v.bytes};},async delete(key){objects.delete(key);}};
 const p=payload('photo','');p.entry[0].changes[0].value.messages[0]={id:'photo',from:'919999999999',timestamp:String(Math.floor(Date.now()/1000)),type:'image',image:{id:'123456789',mime_type:'image/jpeg'}};
 await ingest(f,p);f.env.WA_MEDIA=bucket;f.sqlite.prepare("UPDATE wa_messages SET archive_state='pending',archive_attempts=0").run();
 let requests=0;await inboxArchiveMedia(f.env,async url=>{requests++;return String(url).startsWith('https://graph.facebook.com/')?Response.json({url:'https://lookaside.fbsbx.com/test',file_size:4,mime_type:'image/jpeg'}):new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Length':'4'}});});
 assert.equal(requests,2);assert.equal(objects.size,1);assert.ok([...objects.keys()][0].startsWith('whatsapp-private/'));
 const route=await inboxOwnerRoute(new Request('https://x/owner/media/123456789',{headers:{Authorization:'Bearer owner-only-secret',Range:'bytes=1-2'}}),f.env,()=>{throw Error('Archived media should not call Meta');});assert.equal(route.status,206);assert.deepEqual(new Uint8Array(await route.arrayBuffer()),new Uint8Array([2,3]));
 assert.equal((await owner(f,'media/987654321')).status,404);
 await owner(f,'contacts/919999999999/delete','POST',{});assert.equal(objects.size,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wa_messages').get().n,0);
});
test('CSV export neutralizes spreadsheet formulas while preserving Hindi and multiline text',()=>{
 assert.equal(waCsvCell('=IMPORTXML("x")'),'"\'=IMPORTXML(""x"")"');assert.equal(waCsvCell('नमस्ते\nHello'),'"नमस्ते\nHello"');
});
