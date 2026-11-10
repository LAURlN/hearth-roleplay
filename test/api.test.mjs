import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPz0AAAAASUVORK5CYII=','base64');
const setup={title:'The Lantern',premise:'A quiet inn on a rainy night.',persona:{name:'Rowan',description:'A traveller.'},characters:[{name:'Ada',appearance:'Red scarf',description:'An innkeeper.'}]};
function fakeProvider() {
  const fake={calls:[],imageCalls:[],fail:false,hold:false,entered:null,release:null};
  fake.provider={models:async()=>[{id:'gpt-6.1-sol',name:'Sol'}],complete:async request=>{
    fake.calls.push(request);
    if(fake.fail) throw new Error('Scripted provider failure');
    const system=request.messages[0].content;
    const raw=request.messages[1].content;
    const payload=JSON.parse(Array.isArray(raw)?raw[0].text:raw);
    if(system.includes('private input interpreter')) {
      if(fake.hold) {
        fake.entered?.();
        await new Promise((resolve,reject)=>{fake.release=resolve;request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});
      }
      return JSON.stringify({segments:[{kind:'speech',text:payload.input}],allowMajorTimeSkip:false});
    }
    if(system.includes('omniscient narrator/planner')) {
      const opening=payload.world.location==='Opening location';
      return JSON.stringify({events:opening?[{type:'establish',location:'The inn',label:'Evening',text:'A fire warms the inn.'}]:[],text:'Rain taps against the windows.',speakers:payload.world.characters.filter(c=>c.id!=='player').slice(0,1).map(c=>c.id)});
    }
    if(system.includes('play ONLY')) return JSON.stringify({text:'Welcome. Sit by the fire.',privateState:'I am curious about this traveller.',movement:null,channel:'local'});
    if(system.includes('A human has authored an edited')) return JSON.stringify({events:[{type:'observation',text:payload.message.text,location:payload.world.location}],allowMajorTimeSkip:false});
    if(system.includes('You are the illustrator')) return JSON.stringify({generate:true,prompt:'Draw the inn and the traveller beside the fire.',caption:'The inn at dusk',characterIds:payload.characters.map(c=>c.id),referenceIds:[],appearanceNotes:'Ada wears a red scarf.'});
    if(system.includes('brief player-visible pause')) return JSON.stringify({text:'The fire settles.'});
    throw new Error('Unexpected scripted request: '+system.slice(-1000));
  },image:async request=>{fake.imageCalls.push(request);if(fake.imageGate){fake.imageEntered?.();await fake.imageGate;}return {bytes:png,type:'image/png',extension:'png'};}};
  return fake;
}
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-api-'));
  const fake=fakeProvider();
  const app=await createApp({dataDir:directory,makeProvider:()=>fake.provider});
  await app.store.saveSettings({autoIllustrate:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function request(url,method='GET',body,headers={}) {
    const response=await fetch(base+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();return {status:response.status,body:result,response};
  }
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  return {...app,fake,request,base,directory};
}
const route=story=>`/api/stories/${story.id}`;
async function until(operation,predicate) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){const value=await operation();if(predicate(value))return value;if(value?.illustrationJob?.status==='failed')throw new Error('Background image failed: '+value.illustrationJob.error);await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Background job did not settle.');
}

test('HTTP bootstrap, static assets, local origin guard, and settings validation',async t=>{
  const f=await fixture(t);
  const boot=await f.request('/api/bootstrap');assert.equal(boot.status,200);assert.deepEqual(boot.body.stories,[]);assert.equal(boot.body.settings.chatModel,'gpt-6.1-sol');
  const html=await fetch(f.base);assert.equal(html.status,200);assert.match(await html.text(),/Hearth/);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await f.request('/api/settings','PUT',{maxResponders:0})).status,400);
  assert.equal((await f.request('/api/settings','PUT',{proxyBaseUrl:'https://api.openai.com/v1'})).status,400);
  assert.equal((await f.request('/api/settings','PUT',{autoIllustrate:true},{origin:'https://evil.example'})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{const req=http.get(f.base+'/api/bootstrap',{headers:{host:'evil.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
  assert.equal(foreignHost,403);
  assert.equal((await f.request('/api/models')).body.connected,true);
  assert.equal((await fetch(f.base+'/../src/settings.mjs')).status,404);
});

test('complete story turn is durable and exposes no internal snapshots to the UI',async t=>{
  const f=await fixture(t),created=await f.request('/api/stories','POST',setup),story=created.body;
  assert.equal(created.status,201);assert.ok(story.branch.messages.length>=2);assert.equal(story.world.location,'The inn');assert.equal(story.version,1);
  assert.ok(story.branch.messages.every(message=>!Object.hasOwn(message,'snapshot')));
  const advanced=(await f.request(route(story)+'/turn','POST',{text:'I order tea.',expectedVersion:story.version})).body;
  assert.equal(advanced.version,2);assert.ok(advanced.branch.messages.some(m=>m.text==='I order tea.'));
  const saved=await f.store.get(story.id);assert.ok(saved.branches[saved.activeBranchId].messages.at(-1).snapshot);
  assert.ok(advanced.world.characters.find(c=>c.name==='Ada').knowledge.some(k=>k.text==='I order tea.'));
  assert.equal((await f.request(route(story)+'/turn','POST',{text:'stale request',expectedVersion:story.version})).status,409);
});

test('edit, delete, rewind, and switching preserve original futures and restore knowledge',async t=>{
  const f=await fixture(t);let story=(await f.request('/api/stories','POST',setup)).body;
  story=(await f.request(route(story)+'/turn','POST',{text:'The password is amber.',expectedVersion:story.version})).body;
  const original=structuredClone(story),target=story.branch.messages.find(m=>m.role==='player');
  const revised=(await f.request(route(story)+'/branch','POST',{mode:'edit',messageId:target.id,text:'The password is silver.',expectedVersion:story.version})).body;
  assert.equal(revised.branches.length,2);assert.notEqual(revised.activeBranchId,original.activeBranchId);
  assert.ok(JSON.stringify(revised.world).includes('silver'));assert.ok(!JSON.stringify(revised.world).includes('amber'));
  let selected=(await f.request(route(story)+'/switch','POST',{branchId:original.activeBranchId,expectedVersion:revised.version})).body;
  assert.deepEqual(selected.branch.messages,original.branch.messages);assert.ok(JSON.stringify(selected.world).includes('amber'));
  const deleted=(await f.request(route(story)+'/branch','POST',{mode:'delete',messageId:target.id,expectedVersion:selected.version})).body;
  assert.ok(!JSON.stringify(deleted.world).includes('amber'));assert.ok(!deleted.branch.messages.some(m=>m.id===target.id));
  selected=(await f.request(route(story)+'/switch','POST',{branchId:original.activeBranchId,expectedVersion:deleted.version})).body;
  const rewound=(await f.request(route(story)+'/branch','POST',{mode:'rewind',messageId:original.branch.messages[0].id,expectedVersion:selected.version})).body;
  assert.equal(rewound.branch.messages.length,1);assert.ok(!JSON.stringify(rewound.world).includes('amber'));assert.equal(rewound.branches.length,4);
});

test('failed generation is atomic and a failed opening leaves the authored setup recoverable',async t=>{
  const f=await fixture(t);const story=(await f.request('/api/stories','POST',setup)).body;
  f.fake.fail=true;
  assert.equal((await f.request(route(story)+'/turn','POST',{text:'A failed turn',expectedVersion:story.version})).status,500);
  const unchanged=(await f.request(route(story))).body;assert.deepEqual(unchanged.branch,story.branch);assert.equal(unchanged.version,story.version);
  const failed=await f.request('/api/stories','POST',{...setup,title:'Recover me'});assert.equal(failed.status,500);assert.ok(failed.body.storyId);
  const recovered=(await f.request(`/api/stories/${failed.body.storyId}`)).body;assert.equal(recovered.setup.title,'Recover me');assert.equal(recovered.branch.messages.length,0);
});

test('cancellation rejects concurrent turns and leaves no partial player text or knowledge',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  let entered;const started=new Promise(resolve=>{entered=resolve;});f.fake.hold=true;f.fake.entered=entered;
  const pending=f.request(route(story)+'/turn','POST',{text:'Never committed.',expectedVersion:story.version});await started;
  const running=(await f.request(route(story))).body;assert.equal(running.busy,true);assert.match(running.stage,/Interpreting/);
  assert.equal((await f.request(route(story)+'/continue','POST',{expectedVersion:story.version})).status,409);
  assert.equal((await f.request(route(story)+'/cancel','POST',{})).body.cancelled,true);
  assert.equal((await pending).status,409);
  const final=(await f.request(route(story))).body;assert.equal(final.busy,false);assert.deepEqual(final.branch,story.branch);
});

test('illustrations use actual prior images and portable exports restore them with branches',async t=>{
  const f=await fixture(t);const story=(await f.request('/api/stories','POST',setup)).body;
  await f.request(route(story)+'/illustrate','POST',{expectedVersion:story.version});
  const first=await until(()=>f.service.view(story.id),s=>s.illustrationJob.status==='completed');
  assert.equal(first.branch.illustrations.length,1);assert.equal(f.fake.imageCalls[0].references.length,0);
  const bytes=await fetch(f.base+first.branch.illustrations[0].url);assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),png);
  await f.request(route(story)+'/illustrate','POST',{expectedVersion:first.version});
  const second=await until(()=>f.service.view(story.id),s=>s.branch.illustrations.length===2);
  assert.equal(f.fake.imageCalls[1].references.length,1);assert.deepEqual(f.fake.imageCalls[1].references[0].bytes,png);
  const visual=f.fake.calls.filter(r=>r.messages[0].content.includes('You are the illustrator')).at(-1);assert.ok(visual.messages[1].content.some(part=>part.type==='image_url'));
  const backup=(await f.request(route(story)+'/export')).body;assert.equal(backup.format,'hearth-story');assert.equal(Object.keys(backup.images).length,2);
  const imported=await f.request('/api/import','POST',backup);assert.equal(imported.status,201);assert.notEqual(imported.body.id,story.id);assert.equal(imported.body.branch.illustrations.length,2);
  const restored=await fetch(f.base+imported.body.branch.illustrations[0].url);assert.deepEqual(Buffer.from(await restored.arrayBuffer()),png);
  assert.notEqual(imported.body.branch.illustrations[0].url,second.branch.illustrations[0].url);
});

test('a late image result cannot attach to a rewound branch',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  let release,entered;f.fake.imageGate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{entered=resolve;});f.fake.imageEntered=entered;
  await f.request(route(story)+'/illustrate','POST',{expectedVersion:story.version});await ready;
  const rewound=(await f.request(route(story)+'/branch','POST',{mode:'rewind',expectedVersion:story.version})).body;
  release();await until(()=>Promise.resolve(f.service.illustrator.jobs.size),size=>size===0);
  const final=await f.service.view(story.id);assert.equal(final.activeBranchId,rewound.activeBranchId);assert.equal(final.branch.illustrations.length,0);assert.equal(final.branch.messages.length,0);
});

test('malformed imports and revisions never replace existing saved stories',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  const backup=(await f.request(route(story)+'/export')).body;backup.story.branches[backup.story.activeBranchId].messages[0].snapshot.characters=[];
  assert.equal((await f.request('/api/import','POST',backup)).status,400);
  assert.equal((await f.request(route(story)+'/branch','POST',{mode:'delete',messageId:'does-not-exist',expectedVersion:story.version})).status,404);
  assert.equal((await f.request('/api/stories')).body.length,1);
  assert.deepEqual((await f.request(route(story))).body.branch,story.branch);
});

test('a restart marks orphaned persisted image work as interrupted instead of polling forever',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  await f.store.mutate(story.id,undefined,s=>{s.illustrationJob={id:'interrupted',branchId:s.activeBranchId,status:'generating'};},{bump:false});
  const restarted=await createApp({dataDir:f.directory,makeProvider:()=>f.fake.provider});
  const recovered=await restarted.service.view(story.id);assert.equal(recovered.illustrationJob.status,'failed');assert.match(recovered.illustrationJob.error,/stopped/);assert.equal(recovered.version,story.version);
  await restarted.close();
});
