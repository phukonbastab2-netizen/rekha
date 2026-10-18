import test from 'node:test';import assert from 'node:assert/strict';
import {canAttachMedia,createAttachmentQueue} from './attachment-queue.mjs';
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('attachment recovery is bounded and deduplicated while two downloads are active',async()=>{
 const releases=[],started=[];
 const queue=createAttachmentQueue({maxPending:2,run:async(value,key)=>{started.push(key);await new Promise(resolve=>releases.push(resolve));}});
 assert.equal(queue.offer({},'a'),true);assert.equal(queue.offer({},'a'),false);queue.offer({},'b');queue.offer({},'c');queue.offer({},'d');assert.equal(queue.offer({},'e'),false);
 await settle();assert.equal(queue.active,2);assert.equal(queue.pending,2);assert.deepEqual(started,['a','b']);
 releases[0]();await settle();assert.deepEqual(started,['a','b','c']);queue.close();for(const release of releases)release();await settle();assert.equal(queue.pending,0);
});
test('revoked and superseded files cannot be attached after an asynchronous download',()=>{
 const original={kind:'message',peer:'customer',editedAt:1};
 assert.equal(canAttachMedia({...original},original),true);
 for(const change of [{revoked:true},{sensitive:true},{kind:'deleted'},{editedAt:2},{peer:'other'}])assert.equal(canAttachMedia({...original,...change},original),false);
});
test('queued attachments are checked again before download and errors do not stop later jobs',async()=>{
 const eligible=new Set(['a','b','c']),started=[];let release;
 const queue=createAttachmentQueue({concurrency:1,eligible:key=>eligible.has(key),run:async(value,key)=>{started.push(key);if(key==='a')await new Promise(resolve=>release=resolve);else throw Error('unavailable');}});
 queue.offer({},'a');queue.offer({},'b');queue.offer({},'c');await settle();eligible.delete('b');release();await settle();await settle();assert.deepEqual(started,['a','c']);assert.equal(queue.active,0);queue.close();
});
