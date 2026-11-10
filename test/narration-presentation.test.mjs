import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,runTurn,applyAuthoredMessage} from '../src/engine.mjs';
import {semanticReply} from './helpers/semantic-fixture.mjs';

const settings={chatModel:'story-model',helperModel:'helper-model',maxResponders:0};
const world=()=>createInitialState({location:'wet path',persona:{name:'Pat'},characters:[{name:'Ada',location:'station platform'}]});
const knowledge=person=>person.knowledge.map(k=>k.text).join('\n');
const views=world=>world.characters.map(c=>({observerId:c.id,subjects:[]}));
const presentation=text=>({text,excerpts:text?[text]:[]});
function provider(plan,perception){
  const calls=[];
  const complete=async request=>{
    calls.push(request);
    const system=request.messages[0].content,data=JSON.parse(request.messages[1].content);
    if(system.includes('PERCEPTION HELPER'))return JSON.stringify(perception?perception(data):{
      ...JSON.parse(semanticReply(request)),
      ...(data.presentationContext?{presentation:presentation(data.event?data.event.text:data.presentationContext.candidate)}:{}),
    });
    if(system.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    if(system.includes('PLAYER PLACEMENT RESOLVER'))return '{"correction":null}';
    if(system.includes('omniscient narrator/planner'))return JSON.stringify(plan);
    if(system.includes('A human has authored an edited'))return '{"events":[],"allowMajorTimeSkip":false}';
    if(system.includes('brief player-visible pause'))return '{"text":"A pause."}';
    throw new Error(`Unexpected stage: ${request.stage}`);
  };
  return {complete,calls};
}
const run=(state,p,extra={})=>runTurn({state,settings,complete:p.complete,input:null,...extra});

test('one audible source and repeated narrator prose have one presentation while observers keep complete knowledge',async()=>{
  const state=world(),ada=state.characters[1];
  const train='A departing train rumbles beyond the trees.';
  const glow='A distant green glow lights the platform.';
  const puddles='Puddles reflect the sky; wet earth scents the path.';
  const plan={events:[
    {type:'observation',location:'station platform',text:`${train} ${glow}`},
    {type:'observation',location:'wet path',text:`${puddles} ${train}`},
  ],speakers:[],text:`${puddles} ${train}`};
  const p=provider(plan,data=>{
    if(!data.event){
      if(data.presentationContext){
        assert.deepEqual(data.presentationContext.alreadyShown,[train,puddles]);
        assert.ok(!JSON.stringify(data.presentationContext.alreadyShown).includes(glow));
        return {deliveries:[],views:views(data.world),presentation:presentation('')};
      }
      return {deliveries:[],views:views(data.world)};
    }
    const first=data.event.location==='station platform';
    if(!first&&data.presentationContext)assert.deepEqual(data.presentationContext.alreadyShown,[train]);
    return {deliveries:[
      {characterId:'player',text:first?train:data.event.text,speaker:'Narrator',excerpts:first?[train]:[puddles,train]},
      ...(first?[{characterId:ada.id,text:data.event.text,speaker:'Narrator',excerpts:[train,glow]}]:[]),
    ],views:views(data.world),presentation:{text:first?train:puddles,excerpts:[first?train:puddles]}};
  });
  const result=await run(state,p);
  assert.deepEqual(result.messages.map(m=>m.text),[train,puddles]);
  assert.equal(result.state.characters[0].knowledge.filter(k=>k.eventId).length,2);
  assert.ok(knowledge(result.state.characters[0]).includes(`${puddles} ${train}`));
  assert.ok(!knowledge(result.state.characters[0]).includes(glow));
  assert.ok(knowledge(result.state.characters[1]).includes(glow));
  assert.ok(!knowledge(result.state.characters[1]).includes(puddles));
  assert.equal(p.calls.filter(c=>c.stage==='Resolving perception').length,4);
  assert.ok(!p.calls.some(c=>c.stage==='Closing the moment'));
  assert.deepEqual(result.messages.at(-1).snapshot,result.state);
});

test('a text-only moment and genuinely additional editorial narration still appear',async()=>{
  for(const events of [[],[{type:'observation',location:'wet path',text:'A bell rings.'}]]){
    const text='The next chapter can wait.';
    const result=await run(world(),provider({events,speakers:[],text}));
    assert.deepEqual(result.messages.map(m=>m.text),[...(events.length?['A bell rings.']:[]),text]);
    assert.ok(result.state.characters.every(c=>!knowledge(c).includes(text)));
  }
});

test('separate timed and pending occurrences keep exact messages and rewind boundaries',async()=>{
  const state=world();
  state.pending=[{type:'observation',at:5,location:'wet path',text:'A bell rings.'},{type:'observation',at:10,location:'wet path',text:'A bell rings again.'}];
  const p=provider({events:[{type:'time',minutes:15}],speakers:[],text:''},data=>{
    assert.equal(data.presentationContext,undefined);
    return {deliveries:data.event?[{characterId:'player',text:data.event.text,speaker:'Narrator',excerpts:[data.event.text]}]:[],views:views(data.world)};
  });
  const result=await run(state,p),first=result.messages.find(m=>m.text==='A bell rings.');
  assert.equal(first.storyTime,5);assert.equal(first.snapshot.time,5);
  assert.ok(!knowledge(first.snapshot.characters[0]).includes('again'));
  assert.equal(first.snapshot.pending[0].at,10);
  assert.ok(result.messages.some(m=>m.text==='A bell rings again.'&&m.storyTime===10));
  const resumed=await run(first.snapshot,provider({events:[{type:'time',minutes:5}],speakers:[],text:''}));
  assert.equal(resumed.state.characters[0].knowledge.filter(k=>k.text==='A bell rings again.').length,1);
});

test('character speech with deliberate repetition and remote observations bypass narrator rewriting',async()=>{
  const state=world(),ada=state.characters[1];
  const speech='"Again, again!" Ada knocks twice.';
  const phone='"Again, again!"';
  const injected={playerPresentation:{text:'UNVALIDATED REPLACEMENT',excerpts:['invented evidence']}};
  const p=provider({events:[{type:'observation',characterId:ada.id,location:ada.location,text:speech,...injected},{type:'observation',channel:'phone',recipients:['player'],text:phone,...injected}],speakers:[],text:''},data=>{
    assert.equal(data.presentationContext,undefined);
    return {deliveries:data.event?[{characterId:'player',text:data.event.text,speaker:'Ada',excerpts:[data.event.text]}]:[],views:views(data.world)};
  });
  const result=await run(state,p);assert.deepEqual(result.messages.map(m=>m.text),[speech,phone]);
  assert.ok(result.state.events.filter(e=>e.type==='observation').every(e=>!e.playerPresentation));
});

test('a new occurrence with identical wording is retained when the semantic helper keeps it',async()=>{
  const text='A knock sounds.';
  const p=provider({events:[{type:'observation',location:'wet path',text},{type:'observation',location:'wet path',text}],speakers:[],text:''});
  const result=await run(world(),p);
  assert.deepEqual(result.messages.map(m=>m.text),[text,text]);
  assert.notEqual(result.messages[0].sourceEventId,result.messages[1].sourceEventId);
  assert.equal(result.messages[0].snapshot.characters[0].knowledge.length,1);
  assert.equal(result.messages[1].snapshot.characters[0].knowledge.length,2);
});

test('a wholly repeated final event uses the existing editorial checkpoint without replaying scenery',async()=>{
  const text='A train passes.';
  let seen=false;
  const p=provider({events:[{type:'observation',location:'wet path',text},{type:'observation',location:'wet path',text}],speakers:[],text:''},data=>{
    if(!data.event)return {deliveries:[],views:views(data.world)};
    const result={deliveries:[{characterId:'player',text,speaker:'Narrator',excerpts:[text]}],views:views(data.world),presentation:presentation(seen?'':text)};seen=true;return result;
  });
  const complete=async request=>{
    if(request.stage==='Closing the moment'){
      const data=JSON.parse(request.messages[1].content);
      assert.deepEqual(data.alreadyPresented,[{role:'narrator',text}]);
      assert.match(request.messages[0].content,/Do not retell or paraphrase/);
    }
    return p.complete(request);
  };
  const result=await run(world(),{complete});
  assert.deepEqual(result.messages.map(m=>m.text),[text,'A pause.']);
  assert.equal(p.calls.filter(c=>c.stage==='Closing the moment').length,1);
  assert.deepEqual(result.messages.at(-1).snapshot,result.state);
});

test('human editorial and OOC text remains verbatim and outside character knowledge',async()=>{
  const state=world(),text='The chapter ends here. [OOC: Keep this exact wording.]';
  const p=provider();
  const result=await applyAuthoredMessage({state,message:{role:'narrator',text},settings,complete:p.complete});
  assert.equal(result.messages[0].text,text);assert.ok(result.state.characters.every(c=>!knowledge(c).includes('chapter')));
});

test('presentation evidence cannot cite hidden event detail instead of the player delivery',async()=>{
  const state=world(),raw='A train passes. HIDDEN OFFSCENE GLOW.';
  const p=provider({events:[{type:'observation',location:'station platform',text:raw}],speakers:[],text:''},data=>({
    deliveries:data.event?[{characterId:'player',text:'A train passes.',speaker:'Narrator',excerpts:['A train passes.']}]:[],views:views(data.world),
    ...(data.event?{presentation:{text:'HIDDEN OFFSCENE GLOW.',excerpts:['HIDDEN OFFSCENE GLOW.']}}:{}),
  }));
  await assert.rejects(run(state,p),/player-visible candidate/);
  assert.equal(state.events.length,0);
});

test('transformed presentation cannot disclose protected player thoughts even with a valid citation',async()=>{
  const state=world();state.privateInputs=['PRIVATE PLAYER MOTIVE'];
  const p=provider({events:[{type:'observation',location:'wet path',text:'A train passes.'}],speakers:[],text:''},data=>({
    deliveries:data.event?[{characterId:'player',text:'A train passes.',speaker:'Narrator',excerpts:['A train passes.']}]:[],views:views(data.world),
    ...(data.event?{presentation:{text:'PRIVATE PLAYER MOTIVE',excerpts:['A train passes.']}}:{}),
  }));
  await assert.rejects(run(state,p),/Private player content/);
  assert.equal(state.events.length,0);
});
