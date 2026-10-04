import test from 'node:test';
import assert from 'node:assert/strict';
import {messageBody,safeBoldText} from '../public/media.js';
import {KUNDLI_FOLLOWUP_LINES} from '../cloudflare/kundli-followup.mjs';
const escaped=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

test('all supplied follow-up words remain unchanged while balanced double stars render bold',()=>{
  assert.equal(KUNDLI_FOLLOWUP_LINES.length,30);
  for(const body of KUNDLI_FOLLOWUP_LINES){
    const result=messageBody({kind:'kundli-review-line',body});
    assert.equal(result.replaceAll('<strong>','').replaceAll('</strong>',''),escaped(body.replace(/\*\*([\s\S]+?)\*\*/g,'$1')));
    assert.equal(result.match(/<strong>/g)?.length||0,body.match(/\*\*([\s\S]+?)\*\*/g)?.length||0);
  }
});

test('owner edits and unsafe HTML inside or outside emphasis cannot create executable markup',()=>{
  const body='नाम **<img src=x onerror="window.hacked=1">** & <script>alert(1)</script> [link](javascript:alert(1))';
  const result=messageBody({role:'assistant',kind:'kundli-review-line',body,edited:123});
  assert.match(result,/<strong>&lt;img src=x onerror=&quot;window.hacked=1&quot;&gt;<\/strong>/);
  assert.match(result,/&amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(result,/<(?:img|script|a)\b|<[^/s]|href=|<strong[^>]+>/);
  assert.equal(safeBoldText('शब्द **अधूरे'), 'शब्द **अधूरे');
  assert.equal(safeBoldText('**पहला** और **दूसरा**'),'<strong>पहला</strong> और <strong>दूसरा</strong>');
});

test('emphasis is limited to follow-up kind and deleted bodies do not reappear',()=>{
  assert.equal(messageBody({kind:'owner-message',body:'**Original words** <img>'}),'**Original words** &lt;img&gt;');
  assert.equal(messageBody({kind:'kundli-review-line',body:'**hidden**',deleted:true}),'<span class="deleted-message">This message was deleted</span>');
});
