import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/provider.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

test('subscription transport sends selected model and does not attach platform API credentials',async()=>{
  const calls=[];const provider=createProvider(DEFAULT_SETTINGS,async(url,options)=>{calls.push({url,options});return Response.json({choices:[{message:{content:'{"text":"Hello"}'},finish_reason:'stop'}]});});
  assert.equal(await provider.complete({model:'selected-model',messages:[{role:'user',content:'Hello'}]}),'{"text":"Hello"}');
  assert.equal(calls[0].url,'http://127.0.0.1:10531/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].options.body).model,'selected-model');assert.equal(calls[0].options.headers.authorization,undefined);assert.equal(calls.length,1);
});
test('quota errors and refusals are surfaced once, without provider fallback',async()=>{
  let count=0;const provider=createProvider(DEFAULT_SETTINGS,async()=>{count++;return Response.json({error:{message:'Subscription quota reached'}},{status:429});});
  await assert.rejects(()=>provider.complete({messages:[]}),error=>error.code==='USAGE_LIMIT');assert.equal(count,1);
  const refusal=createProvider(DEFAULT_SETTINGS,async()=>Response.json({choices:[{message:{refusal:'Declined'}}]}));await assert.rejects(()=>refusal.complete({messages:[]}),error=>error.code==='MODEL_REFUSAL');
});
test('reference-based images use multipart edits with actual bytes',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPz0AAAAASUVORK5CYII=','base64');
  const calls=[];const provider=createProvider(DEFAULT_SETTINGS,async(url,options)=>{calls.push({url,options});return Response.json({data:[{b64_json:png.toString('base64')}]});});
  const result=await provider.image({prompt:'Continue this character.',references:[{bytes:png}]});assert.deepEqual(result.bytes,png);
  assert.match(calls[0].url,/\/images\/edits$/);assert.ok(calls[0].options.body instanceof FormData);assert.equal(calls[0].options.body.getAll('image[]').length,1);
  assert.equal(calls[0].options.body.get('model'),'gpt-image-2');
});
test('external proxy URLs and invalid image bytes are rejected',async()=>{
  assert.throws(()=>createProvider({...DEFAULT_SETTINGS,proxyBaseUrl:'https://api.openai.com/v1'}),/loopback/);
  const provider=createProvider(DEFAULT_SETTINGS,async()=>Response.json({data:[{b64_json:Buffer.from('This is not an image file.').toString('base64')}]}));
  await assert.rejects(()=>provider.image({prompt:'A fire.'}),/unsupported image format/);
});
