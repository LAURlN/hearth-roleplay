import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,runTurn,applyAuthoredMessage,characterContext} from '../src/engine.mjs';
import {syncVisuals,correctVisuals,refreshVisualWitnesses} from '../src/visuals.mjs';

const settings={chatModel:'actor-model',helperModel:'helper-model',maxResponders:3,contextMessages:24};
const profile='A tall traveller, 188 cm, with black hair, a blue coat and a star tattoo hidden under a sleeve. Secretly owns the cafe.';
function initial() {return createInitialState({location:'room',persona:{name:'Pat',description:profile},characters:[{name:'Ada',location:'room'},{name:'Ben',location:'hall'}]});}
const person=(state,name)=>state.characters.find(c=>c.name===name);
const current=(state,name)=>characterContext(state,person(state,name).id).nearby.find(c=>c.id==='player');
const patch=(source,key,layer,text,visible)=>({key,layer,text,visible,sourceId:source.id,excerpt:source.text});
function scripted({plan,act,onVisual}={}) {
  const calls=[];
  const complete=async request=>{
    calls.push(request);
    const system=request.messages[0].content,data=JSON.parse(request.messages[1].content);
    if(system.includes('CHARACTER VISUAL STATE')) {
      assert.equal(request.model,'helper-model');
      if(onVisual){const result=onVisual(data);if(result)return JSON.stringify(result);}
      const seed=data.sources.find(s=>s.kind==='profile'&&s.characterId==='player');
      if(seed)return JSON.stringify({patches:[{characterId:'player',set:[patch(seed,'height','physical','188 cm','tall'),patch(seed,'hair','physical','black hair','black hair'),patch(seed,'coat','presentation','blue coat','blue coat'),patch(seed,'tattoo','physical','star tattoo','')],remove:[]}]});
      const red=data.sources.find(s=>s.text==='I replace my blue coat with a red coat.');
      if(red)return JSON.stringify({patches:[{characterId:'player',set:[patch(red,'coat','presentation','red coat','red coat')],remove:[]}]});
      const hood=data.sources.find(s=>s.text==='I pull up my hood.');
      if(hood)return JSON.stringify({patches:[{characterId:'player',set:[patch(hood,'hood','presentation','raised hood','raised hood'),patch(hood,'hair','physical','black hair','')],remove:[]}]});
      return '{"patches":[]}';
    }
    if(system.includes('PLAYER PLACEMENT RESOLVER'))return '{"correction":null,"placements":[]}';
    if(system.includes('private input interpreter')){assert.equal(request.model,'helper-model');return JSON.stringify({segments:[{kind:'action',text:data.input}],allowMajorTimeSkip:false});}
    assert.equal(request.model,'actor-model');
    if(system.includes('omniscient narrator/planner'))return JSON.stringify(plan?plan(data):{events:[],speakers:[],text:'The room is quiet.'});
    if(system.includes('You play ONLY'))return JSON.stringify(act?act(data):{text:'Hello.',privateState:'',movement:null});
    if(system.includes('A human has authored an edited'))return JSON.stringify({events:[{type:'movement',characterId:data.message.characterId,destination:data.message.text,mode:'authored',reason:'Authored departure.'}],allowMajorTimeSkip:false});
    if(system.includes('brief player-visible pause'))return '{"text":"A quiet pause."}';
    throw new Error('Unexpected test call');
  };
  return {complete,calls};
}
async function turn(state,provider,input=null,extra={}){return runTurn({state,input,complete:provider.complete,settings,...extra});}

test('initial visual extraction separates actual body features from perceptible descriptions and records sources',async()=>{
  const state=initial(),provider=scripted();
  const result=await turn(state,provider);
  const player=person(result.state,'Pat'),ada=person(result.state,'Ada'),ben=person(result.state,'Ben');
  assert.equal(player.visual.facts.find(f=>f.key==='tattoo').text,'star tattoo');
  assert.equal(player.visual.facts.find(f=>f.key==='height').source.excerpt,profile);
  const nearby=current(result.state,'Ada');
  assert.match(nearby.appearance,/black hair/);assert.match(nearby.appearance,/blue coat/);assert.match(nearby.appearance,/tall/);
  const context=JSON.stringify(characterContext(result.state,ada.id));
  for(const secret of ['188 cm','star tattoo','Secretly owns'])assert.ok(!context.includes(secret),secret);
  assert.ok(!ben.seenAppearance?.player);assert.ok(ada.seenAppearance.player);
  assert.equal(state.characters[0].visual,undefined);
  assert.ok(result.state.events.some(e=>e.type==='visual_change'));
});

test('clothing changes and concealment resolve before the next actor, without refreshing absent observers',async()=>{
  const start=await turn(initial(),scripted());
  const ada=person(start.state,'Ada');
  const provider=scripted({plan:()=>({events:[],speakers:[ada.id],text:''}),act:({context})=>{
    assert.match(context.nearby.find(c=>c.id==='player').appearance,/red coat/);
    assert.ok(!context.nearby.find(c=>c.id==='player').appearance.includes('blue coat'));
    return {text:'Nice coat.',privateState:'',movement:null};
  }});
  const red=await turn(start.state,provider,'I replace my blue coat with a red coat.');
  assert.match(red.messages[0].snapshot.characters[0].appearance,/red coat/);
  assert.equal(start.state.characters[0].visual.facts.find(f=>f.key==='coat').text,'blue coat');
  const left=await applyAuthoredMessage({state:red.state,settings,complete:scripted().complete,message:{role:'character',characterId:ada.id,text:'hall'}});
  const covered=await turn(left.state,scripted(),'I pull up my hood.');
  const remembered=person(covered.state,'Ada').seenAppearance.player;
  assert.ok(remembered.current.some(f=>f.text==='black hair'));
  assert.ok(!covered.state.characters[0].appearance.includes('black hair'));
  const returned=await applyAuthoredMessage({state:covered.state,settings,complete:scripted().complete,message:{role:'character',characterId:ada.id,text:'room'}});
  const view=current(returned.state,'Ada');
  assert.match(view.appearance,/raised hood/);assert.ok(!view.appearance.includes('black hair'));
  assert.ok(view.rememberedAppearance.some(f=>f.text==='black hair'));
  assert.ok(!person(returned.state,'Ben').seenAppearance?.player);
});

test('a multi-fact visibility change is delivered atomically and a later arrival cannot learn concealed facts',async()=>{
  const result=await turn(initial(),scripted());
  const state=structuredClone(result.state),ada=person(state,'Ada');
  // A newly arrived observer has no earlier view of the uncovered hair.
  delete ada.seenAppearance;ada.knowledge=[];
  const source={id:'hood',kind:'action',text:'I pull up my hood.',channel:'local',recipients:[ada.id],time:0};
  const env={visualGenerate:async(_instruction,_data,validate)=>{const output={patches:[{characterId:'player',set:[patch(source,'hood','presentation','raised hood','raised hood'),patch(source,'hair','physical','black hair','')],remove:[]}]};validate(output);return output;}};
  await syncVisuals(state,env,{sources:[source]});
  assert.ok(!JSON.stringify(characterContext(state,ada.id)).includes('black hair'));
  const ben=person(state,'Ben');ben.location='room';refreshVisualWitnesses(state);
  assert.ok(!JSON.stringify(characterContext(state,ben.id)).includes('black hair'));
  assert.ok(!JSON.stringify(characterContext(state,ben.id)).includes('star tattoo'));
});

test('unsourced helper changes fail atomically with one correction and no mutation',async()=>{
  const state=(await turn(initial(),scripted())).state,baseline=structuredClone(state);
  let invalidCalls=0;
  const provider=scripted({onVisual:data=>{invalidCalls++;return {patches:[{characterId:'player',set:[{key:'coat',layer:'presentation',text:'purple coat',visible:'purple coat',sourceId:'invented',excerpt:'invented'}]}]};}});
  await assert.rejects(turn(state,provider,'I pull up my hood.'),/exact supplied source/);
  assert.equal(invalidCalls,2);assert.deepEqual(state,baseline);
});

test('hidden physical facts remain private after manual corrections and corrections do not mutate earlier states',async()=>{
  const original=(await turn(initial(),scripted())).state,state=structuredClone(original);
  correctVisuals(state,'player',[{key:'hair',layer:'physical',text:'green hair',visible:'hair covered by a cap'},{key:'tattoo',layer:'physical',text:'a secret tattoo',visible:''}]);
  assert.match(current(state,'Ada').appearance,/cap/);
  const other=JSON.stringify(characterContext(state,person(state,'Ada').id));
  assert.ok(!other.includes('green hair'));assert.ok(!other.includes('secret tattoo'));
  assert.equal(original.characters[0].visual.facts.find(f=>f.key==='hair').text,'black hair');
  assert.ok(state.events.some(e=>e.type==='visual_correction'));
});

test('timed appearance changes retain intermediate witnesses instead of using final presence',async()=>{
  const state=(await turn(initial(),scripted())).state,ada=person(state,'Ada'),ben=person(state,'Ben');
  ada.location='hall';ben.location='road';state.time=120;
  const early={id:'early',kind:'resolved event',text:'Pat puts on a red coat.',time:10,channel:'local',location:'room',recipients:[ada.id]};
  const late={id:'late',kind:'resolved event',text:'Pat changes into a green coat.',time:60,channel:'local',location:'room',recipients:[ben.id]};
  const env={visualGenerate:async(_instruction,_data,validate)=>{const output={patches:[{characterId:'player',set:[patch(early,'coat','presentation','red coat','red coat'),patch(late,'coat','presentation','green coat','green coat')],remove:[]}]};validate(output);return output;}};
  await syncVisuals(state,env,{sources:[early,late]});
  assert.match(ada.seenAppearance.player.current.find(f=>f.key==='coat').text,/red/);
  assert.equal(ada.seenAppearance.player.time,10);assert.equal(ada.seenAppearance.player.location,'room');
  assert.match(ben.seenAppearance.player.current.find(f=>f.key==='coat').text,/green/);
  assert.match(state.characters[0].appearance,/green/);
  assert.ok(!ada.knowledge.some(k=>k.source==='visual perception'&&k.text.includes('green coat')));
});

test('private thought input and quoted wishes cannot become visual-update source material',async()=>{
  const state=(await turn(initial(),scripted())).state,provider=scripted();
  const input='"I wish I had purple hair." [THOUGHT: I want a secret tattoo.]';
  const actual=provider.complete;
  provider.complete=async request=>request.messages[0].content.includes('private input interpreter')?JSON.stringify({segments:[{kind:'speech',text:'"I wish I had purple hair."'},{kind:'thought',text:'[THOUGHT: I want a secret tattoo.]'}],allowMajorTimeSkip:false}):actual(request);
  const result=await turn(state,provider,input);
  const sources=provider.calls.filter(r=>r.messages[0].content.includes('CHARACTER VISUAL STATE')).flatMap(r=>JSON.parse(r.messages[1].content).sources);
  assert.ok(!JSON.stringify(sources).includes('purple hair'));assert.ok(!JSON.stringify(sources).includes('secret tattoo'));
  assert.equal(result.state.characters[0].visual.facts.find(f=>f.key==='hair').text,'black hair');
});

test('a blind observer does not learn visual details merely from sharing the location',async()=>{
  const state=initial(),ada=person(state,'Ada');ada.description='Ada is blind.';
  const provider=scripted({onVisual:data=>{
    const seed=data.sources.find(s=>s.kind==='profile'&&s.characterId==='player');
    const blindness=data.sources.find(s=>s.kind==='profile'&&s.characterId===ada.id);
    if(seed&&blindness)return {patches:[{characterId:'player',set:[patch(seed,'hair','physical','black hair','black hair')],remove:[]},{characterId:ada.id,set:[],remove:[],sight:{enabled:false,sourceId:blindness.id,excerpt:blindness.text}}]};
  }});
  const result=await turn(state,provider);
  assert.equal(current(result.state,'Ada').appearance,'');
  assert.equal(characterContext(result.state,ada.id).character.visual.canSee,false);
  assert.ok(!person(result.state,'Ada').knowledge.some(k=>k.source==='visual perception'));
  assert.ok(!JSON.stringify(characterContext(result.state,ada.id)).includes(profile));
});

test('restoring sight during a skipped interval uses witnesses at that boundary, before later departure',async()=>{
  const state=(await turn(initial(),scripted())).state,ada=person(state,'Ada');
  ada.visual.canSee=false;ada.location='hall';delete ada.seenAppearance;ada.knowledge=[];state.time=120;
  const source={id:'eyes',kind:'resolved event',text:'Ada removes her blindfold in the room.',time:10,location:'room',channel:'local',recipients:[ada.id,'player']};
  const env={visualGenerate:async(_instruction,_data,validate)=>{const result={patches:[{characterId:ada.id,set:[],remove:[],sight:{enabled:true,sourceId:source.id,excerpt:source.text}}]};validate(result);return result;}};
  await syncVisuals(state,env,{sources:[source]});
  assert.match(ada.seenAppearance.player.current.find(f=>f.key==='coat').text,/blue coat/);
  assert.equal(ada.seenAppearance.player.time,10);assert.equal(ada.seenAppearance.player.location,'room');
});

test('an intermediate visit during a time skip records appearance even when the encounter changes no visual facts',async()=>{
  const seed=initial();person(seed,'Ada').location='hall';
  const state=(await turn(seed,scripted())).state,ada=person(state,'Ada');
  assert.ok(!ada.seenAppearance?.player);
  state.pending=[
    {type:'observation',at:5,location:'room',text:'Pat puts on a red coat.'},
    {type:'movement',at:10,characterId:ada.id,destination:'room',mode:'external',reason:'An external displacement.'},
    {type:'movement',at:15,characterId:ada.id,destination:'hall',mode:'external',reason:'An external displacement.'},
    {type:'observation',at:20,location:'room',text:'Pat changes into a green coat.'},
  ];
  const provider=scripted({plan:()=>({events:[{type:'time',minutes:30}],speakers:[],text:'Half an hour passes.'}),onVisual:data=>{
    const red=data.sources.find(s=>s.text==='Pat puts on a red coat.'),green=data.sources.find(s=>s.text==='Pat changes into a green coat.');
    if(red&&green)return {patches:[{characterId:'player',set:[patch(red,'coat','presentation','red coat','red coat'),patch(green,'coat','presentation','green coat','green coat')]}]};
  }});
  const result=await turn(state,provider),visitor=person(result.state,'Ada');
  assert.match(visitor.seenAppearance?.player?.current.find(f=>f.key==='coat')?.text??'',/red coat/);
  assert.ok(!JSON.stringify(visitor.seenAppearance).includes('green coat'));
  assert.equal(visitor.location,'hall');assert.equal(result.state.time,30);
  assert.match(result.state.characters[0].appearance,/green coat/);
});

test('legacy visual evidence merges narration and events by time and equal-time checkpoint boundary',async()=>{
  for(const [olderTime,newerTime] of [[5,10],[0,0]]){
    const state=initial();state.time=newerTime;
    state.events=[{id:'green-event',type:'observation',time:newerTime,text:'Pat changes into a green coat.',location:'room',recipients:['player',person(state,'Ada').id],localBroadcast:true}];
    const history=[{id:'red-message',role:'narrator',text:'Pat puts on a red coat.',storyTime:olderTime,eventCount:0}];
    const provider=scripted({onVisual:data=>{
      const red=data.sources.find(s=>s.id==='message:red-message'),green=data.sources.find(s=>s.id==='event:green-event');
      // The helper correctly returns chronological changes even when the input
      // evidence was originally concatenated in the wrong order.
      if(red&&green)return {patches:[{characterId:'player',set:[patch(red,'coat','presentation','red coat','red coat'),patch(green,'coat','presentation','green coat','green coat')]}]};
    }});
    const result=await turn(state,provider,null,{messages:history});
    assert.match(result.state.characters[0].appearance,/green coat/,`Narration at ${olderTime}, event at ${newerTime}`);
  }
});
