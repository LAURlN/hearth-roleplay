import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {composeResponse,retainResponses,validateResponses} from '../src/presentation.mjs';
import {StoryService} from '../src/story-service.mjs';
import {Store,branchWorld} from '../src/store.mjs';
import {semanticReply} from './helpers/semantic-fixture.mjs';

const sources=[{id:'n',role:'narrator',speaker:'Narrator',text:'Rain rattles against the window.'},{id:'c',role:'character',speaker:'Ada',text:'Ada raises her cup. “Come inside.”'}];
const proposal=messages=>({parts:messages.map(m=>({text:m.text,sourceMessageIds:[m.id],evidence:[{messageId:m.id,excerpt:m.text}],spoken:[]})),omitted:[],faithful:true});
const settings={chatModel:'chat',helperModel:'helper',helperEffort:'high',roleplayPrompt:'Use flowing restrained prose.'};

test('presenter sees only ordered public originals and permits a natural sourced rewrite',async()=>{
  const original=[{id:'p',role:'player',text:'[THOUGHT: private input]'},...sources,{id:'hidden',internal:true,role:'narrator',text:'',snapshot:{secret:'never send'}}];
  let request;
  const response=await composeResponse(original,{settings,complete:async r=>{
    request=r;
    const result=proposal(sources);result.parts[0].text='Rain drums on the window.';
    return JSON.stringify(result);
  }});
  assert.deepEqual(JSON.parse(request.messages[1].content),{contributions:sources});
  assert.equal(request.model,'helper');assert.equal(request.reasoningEffort,'high');
  assert.match(request.messages[0].content,/flowing restrained prose/);
  assert.ok(!JSON.stringify(request).includes('private input'));
  assert.ok(!JSON.stringify(request).includes('never send'));
  assert.match(response.text,/Rain drums/);assert.match(response.text,/Come inside/);
  assert.deepEqual(response.sourceMessageIds,['n','c','hidden']);assert.equal(response.anchorMessageId,'hidden');
  assert.equal(original[1].text,sources[0].text);
});

test('presenter retries missing coverage, reordered sources and altered speech once',async()=>{
  for(const invalidate of [r=>r.parts.pop(),r=>r.parts.reverse(),r=>r.parts[1].text='Ada says “Go away.”']){
    let calls=0;
    const result=await composeResponse(sources,{settings,complete:async request=>{
      const value=proposal(sources);if(calls++===0)invalidate(value);else assert.match(request.messages.at(-1).content,/Correct the presentation/);
      return JSON.stringify(value);
    }});
    assert.equal(calls,2);assert.match(result.text,/Come inside/);
  }
});

test('presenter allows only explained duplicate environmental omissions and refuses invalid citations',async()=>{
  const repeated=[...sources,{id:'dup',role:'narrator',speaker:'Narrator',text:'Rain rattles against the window.'}];
  const value=proposal(sources);value.omitted=[{messageId:'dup',duplicateOfMessageId:'n',reason:'The same rain description repeats without any new action or detail.'}];
  assert.ok(await composeResponse(repeated,{settings,complete:async()=>JSON.stringify(value)}));
  const bad=proposal(sources);bad.parts[0].evidence[0].excerpt='An invented dragon arrives.';
  await assert.rejects(composeResponse(sources,{settings,complete:async()=>JSON.stringify(bad)}),/exact excerpt/);
});

test('quoted speech preserves order and multiplicity even inside one merged paragraph',async()=>{
  for(const [utterances,text] of [
    [['“Stay.”','“Stay.”'],'“Stay.”'],
    [['“First.”','“Second.”'],'“Second.” Then “First.”'],
  ]){
    const messages=utterances.map((text,i)=>({id:'speech'+i,role:'character',speaker:'Actor '+i,text}));
    const value={parts:[{text,sourceMessageIds:messages.map(m=>m.id),evidence:messages.map(m=>({messageId:m.id,excerpt:m.text})),spoken:[]}],omitted:[],faithful:true};
    await assert.rejects(composeResponse(messages,{settings,complete:async()=>JSON.stringify(value)}),/in order, once/);
  }
});

test('presenter refusals and transport failures are terminal; aborts cannot produce a passage',async()=>{
  for(const raw of ['I cannot help with this.',JSON.stringify({refusal:'No.'})]){
    let calls=0;await assert.rejects(composeResponse(sources,{settings,complete:async()=>{calls++;return raw;}}));assert.equal(calls,1);
  }
  let calls=0;await assert.rejects(composeResponse(sources,{settings,complete:async()=>{calls++;throw new Error('offline');}}),/offline/);assert.equal(calls,1);
  const controller=new AbortController();
  await assert.rejects(composeResponse(sources,{settings,signal:controller.signal,complete:async()=>{controller.abort();return JSON.stringify(proposal(sources));}}),{name:'AbortError'});
  assert.equal((await composeResponse([{id:'hidden',role:'narrator',internal:true,text:''}],{settings,complete:()=>{throw new Error('No call needed');}})).text,'…');
});

test('prefix response projection discards future prose, preserves full groups and validates references',()=>{
  const response={id:'r',text:'A polished passage that includes future speech.',sourceMessageIds:['n','c'],anchorMessageId:'c',createdAt:new Date().toISOString()};
  assert.deepEqual(retainResponses([response],sources),[response]);
  const [partial]=retainResponses([response],sources.slice(0,1));
  assert.equal(partial.text,sources[0].text);assert.deepEqual(partial.sourceMessageIds,['n']);assert.equal(partial.anchorMessageId,'n');
  assert.notEqual(partial.id,response.id);assert.equal(retainResponses(undefined,[]),undefined);
  validateResponses({messages:sources,responses:[response]});
  for(const change of [{sourceMessageIds:['missing']},{anchorMessageId:'n'},{sourceMessageIds:['c','n'],anchorMessageId:'n'}])assert.throws(()=>validateResponses({messages:sources,responses:[{...response,...change}]}),/response/);
});

async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-presentation-')),store=new Store(directory);await store.init();await store.saveSettings({autoIllustrate:false});
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const fake={calls:[],silent:false,fail:false,hold:false};
  const provider={complete:async request=>{
    fake.calls.push(request);const system=request.messages[0].content,payload=JSON.parse(request.messages[1].content);
    if(system.includes('PLAYER PASSAGE PRESENTER')){
      if(fake.fail)return '{}';
      if(fake.hold){fake.entered?.();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));}
      const result=proposal(payload.contributions);if(payload.contributions[0].role==='narrator')result.parts[0].text='Rain drums on the glass.';return JSON.stringify(result);
    }
    const semantic=semanticReply(request);if(semantic!==null)return semantic;
    if(system.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    if(system.includes('PLAYER PLACEMENT RESOLVER'))return '{"correction":null,"placements":[]}';
    if(system.includes('private input interpreter'))return JSON.stringify({segments:[{kind:'speech',text:payload.input,recipients:[]}],allowMajorTimeSkip:false});
    if(system.includes('omniscient narrator/planner'))return JSON.stringify({events:[],speakers:payload.world.characters.filter(c=>c.id!=='player').map(c=>c.id),text:fake.silent?'':'Rain rattles against the window.'});
    if(system.includes('play ONLY'))return JSON.stringify({text:fake.silent||payload.context.character.name==='Ben'?'':'“Come inside.”',privateState:'PRIVATE NPC REFLECTION '+fake.calls.length,movement:null});
    if(system.includes('A human has authored an edited'))return JSON.stringify({events:[],allowMajorTimeSkip:false});
    throw new Error('Unexpected request '+system);
  }};
  const service=new StoryService(store,{makeProvider:()=>provider});
  const view=await service.create({title:'Presentation test',premise:'Quiet rain.',persona:{name:'Pat'},characters:[{name:'Ada'},{name:'Ben'}]});
  return {store,service,view,fake};
}

test('service saves isolated presentation and a final hidden checkpoint without changing inner snapshots',async t=>{
  const {store,service,view,fake}=await fixture(t),saved=await store.get(view.id),branch=saved.branches[saved.activeBranchId];
  assert.equal(view.branch.responses.length,1);const response=view.branch.responses[0];
  assert.match(response.text,/Rain drums/);assert.ok(!JSON.stringify(branchWorld(branch)).includes('Rain drums'));
  assert.ok(branch.messages.at(-1).internal);assert.equal(response.anchorMessageId,branch.messages.at(-1).id);
  assert.equal(branch.messages.at(-2).snapshot.characters[1].privateState,branchWorld(branch).characters[1].privateState);
  assert.notEqual(branch.messages[0].snapshot.characters[1].privateState,branchWorld(branch).characters[1].privateState);
  assert.ok(view.branch.messages.every(m=>!m.internal));
  fake.calls=[];await service.turn(view.id,view.version,'Hello.');
  for(const call of fake.calls)if(!call.messages[0].content.includes('PLAYER PASSAGE PRESENTER'))assert.ok(!JSON.stringify(call.messages).includes('Rain drums'));
  assert.ok(!fake.calls.some(call=>call.stage==='Closing the moment'));
});

test('aggregate and original rewind restore different complete boundaries; revisions preserve the old future',async t=>{
  const {store,service,view}=await fixture(t),originalId=view.activeBranchId,response=view.branch.responses[0],first=view.branch.messages[0];
  let revised=await service.branch(view.id,{mode:'rewind',messageId:first.id,expectedVersion:view.version});
  assert.equal(revised.world.characters[1].privateState,'');assert.equal(revised.branch.responses[0].text,first.text);
  revised=await service.switch(view.id,{branchId:originalId,expectedVersion:revised.version});
  revised=await service.branch(view.id,{mode:'rewind',messageId:response.anchorMessageId,expectedVersion:revised.version});
  assert.match(revised.world.characters[1].privateState,/PRIVATE NPC/);assert.equal(revised.branch.responses[0].text,response.text);
  for(const mode of ['edit','delete']){
    revised=await service.switch(view.id,{branchId:originalId,expectedVersion:revised.version});
    revised=await service.branch(view.id,{mode,messageId:view.branch.messages[1].id,text:'“Please enter.”',expectedVersion:revised.version});
    const saved=await store.get(view.id);assert.equal(saved.branches[originalId].responses[0].text,response.text);
    assert.ok(revised.branch.responses.length>=2);validateResponses(saved.branches[saved.activeBranchId]);
    assert.ok(revised.branch.responses[0].sourceMessageIds.includes(first.id));
  }
});

test('presentation failures and cancellation roll back canonical state, log errors and leave recoverable history',async t=>{
  const {store,service,view,fake}=await fixture(t),before=await store.get(view.id);fake.fail=true;
  await assert.rejects(service.turn(view.id,view.version,'Hello.'),/faithfully/);assert.deepEqual(await store.get(view.id),before);
  assert.match(await service.debug(view.id),/Composing the player passage/);
  fake.fail=false;fake.hold=true;
  const entered=new Promise(resolve=>fake.entered=resolve),pending=service.turn(view.id,view.version,'Hello again.');await entered;await service.cancel(view.id);await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(await store.get(view.id),before);
});

test('response export/import round trip validates canonical references and permits hidden checkpoint text',async t=>{
  const {service,view,fake}=await fixture(t),data=await service.export(view.id),imported=await service.import(data);
  assert.deepEqual(imported.branch.responses,view.branch.responses);
  const bad=structuredClone(data);bad.story.branches[bad.story.activeBranchId].responses[0].sourceMessageIds[0]='invented';
  await assert.rejects(service.import(bad),/response (?:source|span)/);
  fake.silent=true;const silent=await service.turn(view.id,view.version,'Hello.');
  assert.equal(silent.branch.responses.at(-1).text,'…');
  assert.equal(silent.branch.messages.at(-1).role,'player');
  assert.equal(silent.branch.responses.at(-1).afterMessageId,silent.branch.messages.at(-1).id);
});
