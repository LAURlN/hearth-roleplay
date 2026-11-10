import {semanticReply} from './helpers/semantic-fixture.mjs';
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
    const system=request.messages[0].content;
    if(fake.fail&&(!fake.failStage||system.includes(fake.failStage))) throw new Error('Scripted provider failure');
    if(semanticReply(request)!==null)return semanticReply(request);
    if(system.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    if(system.includes('PLAYER PLACEMENT RESOLVER'))return '{"correction":null,"placements":[]}';
    const raw=request.messages[1].content;
    const payload=JSON.parse(Array.isArray(raw)?raw[0].text:raw);
    if(system.includes('private input interpreter')) {
      if(fake.hold) {
        fake.entered?.();
        await new Promise((resolve,reject)=>{fake.release=resolve;request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});
      }
      return JSON.stringify({segments:[{kind:'speech',text:payload.input,recipients:[]}],allowMajorTimeSkip:false});
    }
    if(system.includes('omniscient narrator/planner')) {
      const opening=payload.world.location==='Opening location';
      return JSON.stringify({events:opening?[{type:'establish',location:'The inn',label:'Evening',text:'A fire warms the inn.'}]:[],text:fake.narration??'Rain taps against the windows.',speakers:payload.world.characters.filter(c=>c.id!=='player').slice(0,1).map(c=>c.id)});
    }
    if(system.includes('play ONLY')) return JSON.stringify({text:'Welcome. Sit by the fire.',privateState:'I am curious about this traveller.',movement:null,channel:'local',recipients:[]});
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
  assert.equal(created.status,201,JSON.stringify(story));assert.ok(story.branch.messages.length>=2);assert.equal(story.world.location,'The inn');assert.equal(story.version,1);
  assert.ok(story.branch.messages.some(m=>m.role==='character'&&m.text==='Welcome. Sit by the fire.'));
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

test('downloadable AI logs cover requests, failed revisions, and survive rollback without entering story exports',async t=>{
  const f=await fixture(t);let story=(await f.request('/api/stories','POST',setup)).body;
  story=(await f.request(route(story)+'/turn','POST',{text:'A debugging question.',expectedVersion:story.version})).body;
  const originalBranch=story.activeBranchId;
  const target=story.branch.messages.find(m=>m.role==='player');
  f.fake.fail=true;f.fake.failStage='private input interpreter';
  assert.equal((await f.request(route(story)+'/branch','POST',{mode:'edit',messageId:target.id,text:'A failed edited question.',expectedVersion:story.version})).status,500);
  const response=await fetch(f.base+route(story)+'/debug');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/plain/);assert.equal(response.headers.get('cache-control'),'no-store');
  const log=await response.text();
  assert.match(log,/A failed edited question/);assert.match(log,/Scripted provider failure/);assert.match(log,/Ada is responding/);
  assert.match(log,/Welcome\. Sit by the fire/);
  const records=await f.store.debugRecords(story.id),last=records.at(-1);
  assert.notEqual(last.branchId,originalBranch);assert.equal(last.parentBranchId,originalBranch);
  assert.equal((await f.service.view(story.id)).activeBranchId,originalBranch);
  const backup=(await f.request(route(story)+'/export')).body;
  assert.ok(!JSON.stringify(backup).includes('A failed edited question.'));
  await f.request(route(story),'DELETE');
  assert.equal((await fetch(f.base+route(story)+'/debug')).status,404);
  assert.deepEqual(await f.store.debugRecords(story.id),[]);
});

test('post-response helper validation failures are logged with terminal turn metadata despite rollback',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  await f.store.mutate(story.id,undefined,s=>{
    const world=s.branches[s.activeBranchId].messages.at(-1).snapshot;
    world.characters.find(c=>c.name==='Ada').knowledge=Array.from({length:180},(_,i)=>({id:`observation-${i}`,text:`Observation ${i}`,source:'perception',time:0}));
  },{bump:false});
  const original=await f.store.get(story.id);
  f.fake.provider.complete=async()=>'{"summary":""}';
  const failed=await f.request(route(story)+'/turn','POST',{text:'This must not be committed.',expectedVersion:story.version});
  assert.equal(failed.status,500);assert.match(failed.body.error,/memory summary was invalid/);
  assert.deepEqual(await f.store.get(story.id),original);
  const records=await f.store.debugRecords(story.id),last=records.at(-1);
  assert.equal(last.kind,'operation error');assert.match(last.error.message,/memory summary was invalid/);
  assert.equal(last.branchId,story.activeBranchId);assert.equal(last.stage,"Organising Ada's memories");
  assert.equal(last.turnId,records.at(-2).turnId);assert.equal(records.at(-2).response,'{"summary":""}');
});

test('invalid illustrator decisions retain the raw reply and a terminal illustration error',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  f.fake.provider.complete=async()=>'{"generate":"not a boolean"}';
  await f.request(route(story)+'/illustrate','POST',{expectedVersion:story.version});
  const failed=await until(()=>f.service.view(story.id),s=>s.illustrationJob.status==='failed');
  const records=await f.store.debugRecords(story.id),last=records.at(-1);
  assert.equal(last.kind,'operation error');assert.match(last.error.message,/invalid decision/);
  assert.equal(last.branchId,story.activeBranchId);assert.equal(last.turnId,failed.illustrationJob.id);
  assert.equal(last.stage,'Illustrator is deciding');assert.equal(last.anchorMessageId,story.branch.messages.at(-1).id);
  assert.equal(records.at(-2).response,'{"generate":"not a boolean"}');
  assert.equal(failed.branch.illustrations.length,0);
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

test('the illustrator receives visual details embedded in full character descriptions even with an empty appearance field',async t=>{
  const f=await fixture(t);
  const description='A tall traveller with short black hair and a silver eyebrow ring. Secretly searching for a missing sibling.';
  const castDescription='An innkeeper with brown eyes and a long grey braid. Privately worried about a debt.';
  const story=(await f.request('/api/stories','POST',{...setup,persona:{name:'Rowan',description},characters:[{name:'Ada',description:castDescription}]})).body;
  assert.equal(story.world.characters.find(c=>c.id==='player').appearance,'');
  await f.request(route(story)+'/illustrate','POST',{expectedVersion:story.version});
  await until(()=>f.service.view(story.id),s=>s.illustrationJob.status==='completed');
  const request=f.fake.calls.find(r=>r.messages[0].content.includes('You are the illustrator'));
  const payload=JSON.parse(request.messages[1].content[0].text);
  assert.equal(payload.characters.find(c=>c.id==='player').description,description);
  assert.equal(payload.characters.find(c=>c.name==='Ada').description,castDescription);
  assert.match(request.messages[0].content,/blank appearance field does not mean/);
});

test('illustrating an earlier moment includes its prose-only visual details and excludes later narration and explicit private annotations',async t=>{
  const f=await fixture(t);
  const earlier='Amber light falls across the blue curtains.';
  f.fake.narration=earlier+' [OOC: use a quieter writing style.] [THOUGHT: A hidden fear.]';
  const story=(await f.request('/api/stories','POST',setup)).body;
  assert.ok(!JSON.stringify(story.world.characters.find(c=>c.id==='player').knowledge).includes(earlier));
  const anchor=story.branch.messages.at(-1).id;
  f.fake.narration='Later, the curtains are green and the room is sunlit.';
  const later=(await f.request(route(story)+'/continue','POST',{expectedVersion:story.version})).body;
  await f.request(route(story)+'/illustrate','POST',{messageId:anchor,expectedVersion:later.version});
  await until(()=>f.service.view(story.id),s=>s.illustrationJob.status==='completed');
  const request=f.fake.calls.find(r=>r.messages[0].content.includes('You are the illustrator'));
  const payload=JSON.parse(request.messages[1].content[0].text);
  assert.ok(payload.narration.some(m=>m.text===earlier));
  assert.ok(!JSON.stringify(payload).includes('curtains are green'));
  assert.ok(!JSON.stringify(payload).includes('quieter writing style'));
  assert.ok(!JSON.stringify(payload).includes('hidden fear'));
  assert.ok(payload.narration.every(m=>!Object.hasOwn(m,'snapshot')));
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

test('human visual corrections create durable branches and rewind restores appearance and observers together',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  const original=await f.store.get(story.id);
  const facts=[{key:'hair',layer:'physical',text:'green hair',visible:'green hair'},{key:'tattoo',layer:'physical',text:'a hidden tattoo',visible:''}];
  const corrected=await f.request(route(story)+'/appearance','POST',{characterId:'player',facts,expectedVersion:story.version});
  assert.equal(corrected.status,200);assert.notEqual(corrected.body.activeBranchId,story.activeBranchId);
  assert.equal(corrected.body.branches.length,2);
  const player=corrected.body.world.characters.find(c=>c.id==='player'),ada=corrected.body.world.characters.find(c=>c.name==='Ada');
  assert.equal(player.visual.facts[0].text,'green hair');assert.match(ada.seenAppearance.player.current[0].text,/green hair/);
  assert.ok(!JSON.stringify(ada.seenAppearance).includes('hidden tattoo'));
  const saved=await f.store.get(story.id);
  assert.deepEqual(saved.branches[story.activeBranchId],original.branches[story.activeBranchId]);
  const target=story.branch.messages.at(-1).id;
  const rewound=(await f.request(route(story)+'/branch','POST',{mode:'rewind',messageId:target,expectedVersion:corrected.body.version})).body;
  assert.deepEqual(rewound.world,story.world);
  const backup=(await f.request(route(story)+'/export')).body;
  const imported=await f.request('/api/import','POST',backup);assert.equal(imported.status,201);
  assert.equal((await f.request(route(story)+'/appearance','POST',{characterId:'missing',facts,expectedVersion:rewound.version})).status,404);
  assert.equal((await f.request(route(story)+'/appearance','POST',{characterId:'player',facts:[{key:'bad',layer:'physical',text:'bad',visible:null}],expectedVersion:rewound.version})).status,400);
});

test('an appearance correction on an empty rewound branch still permits establishing the opening',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  const empty=(await f.request(route(story)+'/branch','POST',{mode:'rewind',expectedVersion:story.version})).body;
  assert.equal(empty.branch.messages.length,0);
  const corrected=(await f.request(route(story)+'/appearance','POST',{characterId:'player',facts:[{key:'coat',layer:'presentation',text:'red coat',visible:'red coat'}],expectedVersion:empty.version})).body;
  assert.equal(corrected.world.location,'Opening location');
  const continued=await f.request(route(story)+'/continue','POST',{expectedVersion:corrected.version});
  assert.equal(continued.status,200);assert.equal(continued.body.world.location,'The inn');
  assert.match(continued.body.world.characters.find(c=>c.id==='player').appearance,/red coat/);
});

test('character prompts compose on actual actor calls and stay out of other actor and backstage context',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/settings','PUT',{characterPrompt:'CUSTOM SHARED ACTOR RULES'})).status,200);
  const custom={...setup,characters:[{...setup.characters[0],systemPrompt:'PRIVATE ADA ACTOR RULES'},{name:'Cy',systemPrompt:'PRIVATE CY ACTOR RULES'}]};
  const created=await f.request('/api/stories','POST',custom);assert.equal(created.status,201);
  const actor=f.fake.calls.find(call=>call.messages[0].content.includes('You play ONLY'));
  assert.ok(actor.messages[0].content.includes('CUSTOM SHARED ACTOR RULES'));
  assert.ok(actor.messages[0].content.includes('PRIVATE ADA ACTOR RULES'));
  assert.ok(!JSON.stringify(actor).includes('PRIVATE CY ACTOR RULES'));
  const backstage=f.fake.calls.filter(call=>!call.messages[0].content.includes('You play ONLY'));
  for(const call of backstage)for(const marker of ['PRIVATE ADA ACTOR RULES','PRIVATE CY ACTOR RULES','CUSTOM SHARED ACTOR RULES'])assert.ok(!JSON.stringify(call).includes(marker),marker);
  assert.equal(created.body.world.characters.find(c=>c.name==='Ada').systemPrompt,'PRIVATE ADA ACTOR RULES');
  const backup=(await f.request(route(created.body)+'/export')).body;
  const imported=await f.request('/api/import','POST',backup);assert.equal(imported.status,201);
  assert.equal(imported.body.world.characters.find(c=>c.name==='Ada').systemPrompt,'PRIVATE ADA ACTOR RULES');
  const invalid=structuredClone(backup);invalid.story.branches[invalid.story.activeBranchId].messages[0].snapshot.characters.find(c=>c.name==='Ada').systemPrompt={bad:true};
  assert.equal((await f.request('/api/import','POST',invalid)).status,400);
  assert.equal((await f.request('/api/settings','PUT',{characterPrompt:''})).status,200);
  assert.equal((await f.request('/api/settings','PUT',{characterPrompt:null})).status,400);
});

test('individual prompt editing and clearing preserve branches, need no inference, and allow pre-opening edits',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',{...setup,characters:[{...setup.characters[0],systemPrompt:'OLD ADA RULES'}]})).body;
  const ada=story.world.characters.find(c=>c.name==='Ada'),baseline=await f.store.get(story.id),calls=f.fake.calls.length;
  const revised=(await f.request(route(story)+'/character-prompt','POST',{characterId:ada.id,systemPrompt:'NEW ADA RULES',expectedVersion:story.version})).body;
  assert.equal(f.fake.calls.length,calls);assert.notEqual(revised.activeBranchId,story.activeBranchId);
  assert.equal(revised.world.characters.find(c=>c.id===ada.id).systemPrompt,'NEW ADA RULES');
  assert.deepEqual((await f.store.get(story.id)).branches[story.activeBranchId],baseline.branches[story.activeBranchId]);
  assert.ok(!JSON.stringify(revised.world.characters.flatMap(c=>c.knowledge)).includes('NEW ADA RULES'));
  const cleared=(await f.request(route(story)+'/character-prompt','POST',{characterId:ada.id,systemPrompt:'',expectedVersion:revised.version})).body;
  assert.equal(cleared.world.characters.find(c=>c.id===ada.id).systemPrompt,'');
  const restored=(await f.request(route(story)+'/switch','POST',{branchId:story.activeBranchId,expectedVersion:cleared.version})).body;
  assert.equal(restored.world.characters.find(c=>c.id===ada.id).systemPrompt,'OLD ADA RULES');
  const empty=(await f.request(route(story)+'/branch','POST',{mode:'rewind',expectedVersion:restored.version})).body;
  const beforeOpening=(await f.request(route(story)+'/character-prompt','POST',{characterId:ada.id,systemPrompt:'PRE-OPENING RULES',expectedVersion:empty.version})).body;
  const continued=await f.request(route(story)+'/continue','POST',{expectedVersion:beforeOpening.version});assert.equal(continued.status,200);
  assert.equal(continued.body.world.characters.find(c=>c.id===ada.id).systemPrompt,'PRE-OPENING RULES');
  for(const [characterId,systemPrompt,status] of [['player','No player AI',400],['missing','Unknown actor',404],[ada.id,{bad:true},400],[ada.id,'x'.repeat(60001),400]])assert.equal((await f.request(route(story)+'/character-prompt','POST',{characterId,systemPrompt,expectedVersion:continued.body.version})).status,status);
  assert.equal((await f.request(route(story)+'/character-prompt','POST',{characterId:ada.id,systemPrompt:'stale',expectedVersion:0})).status,409);
});

test('illustration at a correction uses canonical concealed/visible facts, while earlier anchors retain their old state',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  const facts=[{key:'coat',layer:'presentation',text:'red coat',visible:'red coat'},{key:'tattoo',layer:'physical',text:'secret tattoo',visible:''}];
  const corrected=(await f.request(route(story)+'/appearance','POST',{characterId:'player',facts,expectedVersion:story.version})).body;
  await f.request(route(story)+'/illustrate','POST',{expectedVersion:corrected.version});
  await until(()=>f.service.view(story.id),s=>s.illustrationJob.status==='completed');
  let request=f.fake.calls.filter(r=>r.messages[0].content.includes('You are the illustrator')).at(-1);
  let payload=JSON.parse(request.messages[1].content[0].text);
  assert.deepEqual(payload.characters.find(c=>c.id==='player').visual.facts.map(({key,text,visible})=>({key,text,visible})),facts.map(({key,text,visible})=>({key,text,visible})));
  await f.request(route(story)+'/illustrate','POST',{messageId:story.branch.messages.at(-1).id,expectedVersion:corrected.version});
  await until(()=>f.service.view(story.id),s=>s.branch.illustrations.length===2);
  request=f.fake.calls.filter(r=>r.messages[0].content.includes('You are the illustrator')).at(-1);payload=JSON.parse(request.messages[1].content[0].text);
  assert.equal(payload.characters.find(c=>c.id==='player').visual.facts.length,0);
});

test('a restart marks orphaned persisted image work as interrupted instead of polling forever',async t=>{
  const f=await fixture(t),story=(await f.request('/api/stories','POST',setup)).body;
  await f.store.mutate(story.id,undefined,s=>{s.illustrationJob={id:'interrupted',branchId:s.activeBranchId,status:'generating'};},{bump:false});
  const restarted=await createApp({dataDir:f.directory,makeProvider:()=>f.fake.provider});
  const recovered=await restarted.service.view(story.id);assert.equal(recovered.illustrationJob.status,'failed');assert.match(recovered.illustrationJob.error,/stopped/);assert.equal(recovered.version,story.version);
  await restarted.close();
});
