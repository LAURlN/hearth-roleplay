import test from 'node:test';
import assert from 'node:assert/strict';
import { compactKnowledge,narratorProjection,contextUsage } from '../src/memory.mjs';
import { createInitialState,characterContext } from '../src/engine.mjs';
import {countMessages} from '../src/tokens.mjs';

function buildRequest(state,messages,settings,ownerId){
  let payload;
  if(ownerId==='narrator'){
    const memory=state.narratorMemory;
    const found=memory?.throughMessageId?messages.findIndex(m=>m.id===memory.throughMessageId):-1;
    const start=found>=0?found+1:memory?.throughMessages??0;
    payload={events:state.events.slice(memory?.through??0),conversation:messages.slice(start),summary:memory?.summary??''};
  }else{
    const who=state.characters.find(c=>c.id===ownerId);
    payload={observations:who.knowledge.slice(who.memory?.through??0),summary:who.memory?.summary??''};
  }
  payload.fixedTokens=settings.fixedTokens??0;
  return [{role:'user',content:JSON.stringify(payload)}];
}
function counter(messages){const p=JSON.parse(messages[0].content);return {tokens:((p.observations??p.events??[]).length+(p.conversation??[]).length)*10+(p.summary?1:0)+p.fixedTokens,encoding:'test',approximate:true};}
const options={settings:{contextTokenLimit:30},buildRequest,counter,sourceCounter:()=>1};

test('memory compaction sees only its owner observations and preserves original records',async()=>{
  const state=createInitialState({characters:[{name:'Ada'},{name:'Ben'}]});
  state.events.push({text:'GLOBAL HIDDEN CAUSE'});state.privateInputs=['PRIVATE PLAYER THOUGHT'];state.characters[2].privateState='BEN SECRET';
  const ada=state.characters[1];ada.knowledge=Array.from({length:6},(_,i)=>({id:'fact'+i,text:'Observation '+i,source:'A witness',time:i,publicationId:'source'+i}));
  const original=structuredClone(ada.knowledge);let calls=0;
  await compactKnowledge(state,{...options,settings:{...options.settings,chatModel:'test'},complete:async request=>{calls++;const content=JSON.stringify(request.messages);for(const forbidden of ['GLOBAL HIDDEN CAUSE','PRIVATE PLAYER THOUGHT','BEN SECRET'])assert.ok(!content.includes(forbidden));return JSON.stringify({summary:'A witness described observations 0 through 3.'});}});
  assert.equal(calls,1);assert.equal(ada.memory.through,4);assert.deepEqual(ada.knowledge,original);assert.deepEqual(ada.memory.sourceIds,['fact0','fact1','fact2','fact3']);
  assert.equal(characterContext(state,ada.id).knowledge.length,2);
  assert.match(characterContext(state,ada.id).memory.summary,/witness/);
  await compactKnowledge(state,{...options,complete:async()=>{throw new Error('Must not summarize twice.');}});
});
test('model-facing projection cuts only explicit memory prefixes and preserves all other sources',()=>{
  const state=createInitialState({characters:[{name:'Ada'}]});
  state.events=Array.from({length:300},(_,i)=>({id:String(i)}));state.characters[1].knowledge=Array.from({length:200},(_,i)=>({id:String(i)}));
  state.narratorMemory={through:180,summary:'Earlier narrator continuity'};
  state.characters[1].memory={through:140,summary:'Earlier memory',sourceIds:['0']};
  state.publications=Array.from({length:150},(_,i)=>({id:`publication${i}`}));state.privateInputs=Array.from({length:80},(_,i)=>`private${i}`);
  const projected=narratorProjection(state);
  assert.equal(projected.events.length,120);assert.equal(projected.characters[1].knowledge.length,60);assert.equal(state.events.length,300);assert.equal(state.characters[1].knowledge.length,200);assert.equal(projected.characters[1].memory.summary,'Earlier memory');
  assert.equal(projected.publications.length,150);assert.equal(projected.privateInputs.length,80);
});

function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function memoryWorld(){
  const state=createInitialState({characters:[{name:'Ada'},{name:'Ben'}]});
  for(const person of state.characters.slice(1))person.knowledge=Array.from({length:3},(_,i)=>({id:`${person.name}-${i}`,text:`${person.name} ONLY observation ${i}`,source:'Witness',time:i}));
  return state;
}

test('owner summaries overlap with bounded timeline work and publish atomically after every result succeeds',async()=>{
  const state=memoryWorld(),ada=state.characters[1],ben=state.characters[2];state.events=Array.from({length:3},(_,i)=>({id:String(i),text:`NARRATOR EVENT ${i}`}));
  state.privateInputs=['PRIVATE PLAYER THOUGHT'];ben.privateState='BEN PRIVATE STATE';
  const original=structuredClone(state),gates=[deferred(),deferred(),deferred()],timelineEntered=deferred(),requests=[];
  let active=0,maximum=0;
  const task=compactKnowledge(state,{...options,settings:{...options.settings,chatModel:'actor',helperModel:'helper',helperEffort:'low'},complete:async request=>{
    const index=requests.length;requests.push(request);active++;maximum=Math.max(maximum,active);
    const payload=JSON.parse(request.messages[1].content);
    assert.equal(request.model,'helper');assert.equal(request.reasoningEffort,'low');
    if(index<2){const serialized=JSON.stringify(payload),own=index===0?'Ada':'Ben',other=index===0?'Ben':'Ada';assert.equal(payload.name,own);assert.ok(!serialized.includes(`${other} ONLY`));assert.ok(!serialized.includes('NARRATOR EVENT'));assert.ok(!serialized.includes('PRIVATE'));}
    else {assert.equal(payload.sources.length,2);assert.equal(payload.sources[0].record.text,'NARRATOR EVENT 0');timelineEntered.resolve();}
    await gates[index].promise;active--;return JSON.stringify({summary:index<2?`${payload.name} remembers their observations.`:'The narrator remembers the earlier events.'});
  }});
  assert.equal(requests.length,2);assert.deepEqual(state,original);
  gates[1].resolve();await timelineEntered.promise;assert.equal(requests.length,3);assert.deepEqual(state,original);
  gates[2].resolve();await Promise.resolve();assert.equal(ada.memory,undefined);assert.equal(ben.memory,undefined);assert.equal(state.narratorMemory,undefined);
  gates[0].resolve();assert.equal(await task,state);assert.equal(maximum,2);
  assert.equal(ada.memory.through,2);assert.equal(ben.memory.through,2);assert.equal(state.narratorMemory.through,2);
  assert.match(ada.memory.summary,/Ada/);assert.match(ben.memory.summary,/Ben/);assert.deepEqual(ada.knowledge,original.characters[1].knowledge);
  assert.equal(requests[0].stage,"Organising Ada's memories");assert.equal(requests[2].stage,'Organising the story timeline');
});

test('a malformed parallel summary cancels and drains its sibling without committing any memory',async()=>{
  const state=memoryWorld(),original=structuredClone(state),gate=deferred(),aborted=deferred();let settled=false,drained=false;
  const task=compactKnowledge(state,{...options,complete:async request=>{
    const name=JSON.parse(request.messages[1].content).name;
    if(name==='Ben')return '{"summary":""}';
    request.signal.addEventListener('abort',()=>aborted.resolve(),{once:true});await gate.promise;drained=true;return '{"summary":"Ada has a valid summary."}';
  }});
  const checked=assert.rejects(task,error=>{assert.match(error.message,/memory summary was invalid/);assert.equal(error.stage,"Organising Ben's memories");return true;}).then(()=>{settled=true;});
  await aborted.promise;assert.equal(settled,false);assert.deepEqual(state,original);gate.resolve();await checked;
  assert.equal(drained,true);assert.deepEqual(state,original);
});

test('cancelling parallel compaction never applies successful late summaries',async()=>{
  const state=memoryWorld(),original=structuredClone(state),parent=new AbortController(),gate=deferred(),reason=new Error('Stopped');let calls=0;
  const task=compactKnowledge(state,{...options,signal:parent.signal,complete:async()=>{calls++;await gate.promise;return '{"summary":"Late summary."}';}});
  const checked=assert.rejects(task,error=>error===reason);assert.equal(calls,2);parent.abort(reason);gate.resolve();await checked;
  assert.deepEqual(state,original);
});

test('a queued narrator summary uses its captured source data despite later caller mutation',async()=>{
  const state=memoryWorld(),gates=[deferred(),deferred()],timelineEntered=deferred();state.events=Array.from({length:3},(_,i)=>({text:`Earlier ${i}`}));
  let index=0;
  const task=compactKnowledge(state,{...options,complete:async request=>{
    const payload=JSON.parse(request.messages[1].content),current=index++;
    if(payload.name){await gates[current].promise;return '{"summary":"A personal memory."}';}
    assert.equal(payload.sources[0].record.text,'Earlier 0');timelineEntered.resolve();return '{"summary":"The earlier timeline."}';
  }});
  state.events[0].text='LATER caller mutation';gates[1].resolve();await timelineEntered.promise;gates[0].resolve();await task;
  assert.equal(state.narratorMemory.through,2);
});

test('threshold and contextUsage count the actual built request, independently for each owner',async()=>{
  const state=memoryWorld(),messages=[{id:'one',text:'A prior exchange.'}],settings={chatModel:'proxy-alias'};
  const usage=contextUsage(state,messages,settings,buildRequest);
  assert.deepEqual(usage,{...countMessages(buildRequest(state,messages,settings,'narrator'),settings.chatModel),limit:300000,threshold:300000});
  const seen=[];
  await compactKnowledge(state,{...options,target:state.characters[1].id,buildRequest:(...args)=>{seen.push(args[3]);return buildRequest(...args);},complete:async()=>'{"summary":"Ada remembers."}'});
  assert.deepEqual(seen,[state.characters[1].id,state.characters[1].id]);assert.equal(state.characters[2].memory,undefined);assert.equal(state.narratorMemory,undefined);
});

test('the oldest prefix follows token weight rather than a number of observations',async()=>{
  const state=memoryWorld(),ada=state.characters[1];ada.knowledge=Array.from({length:4},(_,i)=>({id:`o${i}`,text:`Observation${i}`,weight:i===0?6:1}));
  let input;
  await compactKnowledge(state,{...options,settings:{contextTokenLimit:35},target:ada.id,sourceCounter:text=>JSON.parse(text).weight,complete:async request=>{input=JSON.parse(request.messages[1].content);return '{"summary":"The large first observation."}';}});
  assert.equal(input.observations.length,1);assert.equal(ada.memory.through,1);assert.equal(characterContext(state,ada.id).knowledge.length,3);
});

test('subsequent character compaction merges only its previous summary and the next oldest observations',async()=>{
  const state=memoryWorld(),ada=state.characters[1];ada.knowledge=Array.from({length:5},(_,i)=>({id:`o${i}`,text:`Observation${i}`}));ada.memory={summary:'Earlier personal summary.',through:2,sourceIds:['o0','o1']};
  let input;
  await compactKnowledge(state,{...options,target:ada.id,complete:async request=>{input=JSON.parse(request.messages[1].content);return '{"summary":"Combined personal summary."}';}});
  assert.equal(input.existingSummary,'Earlier personal summary.');assert.deepEqual(input.observations.map(o=>o.id),['o2','o3']);assert.equal(ada.memory.through,4);assert.deepEqual(ada.memory.sourceIds,['o0','o1','o2','o3']);
});

test('narrator event and message prefixes share chronological checkpoint boundaries without serializing snapshots',async()=>{
  const state=createInitialState({characters:[{name:'Ada'}]});state.events=Array.from({length:3},(_,i)=>({id:`e${i}`,time:0,text:`Event ${i}`}));
  const messages=Array.from({length:3},(_,i)=>({id:`m${i}`,role:i===1?'player':'narrator',text:`Message ${i}`,storyTime:0,eventCount:i+1,snapshot:{time:0,SECRET:'SNAPSHOT MUST NOT ENTER SUMMARY'}}));
  let input;
  await compactKnowledge(state,{...options,settings:{contextTokenLimit:50},messages,target:'narrator',complete:async request=>{input=JSON.parse(request.messages[1].content);return '{"summary":"The first two events and exchanges."}';}});
  assert.deepEqual(input.sources.map(s=>s.record.id),['e0','m0','e1','m1']);assert.ok(!JSON.stringify(input).includes('SNAPSHOT MUST NOT ENTER SUMMARY'));
  assert.equal(state.narratorMemory.through,2);assert.equal(state.narratorMemory.throughMessageId,'m1');assert.equal(state.narratorMemory.throughMessages,2);assert.equal(state.events.length,3);assert.equal(messages.length,3);
  const request=JSON.parse(buildRequest(state,messages,{},'narrator')[0].content);assert.deepEqual(request.events.map(e=>e.id),['e2']);assert.deepEqual(request.conversation.map(m=>m.id),['m2']);
});

test('legacy event-only memories retain unsummarized conversation, and message-count fallback respects prior prefixes',async()=>{
  const state=createInitialState({});state.narratorMemory={through:1,summary:'Legacy earlier event.'};state.events=[{id:'old',time:0},{id:'current',time:2}];
  const messages=[{id:'m0',role:'narrator',text:'Old prose still unsummarized.',storyTime:0,eventCount:1},{id:'m1',role:'narrator',text:'New prose.',storyTime:2,eventCount:2}];
  let input;
  await compactKnowledge(state,{...options,messages,target:'narrator',complete:async request=>{input=JSON.parse(request.messages[1].content);return '{"summary":"Combined legacy and prose."}';}});
  assert.equal(input.existingSummary,'Legacy earlier event.');assert.deepEqual(input.sources.map(s=>s.record.id),['m0','current']);assert.equal(state.narratorMemory.throughMessageId,'m0');
  const fallback=createInitialState({});fallback.narratorMemory={through:0,throughMessages:1,summary:'Earlier message.'};
  const more=[...messages,{id:'m2',role:'narrator',text:'Third prose.',storyTime:3,eventCount:0}];
  await compactKnowledge(fallback,{...options,settings:{contextTokenLimit:20},messages:more,target:'narrator',complete:async request=>{const p=JSON.parse(request.messages[1].content);assert.equal(p.sources[0].record.id,'m1');return '{"summary":"Extended message memory."}';}});
  assert.equal(fallback.narratorMemory.throughMessages,2);assert.equal(fallback.narratorMemory.throughMessageId,'m1');
});

test('over-budget fixed context and unsuccessful one-pass compaction fail clearly without committing memories or retrying',async()=>{
  const state=memoryWorld(),original=structuredClone(state),ada=state.characters[1];let calls=0;
  await assert.rejects(compactKnowledge(state,{...options,settings:{contextTokenLimit:30,fixedTokens:25},target:ada.id,complete:async()=>{calls++;return '{"summary":"Valid but insufficient."}';}}),error=>error.code==='CONTEXT_LIMIT'&&/still too large/.test(error.message));
  assert.equal(calls,1);assert.deepEqual(state,original);
  state.characters[1].knowledge=[];
  await assert.rejects(compactKnowledge(state,{...options,settings:{contextTokenLimit:30,fixedTokens:100},target:ada.id,complete:async()=>{throw new Error('Must not call with no dynamic context.');}}),error=>error.code==='CONTEXT_LIMIT'&&/no older observation/.test(error.message));
});
