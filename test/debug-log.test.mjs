import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {loggedProvider,formatDebugLog} from '../src/debug-log.mjs';
import {createProvider} from '../src/provider.mjs';
import {DEFAULT_SETTINGS} from '../src/settings.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-debug-'));
  const store=new Store(directory);await store.init();
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const context={storyId:'story',branchId:'branch',turnId:'turn',stage:'Ada is responding'};
  return {store,context,wrap:provider=>loggedProvider(provider,{store,settings:DEFAULT_SETTINGS,getContext:()=>context})};
}

test('logs retain exact model prompts/replies and persist independently of discarded story work',async t=>{
  const f=await fixture(t),reply='```json\n{"text":"", "privateState":"Choosing silence"}\n```';
  const provider=f.wrap({complete:async()=>reply});
  const messages=[{role:'system',content:'Private roleplay rules'},{role:'user',content:'Private character context\nincluding thoughts'}];
  assert.equal(await provider.complete({model:'helper-choice',messages,headers:{Authorization:'DO-NOT-LOG'}}),reply);
  const records=await f.store.debugRecords('story');
  assert.equal(records.length,2);assert.deepEqual(records[0].request,{model:'helper-choice',messages});
  assert.equal(records[1].response,reply);assert.equal(records[0].requestId,records[1].requestId);
  assert.equal(records[0].stage,'Ada is responding');assert.equal(records[1].branchId,'branch');
  const log=formatDebugLog(records,{storyId:'story',title:'Test'});
  assert.ok(log.includes(reply));assert.ok(log.includes('Private character context'));
  assert.ok(!log.includes('DO-NOT-LOG'));
});

test('empty provider responses and cancellation errors keep diagnostic responses without retry',async t=>{
  const f=await fixture(t);let calls=0;
  const raw={choices:[{message:{content:''},finish_reason:'stop'}]};
  const actual=createProvider(DEFAULT_SETTINGS,async()=>{calls++;return new Response(JSON.stringify(raw));});
  await assert.rejects(f.wrap(actual).complete({messages:[{role:'user',content:'Test'}]}),/no usable/);
  const cancelled=f.wrap({complete:async()=>{throw new DOMException('Stopped by user','AbortError');}});
  await assert.rejects(cancelled.complete({messages:[]}),{name:'AbortError'});
  const records=await f.store.debugRecords('story');
  assert.equal(calls,1);assert.deepEqual(records[1].error.response,raw);
  assert.equal(records[3].error.name,'AbortError');assert.equal(records[3].kind,'error');
});

test('image prompts stay complete while inline/reference/output bytes become image metadata',async t=>{
  const f=await fixture(t),bytes=Buffer.from('private image bytes');
  const provider=f.wrap({complete:async()=>'{"generate":true}',image:async()=>({bytes,type:'image/png'})});
  const messages=[{role:'user',content:[{type:'text',text:'Keep this exact image prompt.'},{type:'image_url',image_url:{url:`data:image/png;base64,${bytes.toString('base64')}`}}]}];
  await provider.complete({messages});
  await provider.image({prompt:'Render this exact prompt.',references:[{bytes,type:'image/png'}]});
  const records=await f.store.debugRecords('story');
  assert.equal(records[0].request.messages[0].content[0].text,'Keep this exact image prompt.');
  const inline=records[0].request.messages[0].content[1].image_url.url.inlineImage;
  assert.equal(inline.bytes,bytes.length);assert.equal(inline.sha256.length,64);
  assert.equal(records[2].request.prompt,'Render this exact prompt.');
  assert.deepEqual(records[2].request.referenceImages[0],records[3].response.image);
  assert.ok(!JSON.stringify(records).includes(bytes.toString('base64')));
});

test('deleting a story removes its trace and late model completions cannot recreate it',async t=>{
  const f=await fixture(t);
  await f.store.put({id:'story'});
  await f.store.appendDebug('story',{kind:'request'});
  await f.store.remove('story');
  await f.store.appendDebug('story',{kind:'response',response:'Too late'});
  await assert.rejects(access(f.store.debugFilename('story')),{code:'ENOENT'});
  assert.deepEqual(await f.store.debugRecords('story'),[]);
});
