import test from 'node:test';
import assert from 'node:assert/strict';
import {createSemantics} from '../src/semantics.mjs';
import {applyPerceivedViews} from '../src/visuals.mjs';

function fixture(responses){
  const state={time:0,timeLabel:'Afternoon',location:'courtyard',locations:['courtyard'],perceptionMode:'helper',events:[],publications:[],exposureDecisions:{},sharedBackground:[],privateInputs:[],characters:[
    {id:'player',name:'Pat',location:'courtyard',knowledge:[],online:{access:false},visual:{initialized:true,revision:0,facts:[]}},
    {id:'visitor',name:'Ada',location:'courtyard',knowledge:[],online:{access:false},visual:{initialized:true,revision:0,facts:[{key:'coat',layer:'presentation',text:'a red coat',visible:'a red coat'},{key:'tattoo',layer:'physical',text:'a concealed tattoo',visible:''}]}},
  ]};
  const calls=[],descriptions=[];let nextId=0;
  const env={settings:{},history:[],onPerceivedDescription:(text,metadata)=>descriptions.push({text,metadata,snapshot:structuredClone(state)})};
  const generate=async(_env,stage,instruction,payload,validate)=>{
    calls.push({stage,instruction,payload});assert.ok(responses.length,'Unexpected helper request');
    const next=responses.shift(),result=typeof next==='function'?next(payload):next;validate(result);return result;
  };
  const remember=(_state,recipient,text,source,eventId,time)=>state.characters.find(c=>c.id===recipient).knowledge.push({text,source,eventId,time});
  const log=(_state,event)=>{const entry={...event,id:`event-${nextId++}`,time:state.time};state.events.push(entry);return entry;};
  const assertObservable=(world,text)=>{for(const hidden of world.privateInputs||[])if(text.includes(hidden))throw new Error('Private fragment cannot be described.');};
  const semantics=createSemantics(state,env,{generate,remember,log,assertObservable,applyViews:applyPerceivedViews});
  return {state,semantics,calls,descriptions};
}
const views=(visible=true)=>[{observerId:'player',subjects:visible?[{characterId:'visitor',keys:['coat']}]:[]},{observerId:'visitor',subjects:[]}];
const description=(color='red')=>({text:`The visitor wears a ${color} coat.`,evidence:[{characterId:'visitor',key:'coat',excerpt:`a ${color} coat`}]});
const survey=(detail=description(),visible=true)=>({deliveries:[],views:views(visible),description:detail});

test('a first approved visual encounter emits evidenced player prose after committing visual knowledge',async()=>{
  const f=fixture([survey()]);f.semantics.survey();await f.semantics.flush();
  assert.equal(f.descriptions.length,1);assert.equal(f.descriptions[0].text,'The visitor wears a red coat.');
  const player=f.descriptions[0].snapshot.characters[0];
  assert.deepEqual(player.visibleCharacters,['visitor']);assert.equal(player.seenAppearance.visitor.current[0].text,'a red coat');
  assert.ok(player.knowledge.some(k=>k.appearanceOf==='visitor'&&k.text.includes('red coat')));
  assert.deepEqual(f.descriptions[0].metadata.evidence,description().evidence);
  assert.ok(!JSON.stringify({text:f.descriptions[0].text,metadata:f.descriptions[0].metadata,knowledge:player.knowledge}).includes('concealed tattoo'));
});

test('unchanged views need no repeated prose and a repeated-only description is rejected',async()=>{
  const f=fixture([survey(),survey(null),survey()]);
  f.semantics.survey();await f.semantics.flush();
  f.semantics.survey();await f.semantics.flush();assert.equal(f.descriptions.length,1);
  f.semantics.survey();await assert.rejects(f.semantics.flush(),/newly perceived or changed/);
  assert.equal(f.descriptions.length,1);
});

test('looking away retains only source-supported audible delivery and emits no unseen clothing description',async()=>{
  const raw='The visitor changes coats behind a screen. "Ready."';
  const f=fixture([{deliveries:[{characterId:'player',text:'A nearby voice says, "Ready."',speaker:'A voice',excerpts:['"Ready."']}],views:views(false),description:null}]);
  const event={id:'clothes',type:'observation',location:'courtyard',text:raw,characterId:'visitor',recipients:['visitor'],time:0};
  f.state.events.push(event);f.semantics.queue(event);await f.semantics.flush();
  assert.deepEqual(f.descriptions,[]);assert.deepEqual(f.state.characters[0].visibleCharacters,[]);
  assert.equal(f.state.characters[0].knowledge.length,1);assert.ok(!f.state.characters[0].knowledge[0].text.includes('coat'));
  assert.equal(event.perceptions[0].text,'A nearby voice says, "Ready."');
});

test('hidden, unapproved or falsely cited appearance facts cannot enter player descriptions',async()=>{
  for(const evidence of [{characterId:'visitor',key:'tattoo',excerpt:'a concealed tattoo'},{characterId:'visitor',key:'coat',excerpt:'a blue coat'}]){
    const f=fixture([survey({text:'A purported appearance.',evidence:[evidence]})]);
    f.semantics.survey();await assert.rejects(f.semantics.flush(),/approved currently visible detail/);
    assert.equal(f.descriptions.length,0);assert.equal(f.state.characters[0].knowledge.length,0);
  }
  const f=fixture([survey(description(),false)]);f.semantics.survey();await assert.rejects(f.semantics.flush(),/approved currently visible detail/);
  assert.equal(f.descriptions.length,0);
});

test('private fragments in transformed appearance prose reject before knowledge or callbacks change',async()=>{
  const f=fixture([survey({...description(),text:'PRIVATE SECRET appears in the description.'})]);
  f.state.privateInputs=['PRIVATE SECRET'];f.semantics.survey();await assert.rejects(f.semantics.flush(),/Private fragment/);
  assert.equal(f.descriptions.length,0);assert.equal(f.state.characters[0].knowledge.length,0);
});

test('a changed approved presentation permits a fresh description without discarding remembered appearance',async()=>{
  const f=fixture([survey(),payload=>{assert.equal(payload.previousPlayerViews.visitor.current[0].text,'a red coat');return survey(description('green'));}]);
  f.semantics.survey();await f.semantics.flush();
  const visitor=f.state.characters[1];visitor.visual.facts[0]={...visitor.visual.facts[0],text:'a green coat',visible:'a green coat'};visitor.visual.revision++;
  f.state.time=5;f.semantics.survey();await f.semantics.flush();
  assert.equal(f.descriptions.length,2);assert.equal(f.descriptions[1].text,'The visitor wears a green coat.');
  assert.equal(f.state.characters[0].seenAppearance.visitor.current[0].text,'a green coat');
  assert.equal(f.descriptions[0].snapshot.characters[0].seenAppearance.visitor.current[0].text,'a red coat');
});

test('perception preserves supported visible gestures rather than replacing them with a dialogue summary',async()=>{
  const raw='Ada folds the map, glances at the gate and smiles. "This way."';
  const f=fixture([{deliveries:[{characterId:'player',text:raw,speaker:'The visitor',excerpts:[raw]}],views:views(),description:null}]);
  const event={id:'gesture',type:'observation',location:'courtyard',text:raw,characterId:'visitor',recipients:['visitor'],time:0};
  f.state.events.push(event);f.semantics.queue(event);await f.semantics.flush();
  assert.equal(event.perceptions[0].text,raw);assert.equal(f.state.characters[0].knowledge.find(k=>k.eventId==='gesture').text,raw);
  assert.match(f.calls[0].instruction,/perspective filter, not a summarizer/);
});
