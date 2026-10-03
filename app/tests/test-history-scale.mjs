import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

// Use the actual Worker handlers with an ephemeral database. The dataset stays
// small enough for the ordinary CI runner; the separate benchmark covers volume.
const root=path.resolve('.');
const files=['cloudflare/rewards.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','src/ai.mjs','cloudflare/worker.mjs'];
const script=files.map(name=>readFileSync(path.join(root,name),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',d1Databases:{DB:'bounded-history-test'},r2Buckets:{MEDIA:'bounded-history-media'},bindings:{ADMIN_PASSWORD_HASH:createHash('sha256').update('local-test-password').digest('hex')}}));
const db=await mf.getD1Database('DB');
for(const sql of splitSqlStatements(readFileSync(path.join(root,'cloudflare/schema.sql'),'utf8')))await db.prepare(sql).run();
const bounded={'X-Rekha-History':'bounded-v1'};
async function call(route,method='GET',data,cookie='',headers=bounded){
  const response=await mf.dispatchFetch('https://rekha.test'+route,{method,headers:{Origin:'https://rekha.test','Content-Type':'application/json',Cookie:cookie,...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return{status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
}
async function ok(route,method,data,cookie,headers=bounded,status=200){const response=await call(route,method,data,cookie,headers);assert.equal(response.status,status,route+': '+JSON.stringify(response.data));return response.data;}
async function batches(statements){for(let start=0;start<statements.length;start+=40)await db.batch(statements.slice(start,start+40));}
const ascending=rows=>rows.every((row,index)=>index===0||row.id>rows[index-1].id);
const ids=rows=>rows.map(row=>row.id);

try{
  const first=await call('/api/start','POST',{name:'Private history',dob:'1990-01-01',language:'en',consent:true,preferences:{}});
  const outsider=await call('/api/start','POST',{name:'Other private history',dob:'1990-01-01',language:'en',consent:true,preferences:{}});
  assert.equal(first.status,201);assert.equal(outsider.status,201);
  const cookie=first.cookie,otherCookie=outsider.cookie,id=first.data.id,otherId=outsider.data.id;
  const login=await call('/api/admin/login','POST',{password:'local-test-password'});assert.equal(login.status,200);const owner=login.cookie;
  await ok('/api/admin/conversations/'+id+'/mode','PATCH',{mode:'manual'},owner);
  await ok('/api/admin/conversations/'+otherId+'/mode','PATCH',{mode:'manual'},owner);
  const now=Date.now();
  await batches(Array.from({length:240},(_,index)=>db.prepare('INSERT INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,?,?,?,?,?,?)').bind(id,index%2?'assistant':'user',index%2?'human':'customer','History '+(index+1),'sent','history-'+String(index).padStart(20,'0'),now+index)));
  const stored=(await db.prepare('SELECT id,role,change_revision AS changeRevision FROM messages WHERE conversation_id=? ORDER BY id').bind(id).all()).results;
  assert.equal(stored.length,241);
  const initial=await ok('/api/chat','GET',undefined,cookie);
  assert.equal(initial.historyComplete,false);assert.equal(initial.messages.length,80);assert.ok(initial.page.hasOlder);assert.ok(ascending(initial.messages));assert.equal(initial.page.oldestId,initial.messages[0].id);assert.ok(Number.isSafeInteger(initial.changeRevision));assert.ok(initial.messages.every(row=>Number.isSafeInteger(row.changeRevision)&&row.changeRevision>0));
  assert.deepEqual(ids(initial.messages),ids(stored.slice(-80)));
  assert.ok(initial.messages.filter(row=>row.role==='assistant').every(row=>row.clientId===null));
  let page=initial,loaded=[...initial.messages];
  for(let index=0;index<3;index++){
    page=await ok('/api/chat?beforeId='+page.page.oldestId,'GET',undefined,cookie);
    assert.ok(page.messages.length<=80&&ascending(page.messages));assert.ok(page.messages.every(row=>row.id<loaded[0].id));loaded=[...page.messages,...loaded];
  }
  assert.equal(page.page.hasOlder,false);assert.deepEqual(ids(loaded),ids(stored));assert.equal(new Set(ids(loaded)).size,241);
  const legacy=await ok('/api/chat','GET',undefined,cookie,{});assert.equal(legacy.messages.length,241);assert.equal('historyComplete' in legacy,false);
  assert.equal((await call('/api/chat?beforeId=NaN','GET',undefined,cookie)).status,400);
  assert.equal((await call('/api/chat?afterRevision='+(initial.changeRevision+1),'GET',undefined,cookie)).status,400);
  assert.equal((await call('/api/chat?beforeId=1&afterRevision=0','GET',undefined,cookie)).status,400);
  const other=await ok('/api/chat?afterRevision=0','GET',undefined,otherCookie);assert.ok(other.messages.every(row=>!stored.some(message=>message.id===row.id)));
  assert.equal((await call('/api/admin/conversations/'+otherId,'GET',undefined,cookie)).status,401);

  // Updates to rows outside the recent page must arrive via the durable cursor,
  // including tombstones and side-specific stars. Stars never cross owner scope.
  const user=stored.find(row=>row.role==='user'),assistant=stored.find(row=>row.role==='assistant'&&row.id!==stored[0].id),deleted=stored.filter(row=>row.role==='user')[1];
  await ok('/api/messages/'+user.id,'PATCH',{body:'Edited old loaded question'},cookie);
  await ok('/api/messages/'+user.id+'/star','PUT',{starred:true},cookie);
  await ok('/api/messages/'+user.id+'/reaction','PUT',{emoji:'❤️'},cookie);
  await ok('/api/admin/conversations/'+id+'/messages/'+user.id+'/reaction','PUT',{emoji:'👍'},owner);
  await ok('/api/messages/'+deleted.id,'DELETE',{},cookie);
  const delta=await ok('/api/chat?afterRevision='+initial.changeRevision,'GET',undefined,cookie);
  assert.ok(delta.messages.length<80);assert.ok(delta.changeRevision>initial.changeRevision);
  const revised=delta.messages.find(row=>row.id===user.id),tombstone=delta.messages.find(row=>row.id===deleted.id);
  assert.equal(revised.body,'Edited old loaded question');assert.equal(revised.starred,true);assert.equal(revised.reactions.length,2);assert.ok(revised.changeRevision>user.changeRevision);
  assert.equal(tombstone.deleted,true);assert.equal(tombstone.body,'');assert.deepEqual(tombstone.reactions,[]);
  const ownerDelta=await ok('/api/admin/conversations/'+id+'?afterRevision='+initial.changeRevision,'GET',undefined,owner);
  assert.equal(ownerDelta.messages.find(row=>row.id===user.id).starred,false);
  const quiet=await ok('/api/chat?afterRevision='+delta.changeRevision,'GET',undefined,cookie);assert.deepEqual(quiet.messages,[]);assert.equal(quiet.hasMoreChanges,false);
  await ok('/api/admin/conversations/'+id+'/read','POST',{lastId:user.id},owner);
  await ok('/api/chat/read','POST',{lastId:assistant.id},cookie);
  const receipts=await ok('/api/chat?afterRevision='+delta.changeRevision,'GET',undefined,cookie);assert.deepEqual(receipts.messages,[]);assert.equal(receipts.receiptCursors.ownerRead,user.id);assert.equal(receipts.receiptCursors.customerRead,assistant.id);
  const olderRead=await ok('/api/chat?beforeId='+initial.page.oldestId,'GET',undefined,cookie);assert.equal(olderRead.receiptCursors.ownerRead,user.id);

  // More than one delta page: every revised row arrives exactly once and the
  // next cursor advances to the safe row revision, not the conversation maximum.
  const cursor=receipts.changeRevision,changedRows=stored.filter(row=>row.id!==deleted.id).slice(0,180);
  await batches(changedRows.map(row=>db.prepare('UPDATE messages SET body=? WHERE id=?').bind('Delta revision '+row.id,row.id)));
  const firstDelta=await ok('/api/chat?afterRevision='+cursor,'GET',undefined,cookie);assert.equal(firstDelta.messages.length,120);assert.equal(firstDelta.hasMoreChanges,true);assert.equal(firstDelta.changeRevision,firstDelta.messages.at(-1).changeRevision);
  const nextDelta=await ok('/api/chat?afterRevision='+firstDelta.changeRevision,'GET',undefined,cookie);assert.equal(nextDelta.messages.length,60);assert.equal(nextDelta.hasMoreChanges,false);
  assert.deepEqual(new Set(ids([...firstDelta.messages,...nextDelta.messages])),new Set(ids(changedRows)));
  assert.equal(new Set(ids([...firstDelta.messages,...nextDelta.messages])).size,180);

  // The saved acknowledgment remains available when retrying an uncertain send
  // whose row has since fallen outside the latest page. Retry uses the same ID.
  const clientId=randomUUID(),sent=await ok('/api/messages','POST',{body:'Saved once',clientId},cookie,bounded,202);
  assert.equal(sent.acknowledgedMessage.clientId,clientId);assert.equal(sent.acknowledgedMessage.body,'Saved once');assert.equal(sent.acknowledgedMessage.role,'user');assert.ok(sent.acknowledgedMessage.changeRevision>0);assert.equal(sent.messages.length,80);
  await batches(Array.from({length:90},(_,index)=>db.prepare('INSERT INTO messages(conversation_id,role,kind,body,status,created) VALUES(?,?,?,?,?,?)').bind(id,'assistant','human','Later reply '+index,'sent',now+1000+index)));
  const retried=await ok('/api/messages','POST',{body:'Saved once',clientId},cookie);
  assert.equal(retried.acknowledgedMessage.id,sent.acknowledgedMessage.id);assert.equal(retried.acknowledgedMessage.clientId,clientId);assert.ok(!retried.messages.some(row=>row.id===sent.acknowledgedMessage.id));assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND client_id=?').bind(id,clientId).first()).n,1);
  assert.equal((await ok('/api/chat','GET',undefined,cookie,{})).messages.length,332);

  // An owner can reach every registered customer through indexed keyset pages
  // and prefix search, even when that customer is outside the legacy 500 limit.
  const customers=Array.from({length:550},(_,index)=>({id:randomUUID(),name:'Customer '+String(index).padStart(5,'0'),updated:now+5000+index}));
  const rare={id:randomUUID(),name:'Rare oldest customer',updated:now-10000};
  await batches([...customers,rare].map(row=>db.prepare("INSERT INTO conversations(id,token_hash,name,dob,language,preferences,mode,created,updated) VALUES(?,?,?,'1990-01-01','en','{}','manual',?,?)").bind(row.id,'fixture-'+row.id,row.name,now,row.updated)));
  const inboxRoute='/api/admin/conversations?limit=80&filter=all',inbox=await ok(inboxRoute,'GET',undefined,owner);assert.equal(inbox.items.length,80);assert.equal(inbox.hasMore,true);assert.ok(inbox.nextCursor);
  const inbox2=await ok(inboxRoute+'&cursor='+encodeURIComponent(inbox.nextCursor),'GET',undefined,owner);assert.equal(inbox2.items.length,80);assert.equal(new Set([...inbox.items,...inbox2.items].map(row=>row.id)).size,160);
  const allCustomers=[...inbox.items,...inbox2.items];let continuation=inbox2;
  while(continuation.hasMore){continuation=await ok(inboxRoute+'&cursor='+encodeURIComponent(continuation.nextCursor),'GET',undefined,owner);allCustomers.push(...continuation.items);}
  assert.equal(allCustomers.length,553);assert.equal(new Set(allCustomers.map(row=>row.id)).size,553);assert.ok(allCustomers.some(row=>row.id===rare.id));
  const oldInbox=await ok('/api/admin/conversations','GET',undefined,owner,{});assert.equal(oldInbox.length,500);assert.ok(!oldInbox.some(row=>row.id===rare.id));
  const search=await ok('/api/admin/conversations?limit=80&filter=all&q=Rare','GET',undefined,owner);assert.deepEqual(search.items.map(row=>row.id),[rare.id]);assert.equal(search.hasMore,false);
  const search1=await ok('/api/admin/conversations?limit=80&filter=all&q=Customer','GET',undefined,owner);assert.ok(search1.items.every(row=>row.name.startsWith('Customer')));assert.equal(search1.items[0].name,'Customer 00000');
  const search2=await ok('/api/admin/conversations?limit=80&filter=all&q=Customer&cursor='+encodeURIComponent(search1.nextCursor),'GET',undefined,owner);assert.equal(search2.items[0].name,'Customer 00080');
  assert.equal((await call(inboxRoute+'&q=Rare&cursor='+encodeURIComponent(inbox.nextCursor),'GET',undefined,owner)).status,400);
  assert.equal((await call('/api/admin/conversations?filter=blocked&cursor='+encodeURIComponent(inbox.nextCursor),'GET',undefined,owner)).status,400);
  assert.equal((await call(inboxRoute+'&cursor=malformed','GET',undefined,owner)).status,400);
  assert.equal((await call('/api/admin/conversations?limit=101','GET',undefined,owner)).status,400);
  assert.equal((await call(inboxRoute)).status,401);assert.equal((await call(inboxRoute,'GET',undefined,cookie)).status,401);

  const settingsBefore=await ok('/api/admin/conversations/'+id,'GET',undefined,owner);
  const settings=await ok('/api/admin/conversations/'+id+'/settings','PATCH',{pinned:true,labels:['Private label'],notes:'Private owner note'},owner);
  assert.equal(settings.version,settingsBefore.version);assert.ok(settings.inboxRevision>settingsBefore.inboxRevision);
  const pinned=await ok('/api/admin/conversations?filter=pinned','GET',undefined,owner);assert.deepEqual(pinned.items.map(row=>row.id),[id]);assert.equal(pinned.items[0].inboxRevision,settings.inboxRevision);assert.equal(pinned.items[0].latestUserId,pinned.items[0].latestUserMessageId);assert.equal(pinned.items[0].latestUserId,sent.acknowledgedMessage.id);
  const waiting=await ok('/api/admin/conversations?filter=waiting','GET',undefined,owner);assert.ok(waiting.items.some(row=>row.id===id&&row.waiting>0));
  const unread=await ok('/api/admin/conversations?filter=unread','GET',undefined,owner);assert.ok(unread.items.some(row=>row.id===id&&row.unread>0));
  await ok('/api/admin/conversations/'+id+'/settings','PATCH',{blocked:true},owner);const blocked=await ok('/api/admin/conversations?filter=blocked','GET',undefined,owner);assert.deepEqual(blocked.items.map(row=>row.id),[id]);
  await ok('/api/admin/conversations/'+id+'/settings','PATCH',{archived:true},owner);assert.deepEqual((await ok('/api/admin/conversations?filter=blocked','GET',undefined,owner)).items,[]);assert.deepEqual((await ok('/api/admin/conversations?filter=pinned','GET',undefined,owner)).items,[]);assert.deepEqual((await ok('/api/admin/conversations?filter=archived','GET',undefined,owner)).items.map(row=>row.id),[id]);
  const privateView=await ok('/api/chat','GET',undefined,cookie);for(const field of ['notes','labels','mode','token_hash','pinned','archived'])assert.equal(field in privateView,false,field+' is private owner metadata');assert.ok(Number.isSafeInteger(privateView.inboxRevision));assert.equal(privateView.blocked,true);
  assert.equal((await call('/api/admin/conversations/'+id+'/settings','PATCH',{blocked:false},cookie)).status,401);
  console.log('Bounded history/inbox runtime checks passed: latest 80 and older pages, 120-row revision deltas, old edits/tombstones/private stars/reactions/receipts, exact saved clientId retry outside the recent page, legacy compatibility, 553-customer keyset navigation, indexed prefix search and bound cursors, private owner filters/settings/auth.');
}finally{await mf.dispose();}
