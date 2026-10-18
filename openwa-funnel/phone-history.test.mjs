import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {createPhoneHistory,requestNativeChatHistory} from './phone-history.mjs';
const peer='919876543210@c.us';
test('history refresh uses only an existing eligible chat and honours provider disable state',async()=>{
 let calls=0;const chat={id:{_serialized:peer},endOfHistoryTransferType:0},utils={historySyncOnDemandRequestsFailureRecord:{disableRequestSending:false}},context={require:name=>({'WAWebCollections':{Chat:{get:()=>chat}},'WAWebWidFactory':{createWid:v=>v},'WAWebNonMessageDataRequestHistorySyncOnDemandUtils':utils,'WAWebSendNonMessageDataRequest':{sendPeerDataOperationRequest:async(type,value)=>{calls++;assert.equal(type,3);assert.equal(value.chatId,chat.id);}}}[name])};
 const request=vm.runInNewContext('('+requestNativeChatHistory.toString()+')',context);
 assert.equal((await request({peer})).requested,true);assert.equal(calls,1);
 utils.historySyncOnDemandRequestsFailureRecord.disableRequestSending=true;assert.equal((await request({peer})).requested,false);assert.equal(calls,1);
 utils.historySyncOnDemandRequestsFailureRecord.disableRequestSending=false;chat.endOfHistoryTransferType=1;assert.equal((await request({peer})).requested,false);assert.equal(calls,1);
});
test('owner history request cooldown survives requester recreation and failures do not retry',async()=>{
 let at=1000000,calls=0;const values=new Map(),options={evaluate:async()=>{calls++;throw Error('provider failed');},get:key=>values.get(key),put:v=>values.set(v.key,v),now:()=>at};
 let requester=createPhoneHistory(options);assert.equal((await requester.request(peer)).requested,false);
 requester=createPhoneHistory(options);await requester.request(peer);assert.equal(calls,1);
 at+=600001;await requester.request(peer);assert.equal(calls,2);
});
