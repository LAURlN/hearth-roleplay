import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store,branchWorld} from '../src/store.mjs';
import {StoryService,validateSetup} from '../src/story-service.mjs';
import {DEFAULT_SETTINGS,normalizeSettings} from '../src/settings.mjs';
import {createSimpleState,buildSimpleContextRequest,runSimpleTurn} from '../src/simple-engine.mjs';
import {countMessages} from '../src/tokens.mjs';
import {contextUsage} from '../src/memory.mjs';

const setup={mode:'simple',title:'The Lantern',premise:'A quiet inn. A hidden vault lies below.',persona:{name:'Rowan',description:'A traveller wearing a green coat.'},characters:[{name:'Ada',appearance:'A red scarf',description:'A reserved innkeeper.',personality:'Patient',goals:'Protect the inn'}]};
const reply={text:'Ada sets down a cup. “Welcome,” she says.',visiblePlayerInput:'',scene:{location:'The inn',timeLabel:'Evening'}};
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-simple-')),store=new Store(directory);await store.init();await store.saveSettings({autoIllustrate:false,chatModel:'main-model',helperModel:'never-helper',chatEffort:'high',helperEffort:'low',roleplayPrompt:'DETAILED PROMPT MUST NOT APPEAR',simpleModePrompt:'CUSTOM SIMPLE INSTRUCTIONS'});
  const calls=[],images=[],fake={respond:()=>JSON.stringify(reply)};
  const provider={complete:async request=>{calls.push(request);return fake.respond(request);},image:async request=>{images.push(request);return {bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPz0AAAAASUVORK5CYII=','base64'),extension:'png'};}};
  const service=new StoryService(store,{makeProvider:()=>provider});
  t.after(async()=>{for(const id of service.illustrator.jobs.keys())await service.illustrator.cancel(id);await rm(directory,{recursive:true,force:true});});
  return {store,service,calls,images,fake};
}
test('mode is validated at creation and Simple has a separate editable prompt',()=>{
  assert.equal(validateSetup({...setup,mode:undefined}).mode,'detailed');
  assert.equal(validateSetup(setup).mode,'simple');
  for(const mode of ['unknown','',null,{}])assert.throws(()=>validateSetup({...setup,mode}),/story mode/);
  assert.ok(DEFAULT_SETTINGS.simpleModePrompt.includes('sole narrator'));
  assert.throws(()=>normalizeSettings({simpleModePrompt:''}),/simpleModePrompt/);
  assert.equal(normalizeSettings({simpleModePrompt:'Custom'}).simpleModePrompt,'Custom');
});
test('Simple openings and mixed inputs use exactly one main-model narrator request and preserve canonical history',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].model,'main-model');assert.equal(f.calls[0].reasoningEffort,'high');
  assert.ok(f.calls[0].messages[0].content.startsWith('CUSTOM SIMPLE INSTRUCTIONS'));
  assert.ok(!JSON.stringify(f.calls).includes('DETAILED PROMPT MUST NOT APPEAR'));
  assert.equal(story.world.mode,'simple');assert.equal(story.branch.messages.length,1);assert.equal(story.branch.messages[0].role,'narrator');assert.deepEqual(story.branch.responses,[]);
  const input='I order tea. [THOUGHT: I suspect a trap.] [OOC: Keep this slow.]';
  f.fake.respond=request=>{
    const storyContext=JSON.parse(request.messages[0].content.split('Story context:\n')[1]);assert.equal(request.messages.at(-1).content,input);assert.equal(request.messages.at(-1).role,'user');assert.ok(storyContext.characters.some(c=>c.goals==='Protect the inn'));assert.equal(request.messages[1].role,'assistant');
    return JSON.stringify({...reply,text:'Ada pours the tea.',visiblePlayerInput:'Rowan orders tea.'});
  };
  story=await f.service.turn(story.id,story.version,input);
  assert.equal(f.calls.length,2);assert.equal(story.branch.messages.at(-2).text,input);assert.equal(story.branch.messages.at(-1).text,'Ada pours the tea.');
  assert.ok(story.world.characters.every(c=>c.knowledge.length===0));assert.equal(story.world.events.length,0);
  const saved=await f.store.get(story.id),branch=saved.branches[saved.activeBranchId];
  assert.equal(story.contextUsage.narrator.tokens,countMessages(buildSimpleContextRequest(branchWorld(branch),branch.messages,await f.store.settings())).tokens);
  const log=await f.service.debug(story.id);assert.match(log,/Narrating the story/);assert.match(log,/I suspect a trap/);
});
test('Simple edits preserve exact prose without reconciliation or new facts; delete, rewind and mode import are stable',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);
  story=await f.service.turn(story.id,story.version,'I order tea.');
  const original=structuredClone(story),target=story.branch.messages.at(-1),calls=f.calls.length;
  const exact='Ada is suddenly on Mars.\n\n“Is this a revision?”';
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'edit',messageId:target.id,text:exact,regenerate:false});
  assert.equal(f.calls.length,calls);assert.equal(story.branch.messages.at(-1).text,exact);assert.equal(story.world.location,'The inn');assert.equal(story.world.events.length,0);
  f.fake.respond=request=>{assert.equal(request.messages.at(-2).content,exact);assert.equal(request.messages.at(-2).role,'assistant');return JSON.stringify(reply);};
  story=await f.service.turn(story.id,story.version,null);assert.equal(f.calls.length,calls+1);
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'rewind',messageId:story.branch.messages[0].id});
  assert.equal(f.calls.length,calls+1);assert.equal(story.branch.messages.length,1);
  story=await f.service.switch(story.id,{expectedVersion:story.version,branchId:original.activeBranchId});
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'delete',messageId:target.id,regenerate:false});
  assert.equal(f.calls.length,calls+1);assert.ok(!story.branch.messages.some(m=>m.id===target.id));
  const data=await f.service.export(story.id),imported=await f.service.import(data);assert.equal(imported.setup.mode,'simple');assert.equal(imported.world.mode,'simple');
  const corrupt=structuredClone(data);corrupt.story.setup.mode='detailed';await assert.rejects(f.service.import(corrupt),/checkpoint mode/);
  const unknown=structuredClone(data);unknown.story.setup.mode='other';await assert.rejects(f.service.import(unknown),/story mode/);
  await assert.rejects(f.service.characterPrompt(story.id,{expectedVersion:story.version,characterId:story.world.characters[1].id,systemPrompt:'Override'}),/Detailed mode/);assert.equal(f.calls.length,calls+1);
});
test('edited player input discards stale public extraction and continuation refreshes it in the same narrator call',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);
  f.fake.respond=()=>JSON.stringify({...reply,visiblePlayerInput:'Rowan waves.'});
  story=await f.service.turn(story.id,story.version,'I wave.');const target=story.branch.messages.at(-2),calls=f.calls.length;
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'edit',messageId:target.id,text:'[THOUGHT: I keep still.]',regenerate:false});
  assert.equal(story.branch.messages.at(-1).visiblePlayerInput,undefined);assert.equal(f.calls.length,calls);
  f.fake.respond=()=>JSON.stringify({...reply,visiblePlayerInput:''});
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'edit',messageId:story.branch.messages.at(-1).id,text:'[OOC: Wait here.]'});
  assert.equal(story.branch.messages.at(-2).visiblePlayerInput,'');assert.equal(f.calls.length,calls+1);
});
test('native player JSON remains exact model input and plain prose responses need no extra request',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);
  const input=JSON.stringify({world:{characters:[],events:[]},note:'An authored in-story document'}),calls=f.calls.length;
  f.fake.respond=request=>{assert.equal(request.messages.at(-1).content,input);return 'Ada examines the document.\n\n“I see,” she says.';};
  story=await f.service.turn(story.id,story.version,input);assert.equal(f.calls.length,calls+1);assert.equal(story.branch.messages.at(-1).text,'Ada examines the document.\n\n“I see,” she says.');
});
test('Simple compaction summarizes an oldest full-message prefix with the main model and restores notes in snapshots',async()=>{
  const state=createSimpleState(setup),settings={...DEFAULT_SETTINGS,chatModel:'main',helperModel:'forbidden',chatEffort:'high',helperEffort:'low'};
  const messages=Array.from({length:45},(_,i)=>({id:`m-${i}`,role:i%2?'narrator':'player',speaker:'Someone',text:`Moment ${i}: `+'The traveller talks about the garden. '.repeat(70),storyTime:0,eventCount:0}));
  const baseline=countMessages(buildSimpleContextRequest(state,[],settings)).tokens,full=countMessages(buildSimpleContextRequest(state,messages,settings)).tokens;
  settings.contextTokenLimit=baseline+Math.floor((full-baseline)/2);
  const original=structuredClone(messages),calls=[];
  const result=await runSimpleTurn({state,messages,settings,input:null,complete:async request=>{
    calls.push(request);assert.equal(request.model,'main');assert.equal(request.reasoningEffort,'high');
    if(request.messages[0].content.includes('private continuity notes')){
      const data=JSON.parse(request.messages[1].content);assert.equal(data.sources[0].record.id,'m-0');assert.ok(data.sources.length>20&&data.sources.length<40);return '{"summary":"Earlier garden conversation."}';
    }
    const data=JSON.parse(request.messages[0].content.split('Story context:\n')[1]);assert.equal(data.continuityNotes,'Earlier garden conversation.');assert.match(request.messages.at(-1).content,/Moment 44:/);assert.ok(!request.messages.some(m=>m.content.startsWith('Moment 0:')));assert.ok(countMessages(request.messages).tokens<settings.contextTokenLimit);return JSON.stringify(reply);
  }});
  assert.equal(calls.length,2);assert.deepEqual(messages,original);assert.equal(state.narratorMemory,undefined);assert.ok(result.messages[0].snapshot.narratorMemory.throughMessageId);
  assert.ok(messages.some(m=>m.id===result.state.narratorMemory.throughMessageId));
});
test('rewind restores Simple narrator notes at their exact conversation checkpoint',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);const first=story.branch.messages[0].id;
  await f.store.mutate(story.id,undefined,s=>{
    const branch=s.branches[s.activeBranchId],snapshot=branch.messages[0].snapshot;
    for(let i=0;i<45;i++)branch.messages.push({id:`long-${i}`,role:'narrator',speaker:'Narrator',text:`Moment ${i}: `+'A traveller discusses the garden. '.repeat(70),createdAt:new Date().toISOString(),snapshot:structuredClone(snapshot)});
  },{bump:false});
  const stored=await f.store.get(story.id),branch=stored.branches[stored.activeBranchId],state=branchWorld(branch),settings=await f.store.settings();
  const baseline=countMessages(buildSimpleContextRequest(state,[],settings)).tokens,full=countMessages(buildSimpleContextRequest(state,branch.messages,settings)).tokens;
  await f.store.saveSettings({contextTokenLimit:baseline+Math.floor((full-baseline)/2)});
  f.fake.respond=request=>request.messages[0].content.includes('private continuity notes')?'{"summary":"Earlier garden conversation."}':JSON.stringify(reply);
  story=await f.service.turn(story.id,story.version,null);assert.equal(story.world.narratorMemory.summary,'Earlier garden conversation.');const after=story.branch.messages.at(-1).id,originalBranch=story.activeBranchId;
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'rewind',messageId:first});assert.equal(story.world.narratorMemory,undefined);
  story=await f.service.switch(story.id,{expectedVersion:story.version,branchId:originalBranch});
  story=await f.service.branch(story.id,{expectedVersion:story.version,mode:'rewind',messageId:after});assert.equal(story.world.narratorMemory.summary,'Earlier garden conversation.');
});
test('Simple fixed-context overflow and count errors are explicit, with no silent truncation',async()=>{
  const state=createSimpleState(setup),settings={...DEFAULT_SETTINGS,contextTokenLimit:1};let calls=0;
  await assert.rejects(runSimpleTurn({state,settings,input:null,complete:async()=>{calls++;}}),error=>error.code==='CONTEXT_LIMIT');assert.equal(calls,0);
  assert.throws(()=>contextUsage(state,[],settings,buildSimpleContextRequest,{counter:()=>{throw new Error('Tokenizer unavailable');}}),/Tokenizer unavailable/);assert.equal(calls,0);
});
test('a previously private thought may be deliberately disclosed in a later public utterance',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);
  story=await f.service.turn(story.id,story.version,'[THOUGHT: The key is under the mat.]');
  f.fake.respond=()=>JSON.stringify({...reply,text:'“The key is under the mat?” Ada asks.',visiblePlayerInput:'Rowan says, “The key is under the mat.”'});
  story=await f.service.turn(story.id,story.version,'I tell Ada: “The key is under the mat.”');
  assert.match(story.branch.messages.at(-1).text,/The key is under the mat/);
});
test('private marker echoes fail atomically and canceled Simple requests are logged without saving partial turns',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup),before=await f.store.get(story.id);
  f.fake.respond=()=>JSON.stringify({...reply,text:'[THOUGHT: The secret password is cinder.]'});
  await assert.rejects(f.service.turn(story.id,story.version,'[THOUGHT: The secret password is cinder.]'),/Private player markers/);
  assert.deepEqual(await f.store.get(story.id),before);
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  f.fake.respond=request=>new Promise((_,reject)=>{entered();request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});
  const pending=f.service.turn(story.id,story.version,'A canceled message.');await ready;await f.service.cancel(story.id);await assert.rejects(pending,/stopped/);
  assert.deepEqual(await f.store.get(story.id),before);assert.match(await f.service.debug(story.id),/A canceled message/);
});
test('Simple illustrator uses observable history and authored descriptions, excludes private inputs and narrator notes',async t=>{
  const f=await fixture(t);let story=await f.service.create(setup);
  f.fake.respond=()=>JSON.stringify({...reply,text:'Ada opens the blue shutters.',visiblePlayerInput:'Rowan points to the window.'});
  story=await f.service.turn(story.id,story.version,'I point to the window. [THOUGHT: secretly terrified] [OOC: add suspense]');
  await f.store.mutate(story.id,undefined,s=>{s.branches[s.activeBranchId].messages.at(-1).snapshot.narratorMemory={summary:'PRIVATE SUMMARY SECRET',throughMessages:2,throughMessageId:s.branches[s.activeBranchId].messages[1].id};},{bump:false});
  f.fake.respond=request=>{
    const data=JSON.parse(request.messages[1].content[0].text),serialized=JSON.stringify(data);
    assert.ok(serialized.includes('Rowan points to the window.'));assert.ok(serialized.includes('blue shutters'));assert.ok(serialized.includes('reserved innkeeper'));assert.ok(serialized.includes('green coat'));
    for(const secret of ['secretly terrified','add suspense','PRIVATE SUMMARY SECRET','hidden vault'])assert.ok(!serialized.includes(secret),secret);
    return JSON.stringify({generate:true,prompt:'An inn with blue shutters.',caption:'At the inn',characterIds:data.characters.map(c=>c.id),referenceIds:[]});
  };
  await f.service.illustrate(story.id,{expectedVersion:story.version});
  const deadline=Date.now()+5000;while(f.service.illustrator.jobs.has(story.id)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const viewed=await f.service.view(story.id);assert.equal(viewed.illustrationJob.status,'completed',viewed.illustrationJob.error);assert.equal(f.images.length,1);assert.equal(viewed.branch.illustrations[0].anchorMessageId,story.branch.messages.at(-1).id);
});
