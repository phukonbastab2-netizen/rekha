import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeCloudPayload } from './transport.mjs';
import { firstSequence, reminder, mediaSequence, GAP, MEDIA_DELAY } from './funnel.mjs';
import qr from './qr-data.mjs';

test('all original funnel steps fit Cloud API payload limits without truncation',()=>{
  assert.equal(firstSequence.length,5);
  assert.equal(mediaSequence.length,4);
  assert.equal(GAP,5000);
  assert.equal(MEDIA_DELAY,3600000);
  for(const step of [...firstSequence,reminder,...mediaSequence]){
    const payload=makeCloudPayload('919000000000',step);
    assert.equal(payload.type,step.type);
    if(step.type==='text') assert.equal(payload.text.body,step.body);
    else if(step.body) assert.equal(payload[step.type].caption,step.body);
  }
});
test('separate QR asset exactly matches its committed source image',()=>{
  const bytes=fs.readFileSync(new URL('./assets/qr-shahrukh-20261018.png',import.meta.url));
  assert.deepEqual(Buffer.from(qr,'base64'),bytes);
  assert.match(firstSequence[3].url,/rekha-whatsapp-cloud-api\.phukonbastab2\.workers\.dev/);
});
test('committed deployment cannot accidentally enable production sends',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.vars.SEND_ENABLED,'false');
  assert.equal(config.vars.READ_ENABLED,'false');
  assert.equal(config.vars.WA_PHONE_NUMBER_ID,'');
  assert.equal(config.vars.SEND_EPOCH,'setup-disabled');
  assert.deepEqual(config.durable_objects.bindings.map(b=>b.name),['CONVERSATIONS','CONTROL']);
});
