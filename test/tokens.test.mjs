import test from 'node:test';
import assert from 'node:assert/strict';
import {countText,countMessages} from '../src/tokens.mjs';

test('text counts use real o200k BPE, including ordinary literal special-token spellings',()=>{
  assert.equal(countText(''),0);assert.equal(countText('hello'),1);assert.equal(countText('Hello, world!'),4);
  assert.equal(countText('<|endoftext|>'),7);
  const unicode='漢字🙂'.repeat(8);
  assert.ok(countText(unicode)>Math.ceil(unicode.length/4));
  assert.equal(countText(unicode),countText(unicode));
});

test('message estimates include role and content text, message framing and named-message overhead',()=>{
  assert.deepEqual(countMessages([{role:'user',content:'hello'}]),{tokens:8,encoding:'o200k_base',approximate:true});
  assert.equal(countMessages([{role:'user',name:'Pat',content:'hello'}]).tokens,10);
  const messages=[{role:'system',content:'Keep secrets.'},{role:'user',content:'A mixed-language request: 你好.'}];
  const expected=3+messages.reduce((sum,message)=>sum+3+countText(message.role)+countText(message.content),0);
  assert.equal(countMessages(messages).tokens,expected);
});

test('proxy model aliases remain explicitly approximate and serialized request fields are counted',()=>{
  const messages=[{role:'user',content:'hello',metadata:{purpose:'debug'}}];
  assert.deepEqual(countMessages(messages,'unknown-proxy-alias'),countMessages(messages,'gpt-6.1-sol'));
  assert.equal(countMessages(messages).tokens,8+countText(JSON.stringify(messages[0].metadata)));
  assert.throws(()=>countText(null),/requires text/);assert.throws(()=>countMessages(null),/requires messages/);
});
