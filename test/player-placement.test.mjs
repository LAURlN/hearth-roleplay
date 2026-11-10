import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,runTurn} from '../src/engine.mjs';

const settings={chatModel:'actor-model',helperModel:'helper-model',contextMessages:24,maxResponders:3};
const person=(state,name)=>state.characters.find(c=>c.name===name);
const known=character=>character.knowledge.map(k=>k.text).join('\n');
function world(){return createInitialState({location:'atrium',persona:{name:'Pat'},characters:[{name:'Ada',location:'reading nook'},{name:'Cy',location:'side corridor'},{name:'Ben',location:'side corridor'}]});}
function provider({interpret,placement,plan,actor,movement}={}){
  const calls=[];
  const complete=async request=>{
    calls.push(request);
    const system=request.messages[0].content,data=JSON.parse(request.messages[1].content);
    if(system.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    if(system.includes('PLAYER PLACEMENT RESOLVER')){assert.equal(request.model,'helper-model');return JSON.stringify(placement?placement(data):{correction:null,placements:[]});}
    if(system.includes('private input interpreter'))return JSON.stringify(interpret?interpret(data):{segments:[{kind:'action',text:data.input}],allowMajorTimeSkip:false});
    if(system.includes('omniscient narrator/planner'))return JSON.stringify(plan?plan(data):{events:[],speakers:[],text:'The room is quiet.'});
    if(system.includes('You play ONLY'))return JSON.stringify(actor(data));
    if(system.includes('resolving feasibility'))return JSON.stringify(movement?movement(data):{allowed:true,text:'Cy steps into the reading nook.',reason:'An open passage connects the rooms.'});
    if(system.includes('brief player-visible pause'))return '{"text":"A quiet moment passes."}';
    throw new Error('Unexpected fixture request');
  };
  return {complete,calls};
}
const run=(state,p,input=null,messages=[])=>runTurn({state,settings,complete:p.complete,input,messages});

test('an authored object interaction resolves implicit placement before dialogue and the next actor context',async()=>{
  const state=world(),ada=person(state,'Ada');
  const action='I settle onto the window bench.',ooc='[OOC: Keep this quiet.]',speech='"Still thinking."';
  const input=`${action} ${ooc} ${speech}`;
  const p=provider({interpret:()=>({segments:[{kind:'action',text:action},{kind:'ooc',text:ooc},{kind:'speech',text:speech,recipients:[ada.id]}],allowMajorTimeSkip:false}),placement:data=>{
    assert.equal(data.world.location,'atrium');assert.equal(data.actions[0].text,action);
    return {correction:null,placements:[{index:0,destination:'reading nook',excerpt:action}]};
  },plan:data=>{assert.equal(data.world.location,'reading nook');return {events:[],text:'Sunlight falls over the books.',speakers:[ada.id]};},actor:({context})=>{
    assert.equal(context.location,'reading nook');assert.ok(context.nearby.some(c=>c.id==='player'));
    assert.match(known(context),/Still thinking/);assert.ok(!JSON.stringify(context).includes('Keep this quiet'));
    return {text:'Ada nods. "Take your time."',privateState:'',movement:null,channel:'local',recipients:[]};
  }});
  const result=await run(state,p,input);
  assert.equal(result.state.location,'reading nook');assert.equal(result.messages[0].snapshot.location,'reading nook');
  assert.equal(result.messages[0].segments[0].placementResolved,true);
  assert.equal(result.messages.filter(m=>m.role==='character').length,1);
  assert.equal(p.calls.filter(c=>c.messages[0].content.includes('You play ONLY')).length,1);
  assert.equal(state.location,'atrium');
});

test('addressed speech validates presence after legacy repair and still rejects an actually absent recipient',async()=>{
  const state=world(),ada=person(state,'Ada'),input='"Good morning."';
  const action='I settle onto the window bench.';
  const history=[{id:'old-seat',role:'player',text:action,segments:[{kind:'action',text:action}],eventCount:0}];
  const interpret=()=>({segments:[{kind:'speech',text:input,recipients:[ada.id]}],allowMajorTimeSkip:false});
  const p=provider({interpret,placement:data=>({correction:{destination:'reading nook',sourceId:data.priorActions[0].id,excerpt:action},placements:[]})});
  const result=await run(state,p,input,history);
  assert.match(known(person(result.state,'Ada')),/Good morning/);
  assert.deepEqual(result.messages[0].segments[0].recipients,[ada.id]);
  await assert.rejects(run(state,provider({interpret}),input),/local recipient is absent/);
  assert.equal(state.location,'atrium');
});

test('legacy action lookup distinguishes a later observable action from identical text inside a thought',async()=>{
  const state=world(),action='I sit on the window bench.',thought=`[THOUGHT: ${action}]`;
  const history=[{id:'repeated-seat',role:'player',text:`${thought} ${action}`,segments:[{kind:'thought',text:thought},{kind:'action',text:action}],eventCount:0}];
  const p=provider({placement:data=>{
    assert.equal(data.priorActions.length,1);assert.equal(data.priorActions[0].id,'repeated-seat:action:1');
    return {correction:{destination:'reading nook',sourceId:data.priorActions[0].id,excerpt:action},placements:[]};
  }});
  const result=await run(state,p,null,history);assert.equal(result.state.location,'reading nook');
});

test('continuing an old inconsistent save repairs presence without replaying old speech, while off-scene actors can approach naturally',async()=>{
  const state=world(),ada=person(state,'Ada'),cy=person(state,'Cy'),ben=person(state,'Ben');
  const action='I settle onto the window bench.',oldSpeech='"The coded phrase is lavender."';
  const history=[{id:'layout',role:'narrator',text:'A window bench stands in the reading nook.',storyTime:0,eventCount:0},{id:'old-player',role:'player',text:`${oldSpeech} ${action}`,segments:[{kind:'speech',text:oldSpeech},{kind:'action',text:action}],storyTime:0,eventCount:0}];
  const p=provider({placement:data=>({correction:{destination:'reading nook',sourceId:data.priorActions.find(s=>s.text===action).id,excerpt:action},placements:[]}),plan:data=>{
    assert.equal(data.world.location,'reading nook');
    return {events:[],text:'Light rests on the shelves.',speakers:[cy.id,ada.id]};
  },actor:({context})=>{
    if(context.character.id===cy.id)return {text:'Cy checks the latch and mutters a private reminder.',privateState:'I choose to join the others.',channel:'local',recipients:[ben.id],movement:{destination:'reading nook',reason:'Join the conversation.',when:'after'}};
    assert.equal(context.character.id,ada.id);assert.ok(context.nearby.some(c=>c.id==='player'));
    assert.ok(!JSON.stringify(context).includes('lavender'));assert.ok(!JSON.stringify(context).includes('private reminder'));
    return {text:'Ada greets the newcomer.',privateState:'',movement:null,channel:'local',recipients:[]};
  }});
  const result=await run(state,p,null,history);
  assert.equal(result.state.location,'reading nook');assert.equal(person(result.state,'Cy').location,'reading nook');
  assert.ok(result.state.events.some(e=>e.type==='placement_correction'));
  assert.ok(!result.state.events.some(e=>e.type==='movement'&&e.characterId==='player'));
  assert.ok(result.messages.some(m=>m.text==='Cy steps into the reading nook.'));
  assert.ok(result.messages.some(m=>m.role==='character'&&m.text==='Ada greets the newcomer.'));
  assert.ok(!result.messages.some(m=>m.text.includes('private reminder')));
  assert.match(known(person(result.state,'Ben')),/private reminder/);
  assert.ok(!known(result.state.characters[0]).includes('private reminder'));
  assert.equal(p.calls.filter(c=>c.messages[0].content.includes('You play ONLY')).length,2);
  const next=provider({placement:()=>{throw new Error('Already reviewed placement should not be queried again.');}});
  await run(result.state,next,null,[...history,...result.messages]);
  assert.equal(state.location,'atrium');
});

test('off-scene local speech remains with its actual witnesses and never gets displayed to the player',async()=>{
  const state=world(),cy=person(state,'Cy'),ben=person(state,'Ben');
  const p=provider({plan:()=>({events:[],speakers:[cy.id],text:'The atrium is still.'}),actor:()=>({text:'A quiet corridor conversation.',privateState:'',movement:null,channel:'local',recipients:[]})});
  const result=await run(state,p);
  assert.match(known(person(result.state,'Cy')),/corridor conversation/);assert.match(known(person(result.state,'Ben')),/corridor conversation/);
  assert.ok(!known(result.state.characters[0]).includes('corridor conversation'));
  assert.ok(!result.messages.some(m=>m.role==='character'));
  assert.equal(p.calls.filter(c=>c.messages[0].content.includes('You play ONLY')).length,1);
});

test('private spans and spoken suggestions cannot be used as placement evidence',async()=>{
  for(const kind of ['thought','ooc','speech']){
    const state=world(),input=kind==='thought'?'[THOUGHT: I enter the reading nook.]':kind==='ooc'?'[OOC: The reading nook exists.]':'"Shall we visit the reading nook?"';
    const p=provider({interpret:()=>({segments:[{kind,text:input}],allowMajorTimeSkip:false}),placement:()=>{throw new Error('No observable action to place.');}});
    const result=await run(state,p,input);assert.equal(result.state.location,'atrium');
  }
  const state=world(),input='[THOUGHT: I enter the nook.] I scratch my chin.';
  const p=provider({interpret:()=>({segments:[{kind:'thought',text:'[THOUGHT: I enter the nook.]'},{kind:'action',text:'I scratch my chin.'}],allowMajorTimeSkip:false}),placement:()=>({correction:null,placements:[{index:0,destination:'reading nook',excerpt:'I enter the nook.'}]})});
  await assert.rejects(run(state,p,input),/permitted observable action/);
  assert.equal(state.location,'atrium');
});

test('continuity recovery cannot undo a subsequent established player movement',async()=>{
  const state=world();state.events=[{id:'later-move',type:'movement',characterId:'player',from:'reading nook',destination:'atrium',time:0,reason:'External displacement.'}];
  const history=[{id:'old-seat',role:'player',text:'I sit on the bench.',segments:[{kind:'action',text:'I sit on the bench.'}],eventCount:0,storyTime:0}];
  const p=provider({placement:()=>{throw new Error('A later established move takes precedence.');}});
  const result=await run(state,p,null,history);assert.equal(result.state.location,'atrium');
  assert.ok(!result.state.events.some(e=>e.type==='placement_correction'));
});
