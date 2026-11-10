import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,runTurn,applyAuthoredMessage,applyVisualCorrection,buildContextRequest,characterContext} from '../src/engine.mjs';
import {countMessages} from '../src/tokens.mjs';
import {narratorProjection} from '../src/memory.mjs';
import {semanticReply} from './helpers/semantic-fixture.mjs';

const settings={chatModel:'test-model',helperModel:'helper-model',maxResponders:3,contextTokenLimit:300000};
const world=()=>createInitialState({location:'courtyard',persona:{name:'Pat',description:'A traveller in a coat.'},characters:[{name:'Ada',location:'courtyard'}]});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function scripted({input,visual,perception,plan,actor,edit,movement,onRequest}={}){
  const calls=[];
  const complete=async request=>{
    calls.push(request);onRequest?.(request);const system=request.messages[0].content,data=JSON.parse(request.messages[1].content);
    if(system.includes('private input interpreter'))return JSON.stringify(await (input?input(data,request):{segments:[{kind:'action',text:data.input}],correction:null,allowMajorTimeSkip:false}));
    if(system.includes('CHARACTER VISUAL STATE'))return JSON.stringify(await (visual?visual(data,request):{patches:[]}));
    if(system.includes('PERCEPTION HELPER')&&perception)return JSON.stringify(perception(data,request));
    const semantic=semanticReply(request);if(semantic!==null)return semantic;
    if(system.includes('omniscient narrator/planner'))return JSON.stringify(plan?plan(data):{events:[],text:'The courtyard is quiet.',speakers:[]});
    if(system.includes('You play ONLY'))return JSON.stringify(actor?actor(data):{text:'Hello.',privateState:'',movement:null});
    if(system.includes('independent movement helper'))return JSON.stringify(movement(data));
    if(system.includes('A human has authored an edited'))return JSON.stringify(edit(data));
    if(system.includes('Summarize ONLY')||system.includes('private continuity notes'))return '{"summary":"An earlier conversation took place in the courtyard."}';
    if(system.includes('PLAYER PLACEMENT RESOLVER'))return '{"correction":null}';
    if(system.includes('brief player-visible pause'))return '{"text":"A quiet moment passes."}';
    throw new Error('Unexpected request');
  };
  return {complete,calls};
}

test('input preparation overlaps visual work, uses a frozen checkpoint, and needs no second placement request',async()=>{
  const state=world(),gate=deferred(),visualEntered=deferred();let inputStarted=false;
  const p=scripted({input:data=>{inputStarted=true;assert.equal(data.state.characters[0].visual,undefined);return {segments:[{kind:'action',text:data.input,destination:'courtyard alcove',destinationEvidence:data.input}],correction:null,allowMajorTimeSkip:false};},visual:async()=>{visualEntered.resolve();await gate.promise;return {patches:[]};}});
  const pending=runTurn({state,settings,complete:p.complete,input:'I sit in the courtyard alcove.'});
  try{await visualEntered.promise;assert.equal(inputStarted,true);}finally{gate.resolve();}
  const result=await pending;assert.equal(result.state.location,'courtyard alcove');assert.equal(state.location,'courtyard');
  assert.equal(p.calls.filter(r=>r.messages[0].content.includes('private input interpreter')).length,1);
  assert.equal(p.calls.filter(r=>r.messages[0].content.includes('PLAYER PLACEMENT RESOLVER')).length,0);
});

test('a failed startup request cancels and drains its sibling before returning without state changes',async()=>{
  const state=world(),before=structuredClone(state);let drained=false;
  const p=scripted({input:async(_data,request)=>{
    try{await new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));}
    finally{drained=true;}
  },visual:()=>{throw new Error('Visual startup failed');}});
  await assert.rejects(runTurn({state,settings,complete:p.complete,input:'I wave.'}),error=>error.message==='Visual startup failed'&&error.stage==='Updating appearance');
  assert.equal(drained,true);assert.deepEqual(state,before);
});

test('narrator history is complete below budget even with a legacy message limit setting',async()=>{
  const state=world(),messages=Array.from({length:75},(_,i)=>({id:`passage-${i}`,role:'narrator',text:`Established detail ${i}.`,storyTime:0,eventCount:0}));
  const p=scripted({plan:data=>{assert.equal(data.history.length,75);assert.equal(data.history[0].text,'Established detail 0.');return {events:[],text:'A new moment.',speakers:[]};}});
  await runTurn({state,messages,settings:{...settings,contextMessages:8},complete:p.complete,input:null});
  assert.equal(p.calls.filter(r=>r.messages[0].content.includes('private continuity notes')).length,0);
});

test('token-triggered narrator compaction replaces only an older prefix and counts the actual assembled request',async()=>{
  const state=world(),messages=Array.from({length:45},(_,i)=>({id:`old-${i}`,role:'narrator',text:`Moment ${i}: `+'A traveller talks about the garden and the weather. '.repeat(50),storyTime:0,eventCount:0}));
  const baseline=countMessages(buildContextRequest(state,[],settings)).tokens;
  const full=countMessages(buildContextRequest(state,messages,settings)).tokens;
  const config={...settings,contextTokenLimit:baseline+Math.floor((full-baseline)/2)};
  const original=structuredClone(messages);let counted;
  const p=scripted({plan:data=>{
    assert.ok(data.world.narratorMemory.summary);assert.ok(data.history.length>0&&data.history.length<messages.length);
    assert.equal(data.history.at(-1).id,'old-44');assert.ok(!data.history.some(m=>m.id==='old-0'));
    return {events:[],text:'The next moment.',speakers:[]};
  },onRequest:request=>{if(request.messages[0].content.includes('omniscient narrator/planner')){
    const prepared=structuredClone(request.messages),data=JSON.parse(prepared[1].content);data.world=narratorProjection(data.world);prepared[1].content=JSON.stringify(data);
    counted=countMessages(prepared).tokens;
  }}});
  const result=await runTurn({state,messages,settings:config,complete:p.complete,input:null});
  assert.ok(counted<config.contextTokenLimit);assert.equal(p.calls.filter(r=>r.messages[0].content.includes('private continuity notes')).length,1);
  assert.deepEqual(messages,original);assert.ok(result.state.narratorMemory.throughMessageId);assert.equal(state.narratorMemory,undefined);
});

test('newly perceived appearance facts produce visible narration after their knowledge is committed',async()=>{
  const state=world(),ada=state.characters[1];
  for(const c of state.characters)c.visual={initialized:true,revision:0,facts:c.id===ada.id?[{key:'coat',layer:'presentation',text:'red coat',visible:'red coat'}]:[]};
  const p=scripted({perception:(data,request)=>{
    const result=JSON.parse(semanticReply(request));
    if(!data.previousPlayerViews[ada.id]?.current?.some(f=>f.key==='coat'))result.description={text:'The visitor wears a red coat.',evidence:[{characterId:ada.id,key:'coat',excerpt:'red coat'}]};
    return result;
  }});
  const result=await runTurn({state,settings,complete:p.complete,input:null}),passage=result.messages.find(m=>m.text==='The visitor wears a red coat.');
  assert.ok(passage);assert.equal(passage.snapshot.characters[0].seenAppearance[ada.id].current[0].text,'red coat');
  assert.equal(result.messages.filter(m=>m.text==='The visitor wears a red coat.').length,1);
});

function movementWorld(){
  const state=createInitialState({location:'yard',persona:{name:'Pat'},characters:[{name:'Ada',location:'yard'},{name:'Bea',location:'hall'},{name:'Cy',location:'gallery'}]});
  state.locations.push('hall','gallery');
  for(const c of state.characters)c.visual={initialized:true,revision:0,facts:c.name==='Ada'?[{key:'coat',layer:'presentation',text:'a red coat',visible:'a red coat'}]:[]};
  return state;
}
function departureDescription(ada){
  return (data,request)=>{
    const result=JSON.parse(semanticReply(request));
    // The first survey has no sight line; the departure opens it briefly.
    if(!data.event)result.views.find(v=>v.observerId==='player').subjects=[];
    if(data.event?.text==='Pat leaves yard.'||data.event?.text==='Ada leaves yard.'){
      result.views.find(v=>v.observerId==='player').subjects=[{characterId:ada.id,keys:['coat']}];
      result.description={text:'The visitor wears a red coat.',evidence:[{characterId:ada.id,key:'coat',excerpt:'a red coat'}]};
    }
    return result;
  };
}
function assertResolvedCheckpoint(passage){
  for(const event of passage.snapshot.events.filter(e=>e.type==='observation'&&(e.channel||'local')==='local')){
    assert.ok(Array.isArray(event.perceptions),`Unresolved observation: ${event.text}`);
    for(const delivery of event.perceptions){
      assert.ok(event.recipients.includes(delivery.characterId));
      assert.ok(passage.snapshot.characters.find(c=>c.id===delivery.characterId).knowledge.some(k=>k.eventId===event.id&&k.text===delivery.text));
    }
  }
}

for(const multiple of [false,true])test(`player appearance checkpoints follow their source and finish queued deliveries${multiple?' across sequential actions':''}`,async()=>{
  const state=movementWorld(),ada=state.characters[1],bea=state.characters[2];
  const first='I enter the hall.',second=' I enter the gallery.',input=first+(multiple?second:'');
  const segments=[{kind:'action',text:first,destination:'hall',destinationEvidence:first},...(multiple?[{kind:'action',text:second,destination:'gallery',destinationEvidence:second}]:[])];
  const perceive=departureDescription(ada);
  const p=scripted({input:()=>({segments,correction:null,allowMajorTimeSkip:false}),perception:(data,request)=>{
    if(data.event?.text==='Pat leaves hall.'){
      assert.ok(data.world.characters.find(c=>c.id===bea.id).knowledge.some(k=>k.text===first));
      assert.ok(!data.world.characters.find(c=>c.name==='Cy').knowledge.some(k=>k.text===first));
    }
    return perceive(data,request);
  }});
  const result=await runTurn({state,settings,complete:p.complete,input});
  const appearance=result.messages.find(m=>m.appearanceDescription),source=result.messages.findIndex(m=>m.role==='player');
  assert.ok(result.messages.indexOf(appearance)>source);
  assertResolvedCheckpoint(appearance);
  assert.equal(appearance.snapshot.location,multiple?'gallery':'hall');
  assert.ok(appearance.snapshot.characters.find(c=>c.id===bea.id).knowledge.some(k=>k.text===first));
  const rewind=scripted({plan:({world})=>{
    assert.ok(world.characters.find(c=>c.id===bea.id).knowledge.some(k=>k.text===first));
    return {events:[],text:'A pause.',speakers:[]};
  }});
  await runTurn({state:appearance.snapshot,messages:result.messages.slice(0,result.messages.indexOf(appearance)+1),settings,complete:rewind.complete,input:null});
});

for(const path of ['narrator','before','after','edit'])test(`appearance checkpoints finish movement observations on the ${path} path`,async()=>{
  const state=movementWorld(),ada=state.characters[1],bea=state.characters[2];
  const movement={type:'movement',characterId:ada.id,destination:'hall',mode:path==='edit'?'authored':'external',reason:'The open passage permits the crossing.',text:'Ada enters the hall.'};
  const p=scripted({perception:departureDescription(ada),
    plan:()=>({events:path==='narrator'?[movement]:[],text:'',speakers:path==='before'||path==='after'?[ada.id]:[]}),
    actor:()=>({text:'',privateState:'',movement:{destination:'hall',reason:'I want to visit the hall.',when:path}}),
    movement:()=>({allowed:true,text:movement.text,reason:movement.reason}),
    edit:()=>({events:[movement],allowMajorTimeSkip:false}),
  });
  const result=path==='edit'?await applyAuthoredMessage({state,settings,complete:p.complete,message:{role:'character',characterId:ada.id,speaker:'An unseen voice',text:'Ada enters the hall.'}}):await runTurn({state,settings,complete:p.complete,input:null});
  const appearance=result.messages.find(m=>m.appearanceDescription);
  assert.ok(appearance);assertResolvedCheckpoint(appearance);
  assert.equal(appearance.snapshot.characters.find(c=>c.id===ada.id).location,'hall');
  assert.ok(appearance.snapshot.characters.find(c=>c.id===bea.id).knowledge.some(k=>k.text===movement.text));
  const source=result.messages.findIndex(m=>path==='edit'?m.role==='character':m.sourceEventId&&m.text==='Ada leaves yard.');
  assert.ok(source>=0&&source<result.messages.indexOf(appearance));
});

test('startup appearance notices retain narrator attribution when an edited character has a custom speaker',async()=>{
  const state=movementWorld(),ada=state.characters[1],text='A short greeting.';
  const p=scripted({perception:(data,request)=>{
    const result=JSON.parse(semanticReply(request));
    if(!data.previousPlayerViews[ada.id]?.current?.length)result.description={text:'A visitor wears a red coat.',evidence:[{characterId:ada.id,key:'coat',excerpt:'a red coat'}]};
    return result;
  },edit:()=>({events:[],allowMajorTimeSkip:false})});
  const result=await applyAuthoredMessage({state,settings,complete:p.complete,message:{role:'character',characterId:ada.id,speaker:'An unseen voice',text}});
  assert.equal(result.messages[0].speaker,'Narrator');
  assert.equal(result.messages[0].appearanceDescription.evidence[0].key,'coat');
  const authored=result.messages.find(m=>m.role==='character');
  assert.equal(authored.text,text);assert.equal(authored.speaker,'An unseen voice');
});

test('visual correction appearance checkpoints follow the correction source',async()=>{
  const state=movementWorld(),ada=state.characters[1];
  const p=scripted({perception:(data,request)=>{
    const result=JSON.parse(semanticReply(request)),coat=data.visualSubjects.find(c=>c.id===ada.id).facts.find(f=>f.key==='coat');
    if(coat.text==='a green coat')result.description={text:'A visitor wears a green coat.',evidence:[{characterId:ada.id,key:'coat',excerpt:coat.text}]};
    return result;
  }});
  const result=await applyVisualCorrection({state,settings,complete:p.complete,characterId:ada.id,facts:[{key:'coat',layer:'presentation',text:'a green coat',visible:'a green coat'}]});
  const source=result.messages.findIndex(m=>m.visualCorrection),appearance=result.messages.find(m=>m.appearanceDescription);
  assert.ok(source>=0&&source<result.messages.indexOf(appearance));assertResolvedCheckpoint(appearance);
});

test('pending movement appearance checkpoints retain later scheduled events at their own time',async()=>{
  const state=movementWorld(),ada=state.characters[1];
  state.pending=[
    {type:'movement',at:5,characterId:ada.id,destination:'hall',mode:'external',reason:'An open passage.',text:'Ada enters the hall.'},
    {type:'observation',at:8,location:'hall',text:'A bell rings.'},
  ];
  const p=scripted({perception:departureDescription(ada),plan:()=>({events:[{type:'time',minutes:10}],text:'',speakers:[]})});
  const result=await runTurn({state,settings,complete:p.complete,input:null}),appearance=result.messages.find(m=>m.appearanceDescription);
  assertResolvedCheckpoint(appearance);assert.equal(appearance.snapshot.time,5);
  assert.equal(appearance.snapshot.pending.length,1);assert.equal(appearance.snapshot.pending[0].at,8);
  assert.ok(!appearance.snapshot.events.some(e=>e.text==='A bell rings.'));
  const rewind=scripted({plan:()=>({events:[{type:'time',minutes:5}],text:'',speakers:[]})});
  const resumed=await runTurn({state:appearance.snapshot,messages:result.messages.slice(0,result.messages.indexOf(appearance)+1),settings,complete:rewind.complete,input:null});
  assert.equal(resumed.state.pending.length,0);
  assert.ok(resumed.state.characters.find(c=>c.name==='Bea').knowledge.some(k=>k.text==='A bell rings.'));
});

for(const path of ['narrator','character','edited narrator'])test(`appearance descriptions follow the ${path} prose that establishes them`,async()=>{
  const state=movementWorld(),ada=state.characters[1],text='The visitor puts on a green coat.';
  const p=scripted({visual:data=>({patches:[{characterId:ada.id,set:[{key:'coat',layer:'presentation',text:'a green coat',visible:'a green coat',sourceId:data.sources[0].id,excerpt:text}]}]}),
    perception:(data,request)=>{
      const result=JSON.parse(semanticReply(request));
      if(!data.previousPlayerViews[ada.id]?.current?.length&&data.visualSubjects.find(c=>c.id===ada.id).facts.some(f=>f.text==='a green coat'))result.description={text:'A visitor wears a green coat.',evidence:[{characterId:ada.id,key:'coat',excerpt:'a green coat'}]};
      return result;
    },
    plan:()=>({events:[],text:path==='narrator'?text:'',speakers:path==='character'?[ada.id]:[]}),
    actor:()=>({text,privateState:'',movement:null}),edit:()=>({events:[],allowMajorTimeSkip:false}),
  });
  // A sight-line change lets the new outfit, rather than the startup coat,
  // supply the first evidenced description.
  ada.visual.facts=[];
  const result=path==='edited narrator'?await applyAuthoredMessage({state,settings,complete:p.complete,message:{role:'narrator',speaker:'Stage voice',text}}):await runTurn({state,settings,complete:p.complete,input:null});
  const source=result.messages.findIndex(m=>m.text===text),appearance=result.messages.find(m=>m.appearanceDescription);
  assert.ok(appearance);assert.ok(source>=0&&source<result.messages.indexOf(appearance));assertResolvedCheckpoint(appearance);
  if(path==='edited narrator')assert.equal(result.messages[source].speaker,'Stage voice');
});

test('characters retain their full permitted observations below their independent token budget',async()=>{
  const state=world(),ada=state.characters[1];ada.knowledge=Array.from({length:400},(_,i)=>({id:`memory-${i}`,text:`Own observation ${i}.`,time:0,source:'personal experience'}));
  const p=scripted({plan:()=>({events:[],text:'A pause.',speakers:[ada.id]}),actor:({context})=>{assert.equal(context.knowledge.length,400);assert.equal(context.knowledge[0].text,'Own observation 0.');return {text:'I remember.',privateState:'',movement:null};}});
  await runTurn({state,settings,complete:p.complete,input:null});
  assert.equal(p.calls.filter(r=>r.messages[0].content.includes('Summarize ONLY')).length,0);
});

test('narrator prefix compression does not duplicate archived observations or compact another character perspective',()=>{
  const state=world(),ada=state.characters[1];
  state.events=[{id:'old-event',type:'observation',time:0,text:'An older event.'},{id:'new-event',type:'observation',time:1,text:'A new event.'}];
  ada.knowledge=[{id:'old-note',eventId:'old-event',text:'An older personal observation.'},{id:'new-note',eventId:'new-event',text:'A new personal observation.'},{id:'unlinked',text:'A personal background fact.'}];
  state.narratorMemory={summary:'The earlier event and its witnesses.',through:1};
  const projected=narratorProjection(state);
  assert.deepEqual(projected.characters[1].knowledge.map(k=>k.id),['new-note','unlinked']);
  assert.equal(characterContext(state,ada.id).knowledge.length,3);assert.equal(ada.memory,undefined);
});
