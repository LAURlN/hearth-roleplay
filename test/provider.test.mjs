import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

test('illustrator vision bypasses the chat bridge that rejects inline data URLs',async t=>{
  const calls=[];
  const proxy=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());calls.push({path:req.url,body});
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/chat/completions') {
      res.writeHead(500);res.end(JSON.stringify({error:{message:'URL scheme must be http or https, got data:'}}));return;
    }
    if(req.url==='/v1/responses') {
      res.end(JSON.stringify({status:'completed',output:[{type:'reasoning',summary:[{text:'Not an answer'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:'{"generate":true,"prompt":"Keep the same character."}'}]}]}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>proxy.close(resolve)));
  const provider=createProvider({...DEFAULT_SETTINGS,proxyBaseUrl:`http://127.0.0.1:${proxy.address().port}/v1`});
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const text=await provider.complete({model:'selected-model',messages:[{role:'system',content:'Keep character consistency.'},{role:'user',content:[{type:'text',text:'Review the previous illustration.'},{type:'image_url',image_url:{url:image}}]}]});
  assert.equal(text,'{"generate":true,"prompt":"Keep the same character."}');
  assert.deepEqual(calls.map(call=>call.path),['/v1/responses']);
  const body=calls[0].body;assert.equal(body.model,'selected-model');assert.equal(body.instructions,'Keep character consistency.');assert.equal(body.store,false);assert.equal(body.stream,false);
  assert.deepEqual(body.input[0].content,[{type:'input_text',text:'Review the previous illustration.'},{type:'input_image',image_url:image}]);
  assert.equal(body.previous_response_id,undefined);
});

test('native visual refusals and failures stop once without retrying through chat',async()=>{
  const messages=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,eA=='}}]}];
  for(const [result,expected] of [
    [{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'Declined.'}]}]},/declined/],
    [{status:'failed',error:{message:'Subscription capacity reached.'}},/Subscription capacity/],
    [{status:'incomplete',output:[{type:'message',content:[{type:'output_text',text:'partial'}]}]},/incomplete/],
    [{status:'completed',output:[{type:'reasoning',summary:[{text:'not the answer'}]}]},/no usable/],
  ]) {
    const calls=[];const provider=createProvider(DEFAULT_SETTINGS,async(url)=>{calls.push(url);return Response.json(result);});
    await assert.rejects(()=>provider.complete({messages}),expected);assert.equal(calls.length,1);assert.match(calls[0],/\/responses$/);
  }
});

test('visual history preserves assistant text, image details, and the caller cancellation signal',async()=>{
  const controller=new AbortController();let request;
  const provider=createProvider(DEFAULT_SETTINGS,async(url,options)=>{request={url,options};assert.ok(!options.signal.aborted);controller.abort();assert.ok(options.signal.aborted);return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'The same red scarf.'}]}]});});
  const result=await provider.complete({signal:controller.signal,messages:[{role:'system',content:'Illustrate carefully.'},{role:'assistant',content:'Earlier illustration notes.'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,eA==',detail:'low'}},{type:'text',text:'Keep this face.'}]}]});
  const body=JSON.parse(request.options.body);assert.equal(body.input[0].content[0].type,'output_text');assert.equal(body.input[1].content[0].detail,'low');assert.equal(result,'The same red scarf.');
});
