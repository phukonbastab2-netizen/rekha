import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerRoutes} from '../cloudflare/owner.mjs';

test('an R2 upload and delete failure still releases its reserved library row',async()=>{
  const bytes=new Uint8Array(12);bytes.set([255,216,255]);
  const calls=[],request=new Request('https://example.test/api/admin/uploads?title=Payment%20QR',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:bytes});
  const ctx={request,route:'/api/admin/uploads',method:'POST',env:{
    DB:{},MEDIA:{put:async()=>{throw Error('Storage is temporarily unavailable');},delete:async()=>{calls.push('delete-object');throw Error('Cleanup unavailable');}},
  },stmt:(sql,...args)=>({run:async()=>{calls.push(sql.startsWith('INSERT')?'reserve-row':'release-row');assert.ok(args.length);return{meta:{changes:1}};}}),
    fail:(status,message)=>Object.assign(Error(message),{status}),one:async()=>null};
  await assert.rejects(ownerRoutes(ctx),error=>error.status===503&&error.message==='Media upload failed: Storage is temporarily unavailable');
  assert.deepEqual(calls,['reserve-row','delete-object','release-row']);
});
