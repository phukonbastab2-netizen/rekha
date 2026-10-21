import {test} from 'node:test';
import assert from 'node:assert/strict';
import entry,{FunnelConversation} from './inbox-entry.mjs';
const id='a'.repeat(64),phone='1418201524705343';
test('owner inbox export only reads storage and preserves the exact original jobs',async()=>{
 const jobs=[{id:'first:0',state:'accepted',messageId:'wamid.existing',step:{type:'text',body:'Original text'}}];let writes=0;
 const storage={get:async()=>({phoneNumberId:phone,waId:'919999007353',jobs,lastInboundAt:123}),list:async()=>new Map([['inbound:x',{type:'text',text:'Hi'}]]),put:async()=>{writes++;throw Error('must not write');},setAlarm:async()=>{writes++;throw Error('must not schedule');}};
 const object=new FunnelConversation({storage},{WA_PHONE_NUMBER_ID:phone});const response=await object.fetch(new Request('https://local/owner-inbox-read'));const body=await response.json();
 assert.equal(response.status,200);assert.deepEqual(body.jobs,jobs);assert.equal(body.records.length,1);assert.equal(writes,0);
});
test('source endpoints require existing owner bearer token and reject malformed cursors',async()=>{
 const env={ADMIN_TOKEN:'owner'};assert.equal((await entry.fetch(new Request('https://worker/admin/inbox-index'),env)).status,401);
 const request=path=>new Request('https://worker'+path,{headers:{Authorization:'Bearer owner'}});
 assert.equal((await entry.fetch(request('/admin/inbox-sync?id=bad'),env)).status,400);
 assert.equal((await entry.fetch(request('/admin/inbox-sync?id='+id+'&after=state'),env)).status,400);
});
test('source index reports the existing account without writing or changing sending settings',async()=>{
 const env={WA_PHONE_NUMBER_ID:phone,ADMIN_TOKEN:'owner',TEST_CONVERSATION_ID:id,SEND_ENABLED:'true',CONTROL:{idFromName:name=>name,get:()=>({fetch:async()=>Response.json({paused:false,ingestion:{recentConversationIds:[id]}})})}};
 const before=structuredClone({test:env.TEST_CONVERSATION_ID,enabled:env.SEND_ENABLED});const response=await entry.fetch(new Request('https://worker/admin/inbox-index',{headers:{Authorization:'Bearer owner'}}),env);const body=await response.json();
 assert.equal(body.ownerTestOnly,true);assert.equal(body.testConversationId,id);assert.equal(body.account.paused,false);assert.deepEqual({test:env.TEST_CONVERSATION_ID,enabled:env.SEND_ENABLED},before);
});
