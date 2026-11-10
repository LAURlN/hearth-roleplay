import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,runTurn,characterContext} from '../src/engine.mjs';
import {semanticReply} from './helpers/semantic-fixture.mjs';

const settings={chatModel:'text-model',helperModel:'small-model',chatEffort:'high',characterEffort:'medium',helperEffort:'low',maxResponders:4,contextMessages:24};
const known=person=>person.knowledge.map(k=>k.text).join('\n');
const find=(state,name)=>state.characters.find(c=>c.name===name);
const views=world=>world.characters.map(c=>({observerId:c.id,subjects:[]}));
function world(){return createInitialState({location:'park path',persona:{name:'Pat'},characters:[{name:'Ada',location:'park path'},{name:'Cy',location:'bushes beside the path'}]});}
function provider({plan,perception,schedule,actor,awareness,interpret,visual}={}){
  const calls=[];
  const complete=async request=>{
    calls.push(request);const system=request.messages[0].content,data=JSON.parse(request.messages[1].content);
    let result;
    if(system.includes('PERCEPTION HELPER'))result=perception?perception(data,request):JSON.parse(semanticReply(request));
    else if(system.includes('REACTIVE TURN SCHEDULER'))result=schedule?schedule(data,request):JSON.parse(semanticReply(request));
    else if(system.includes('PUBLIC AWARENESS HELPER'))result=awareness?awareness(data,request):JSON.parse(semanticReply(request));
    else if(system.includes('CHARACTER VISUAL STATE'))result=visual?visual(data):{patches:[]};
    else if(system.includes('PLAYER PLACEMENT RESOLVER'))result={correction:null,placements:[]};
    else if(system.includes('private input interpreter'))result=interpret?interpret(data):{segments:[{kind:'action',text:data.input}],allowMajorTimeSkip:false};
    else if(system.includes('omniscient narrator/planner'))result=plan?plan(data):{events:[],text:'A quiet park.',speakers:[]};
    else if(system.includes('You play ONLY'))result=actor(data,request);
    else if(system.includes('brief player-visible pause'))result={text:'The moment settles.'};
    else throw new Error('Unexpected scripted stage');
    return JSON.stringify(result);
  };
  return {complete,calls};
}
const run=(state,p,input=null,messages=[])=>runTurn({state,settings,complete:p.complete,input,messages});

test('a helper carries a call across nearby locations without exposing unseen actions, and scheduling yields to the player',async()=>{
  const state=world(),ada=find(state,'Ada'),cy=find(state,'Cy');
  const speech='"Hello? I need help."',full=`Cy pulls a blue scarf over her arm behind the bushes. ${speech}`;
  const p=provider({plan:()=>({events:[],text:'Leaves stir beside the path.',speakers:[ada.id,cy.id]}),schedule:({called})=>({nextCharacterId:called.length?null:cy.id,yieldToPlayer:called.length>0,reason:called.length?'The player can answer the call.':'The nearby call interrupts the suggested order.'}),perception:data=>({deliveries:data.event?.characterId===cy.id?[{characterId:'player',text:`A voice calls from the bushes: ${speech}`,excerpts:[speech],speaker:'An unseen voice'}]:[],views:views(data.world)}),actor:({context},request)=>{
    assert.equal(context.character.id,cy.id);assert.equal(request.reasoningEffort,'medium');
    return {text:full,privateState:'SECRET PRIVATE MOTIVE',movement:null,recipients:[]};
  }});
  const result=await run(state,p);
  const delivered=result.messages.find(m=>m.role==='character');
  assert.equal(delivered.speaker,'An unseen voice');assert.ok(delivered.text.includes(speech));assert.ok(!delivered.text.includes('scarf'));
  assert.ok(!known(find(result.state,'Pat')).includes('scarf'));assert.ok(!known(ada).includes('Hello'));
  assert.equal(p.calls.filter(c=>c.messages[0].content.includes('You play ONLY')).length,1);
  assert.equal(result.state.location,'park path');assert.equal(find(result.state,'Cy').location,'bushes beside the path');
  const source=result.state.events.find(e=>e.characterId===cy.id&&e.type==='observation');
  assert.deepEqual(source.recipients.sort(),['player',cy.id].sort());assert.equal(source.perceptions[0].text,delivered.text);
  for(const request of p.calls){const system=request.messages[0].content;if(/PERCEPTION HELPER|REACTIVE TURN SCHEDULER/.test(system)){assert.equal(request.model,'small-model');assert.equal(request.reasoningEffort,'low');}else if(system.includes('omniscient narrator'))assert.equal(request.reasoningEffort,'high');}
  assert.equal(state.events.length,0);
});

test('a character selected outside narrator suggestions sees the preceding permitted observation, never the unseen full action',async()=>{
  const state=world(),ada=find(state,'Ada'),cy=find(state,'Cy');
  const p=provider({plan:()=>({events:[],text:'A pause.',speakers:[cy.id]}),schedule:({called})=>({nextCharacterId:called.length===0?cy.id:called.length===1?ada.id:null,yieldToPlayer:false,reason:'React to the newly heard call.'}),perception:data=>({deliveries:data.event?.characterId===cy.id?[{characterId:ada.id,text:'Someone calls "Help!" nearby.',excerpts:['"Help!"'],speaker:'A voice'}]:[],views:views(data.world)}),actor:({context})=>{
    if(context.character.id===cy.id)return {text:'Cy kneels behind a log. "Help!"',privateState:'PRIVATE CAUSE',movement:null};
    assert.match(known(context),/Help!/);assert.ok(!JSON.stringify(context).includes('kneels'));assert.ok(!JSON.stringify(context).includes('PRIVATE CAUSE'));
    return {text:'Ada listens.',privateState:'',movement:null};
  }});
  const result=await run(state,p);assert.match(known(find(result.state,'Ada')),/Help!/);assert.ok(!known(find(result.state,'Pat')).includes('Help!'));
});

test('co-location does not force full perception: indistinct speech can become sound without the secret words',async()=>{
  const state=world(),ada=find(state,'Ada');
  const p=provider({plan:()=>({events:[],text:'Wind moves through the park.',speakers:[ada.id]}),perception:data=>({deliveries:data.event?[{characterId:'player',text:'A few muffled words are lost in the wind.',excerpts:['"The code is violet."'],speaker:'A muffled voice'}]:[],views:views(data.world)}),actor:()=>({text:'"The code is violet."',privateState:'',movement:null})});
  const result=await run(state,p);assert.ok(!known(find(result.state,'Pat')).includes('violet'));assert.ok(!JSON.stringify(characterContext(result.state,find(result.state,'Cy').id)).includes('violet'));
  assert.ok(!JSON.stringify(result.messages.filter(m=>m.role==='character').map(m=>m.text)).includes('violet'));
});

test('a malformed helper cannot widen a whisper audience or cite a different event; failures remain atomic',async()=>{
  for(const bad of ['audience','citation']){
    const state=world(),ada=find(state,'Ada'),cy=find(state,'Cy');cy.location='park path';
    const p=provider({plan:()=>({events:[],text:'A pause.',speakers:[ada.id]}),actor:()=>({text:'"A private note."',privateState:'',recipients:[cy.id],movement:null}),perception:data=>({deliveries:data.event?[{characterId:bad==='audience'?'player':cy.id,text:'A private note.',excerpts:[bad==='citation'?'not in this event':'A private note.'],speaker:'Ada'}]:[],views:views(data.world)})});
    await assert.rejects(run(state,p),bad==='audience'?/restricted audience/:/cite this event/);assert.equal(state.events.length,0);
  }
});

test('helper-selected sight can cross labels, with only approved visible detail keys and no automatic co-located view',async()=>{
  const state=world(),ada=find(state,'Ada'),cy=find(state,'Cy');
  for(const person of state.characters)person.visual={initialized:true,revision:0,facts:person.id===cy.id?[{key:'coat',layer:'presentation',text:'a red coat',visible:'a red coat'},{key:'tattoo',layer:'physical',text:'secret tattoo',visible:''}]:[]};
  const p=provider({perception:data=>({deliveries:[],views:data.world.characters.map(c=>({observerId:c.id,subjects:c.id==='player'?[{characterId:cy.id,keys:['coat']}]:[]}))})});
  const result=await run(state,p),context=characterContext(result.state,ada.id);
  assert.deepEqual(context.nearby,[]);assert.match(find(result.state,'Pat').seenAppearance[cy.id].current[0].text,/red coat/);
  assert.ok(!JSON.stringify(find(result.state,'Pat').seenAppearance).includes('secret tattoo'));
});

test('public awareness is a helper decision at historical opportunities, including before expiry in a long skip',async()=>{
  const state=world(),ada=find(state,'Ada');ada.location='cabin overlooking the coast';
  const p=provider({interpret:({input})=>({segments:[{kind:'ooc',text:input}],allowMajorTimeSkip:true,timeSkipEvidence:input}),plan:()=>({text:'Later that day.',speakers:[],events:[{type:'publication',text:'A storm warning is broadcast.',source:'coast radio',audience:{type:'regional',locations:['coastal area']},expiresAt:180},{type:'time',minutes:480}]}),awareness:data=>({decisions:data.candidates.map(c=>({key:c.key,aware:c.characterId===ada.id&&data.world.time>=60,reason:'The resident heard the warning over the radio before it expired.'}))})});
  const result=await run(state,p,'Skip eight hours.');const learned=find(result.state,'Ada').knowledge.find(k=>k.publicationId);
  assert.equal(learned.time,60);assert.equal(result.state.time,480);
  assert.ok(Object.values(result.state.exposureDecisions).includes(false));assert.ok(Object.values(result.state.exposureDecisions).includes(true));
  assert.ok(p.calls.some(c=>c.messages[0].content.includes('PUBLIC AWARENESS HELPER')));
});

test('historical sight decisions retain an intermediate outfit during a visit and exclude its later replacement',async()=>{
  const state=world(),ada=find(state,'Ada');ada.location='road';
  const p=provider({plan:()=>({text:'A short while later.',speakers:[],events:[{type:'observation',at:5,text:'Pat puts on a red coat.',location:'park path'},{type:'movement',at:10,characterId:ada.id,destination:'park path',mode:'external',reason:'A moving walkway carries her here.'},{type:'movement',at:15,characterId:ada.id,destination:'road',mode:'external',reason:'The walkway carries her away.'},{type:'observation',at:20,text:'Pat puts on a green coat.',location:'park path'},{type:'time',minutes:10}]}),visual:data=>({patches:data.sources.filter(s=>s.text.includes('puts on')).map(s=>({characterId:'player',set:[{key:'coat',layer:'presentation',text:s.text.includes('green')?'green coat':'red coat',visible:s.text.includes('green')?'green coat':'red coat',sourceId:s.id,excerpt:s.text}],remove:[]}))})});
  const result=await run(state,p),memory=find(result.state,'Ada').seenAppearance.player;
  assert.match(memory.current[0].text,/red coat/);assert.ok(!JSON.stringify(memory).includes('green coat'));assert.match(result.state.characters[0].appearance,/green coat/);
});

test('a same-minute pending event never enters the helper context for an earlier event in the batch',async()=>{
  const state=world(),ada=find(state,'Ada');
  state.pending=[{type:'observation',at:10,text:'First event.',characterId:ada.id,location:'park path'},{type:'observation',at:10,text:'LATER SECRET EVENT',characterId:ada.id,location:'park path'}];
  let checked=false;
  const p=provider({plan:()=>({events:[{type:'time',minutes:20}],text:'Time passes.',speakers:[]}),perception:(data,request)=>{
    if(data.event?.text==='First event.'){checked=true;assert.ok(!JSON.stringify(data.world).includes('LATER SECRET EVENT'));}
    return JSON.parse(semanticReply(request));
  }});
  await run(state,p);assert.ok(checked);
});

test('rewinding to a saved pre-call checkpoint removes derived perceptions and visibility without changing the old continuation',async()=>{
  const state=world();const before=(await run(state,provider())).messages.at(-1).snapshot;
  const cy=find(before,'Cy');
  const p=provider({plan:()=>({events:[],text:'Leaves stir.',speakers:[cy.id]}),actor:()=>({text:'"Help!"',privateState:'',movement:null}),perception:data=>({deliveries:data.event?[{characterId:'player',text:'An unseen voice calls "Help!"',excerpts:['"Help!"'],speaker:'A voice'}]:[],views:views(data.world)})});
  const original=await run(before,p);assert.match(known(find(original.state,'Pat')),/Help!/);
  const revised=await run(before,provider());assert.ok(!known(find(revised.state,'Pat')).includes('Help!'));
  assert.ok(!JSON.stringify(revised.state.events).includes('Help!'));assert.match(known(find(original.state,'Pat')),/Help!/);
});

test('pending observations keep their own time and rewind checkpoints without later knowledge',async()=>{
  const state=world();state.pending=[{type:'observation',at:5,text:'A bell rings.',location:'park path'},{type:'observation',at:10,text:'A LATER PASSWORD is spoken.',location:'park path'}];
  const result=await run(state,provider({plan:()=>({events:[{type:'time',minutes:20}],text:'',speakers:[]})}));
  const first=result.messages.find(m=>m.text==='A bell rings.');assert.equal(first.storyTime,5);assert.equal(first.snapshot.time,5);
  assert.ok(!JSON.stringify(first.snapshot.events).includes('A LATER PASSWORD'));assert.ok(!known(find(first.snapshot,'Pat')).includes('A LATER PASSWORD'));
  assert.ok(first.snapshot.pending.some(e=>e.text==='A LATER PASSWORD is spoken.'));
  assert.deepEqual(result.state.events.slice(0,first.eventCount),first.snapshot.events);
  assert.equal(result.state.time,20);assert.match(known(find(result.state,'Pat')),/A LATER PASSWORD/);
  const resumed=await run(first.snapshot,provider({plan:()=>({events:[{type:'time',minutes:5}],text:'',speakers:[]})}));
  assert.equal(resumed.state.time,10);assert.equal(find(resumed.state,'Pat').knowledge.filter(k=>k.text==='A LATER PASSWORD is spoken.').length,1);
});

test('an event patch already in the snapshot does not overwrite a newer narration visual in a survey',async()=>{
  const state=world();const p=provider({plan:()=>({events:[{type:'observation',text:'Pat puts on a red coat.',location:'park path'}],text:'Pat changes into a green coat.',speakers:[]}),visual:data=>({patches:data.sources.filter(s=>s.text.includes('coat')).map(s=>({characterId:'player',set:[{key:'coat',layer:'presentation',text:s.text.includes('green')?'green coat':'red coat',visible:s.text.includes('green')?'green coat':'red coat',sourceId:s.id,excerpt:s.text}],remove:[]}))})});
  const result=await run(state,p);assert.match(result.state.characters[0].appearance,/green/);assert.match(find(result.state,'Ada').seenAppearance.player.current[0].text,/green/);
});

test('a later blindfold does not erase sight at an earlier pending boundary',async()=>{
  const state=world(),ada=find(state,'Ada');
  state.characters[0].visual={initialized:true,revision:0,facts:[{key:'coat',layer:'presentation',text:'red coat',visible:'red coat'}]};
  state.pending=[{type:'observation',at:5,text:'A bell rings.',location:'park path'},{type:'observation',at:10,text:'Ada puts on a blindfold.',location:'park path'}];
  const p=provider({plan:()=>({events:[{type:'time',minutes:20}],text:'',speakers:[]}),perception:(data,request)=>{
    const result=JSON.parse(semanticReply(request));if(!data.event)result.views=views(data.world);return result;
  },visual:data=>({patches:data.sources.filter(s=>s.text.includes('blindfold')).map(s=>({characterId:ada.id,set:[],remove:[],sight:{enabled:false,sourceId:s.id,excerpt:s.text}}))})});
  const result=await run(state,p),memory=find(result.state,'Ada').seenAppearance?.player;
  assert.ok(memory);assert.match(memory.current[0].text,/red coat/);assert.equal(memory.time,5);assert.equal(find(result.state,'Ada').visual.canSee,false);
});

test('narrator-planned phone observations addressed to the player appear in the transcript',async()=>{
  const state=world(),p=provider({plan:()=>({events:[{type:'observation',channel:'phone',recipients:['player'],text:'Your appointment is cancelled.'}],text:'',speakers:[]})});
  const result=await run(state,p);assert.ok(result.messages.some(m=>m.text==='Your appointment is cancelled.'));assert.match(known(find(result.state,'Pat')),/appointment is cancelled/);
});

test('a helper speaker label cannot reveal a protected private fragment',async()=>{
  const state=world(),ada=find(state,'Ada');state.privateInputs=['PRIVATE ROOT FRAGMENT'];
  const p=provider({plan:()=>({events:[],text:'A pause.',speakers:[ada.id]}),actor:()=>({text:'Hello.',privateState:'',movement:null}),perception:data=>({deliveries:data.event?[{characterId:'player',text:'Hello.',excerpts:['Hello.'],speaker:'PRIVATE ROOT FRAGMENT'}]:[],views:views(data.world)})});
  await assert.rejects(run(state,p),/Private player content/);assert.equal(state.events.length,0);
});

test('authored-source permission does not let transformed helper text or labels disclose an unrelated thought',async()=>{
  for(const field of ['text','speaker']){
    const state=world(),input='"Hello." [THOUGHT: PRIVATE CURRENT FRAGMENT]';
    const p=provider({interpret:()=>({segments:[{kind:'speech',text:'"Hello."'},{kind:'thought',text:'[THOUGHT: PRIVATE CURRENT FRAGMENT]'}],allowMajorTimeSkip:false}),perception:data=>({deliveries:data.event?[{characterId:find(state,'Ada').id,text:field==='text'?'PRIVATE CURRENT FRAGMENT':'Hello.',excerpts:['Hello.'],speaker:field==='speaker'?'PRIVATE CURRENT FRAGMENT':'Pat'}]:[],views:views(data.world)})});
    await assert.rejects(run(state,p,input),/Private player content/);assert.equal(state.events.length,0);
  }
});
