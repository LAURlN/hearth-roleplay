import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,characterContext,buildContextRequest} from '../src/engine.mjs';
import {narratorProjection,modelEventRecords,compactKnowledge,contextUsage} from '../src/memory.mjs';
import {createSemantics} from '../src/semantics.mjs';
import {countMessages} from '../src/tokens.mjs';
import {Illustrator} from '../src/illustrator.mjs';
import {DEFAULT_SETTINGS} from '../src/settings.mjs';

function world(){const state=createInitialState({characters:[{name:'Ada'},{name:'Ben'}]});state.characters[1].id='ada';state.characters[2].id='ben';return state;}
function semantics(state,inspect,env={}){
  return createSemantics(state,env,{
    generate:async(_env,stage,instruction,payload,validate)=>{
      inspect(payload,stage,instruction);
      const result=stage==='Resolving public awareness'?{decisions:payload.candidates.map(c=>({key:c.key,aware:false,reason:'No exposure.'}))}:{deliveries:[],views:payload.world.characters.map(c=>({observerId:c.id,subjects:[]}))};
      validate(result);return result;
    },remember:()=>{},log:(_state,event)=>event,assertObservable:()=>{},applyViews:()=>{},
  });
}

test('semantic historical filtering preserves narrator archives and independent actor prefix offsets',async()=>{
  const state=world(),ada=state.characters[1],ben=state.characters[2];
  state.time=10;state.events=[{id:'old',time:0},{id:'recent',time:10}];
  state.narratorMemory={through:1,summary:'Archived source and its recipients.'};
  ada.memory={through:1,summary:'Independent actor summary.',sourceIds:['compacted']};
  ada.knowledge=[{id:'compacted',time:20},{id:'keep',eventId:'recent',time:10,text:'The audible words only.'},{id:'unlinked',time:0,text:'Own background.'}];
  ben.knowledge=[{id:'archived',eventId:'old',time:0,text:'Archived narrator observation.'},{id:'partial',eventId:'recent',time:10,text:'An indistinct voice.'}];
  const retained=structuredClone(state),seen=[];
  const helper=semantics(state,p=>seen.push(p.world));helper.survey();
  state.events.push({id:'later-same-minute',time:10});
  ada.knowledge.push({id:'later',eventId:'later-same-minute',time:10,text:'Not yet available.'});
  ada.knowledge.push({id:'future',time:11,text:'Future knowledge.'});
  await helper.flush();
  assert.deepEqual(seen[0].events.map(e=>e.id),['recent']);
  assert.deepEqual(seen[0].characters[1].knowledge.map(k=>k.id),['keep','unlinked']);
  assert.deepEqual(seen[0].characters[2].knowledge.map(k=>k.id),['partial']);
  assert.equal(seen[0].characters[2].knowledge[0].text,'An indistinct voice.');
  assert.equal(seen[0].narratorMemory.summary,retained.narratorMemory.summary);
  assert.deepEqual(narratorProjection(seen[0]),seen[0]);
  assert.equal(state.narratorMemory.through,1);assert.equal(ada.memory.through,1);
  assert.equal(characterContext(state,'ada').knowledge[0].id,'keep');
  const rewind=structuredClone(retained);let replay;
  const replayHelper=semantics(rewind,p=>{replay=p.world;});replayHelper.survey();await replayHelper.flush();
  assert.deepEqual(replay,seen[0]);
});

test('exact delivery references retain observer differences, evidence, views and source IDs without mutating originals',()=>{
  const deliveries=[{characterId:'ada',text:'Clear words.',speaker:'A voice',excerpts:['Clear words.']},{characterId:'ben',text:'Indistinct words.',speaker:'Unseen',excerpts:['words.']}];
  const source={id:'source',time:0,text:'Clear words.',perceptions:deliveries};
  const decision={id:'decision',type:'perception_decision',time:0,eventId:'source',deliveries:structuredClone(deliveries),views:[{observerId:'ben',subjects:[]}]};
  const mismatch={...structuredClone(decision),id:'different',deliveries:[{...deliveries[0],speaker:'Recognized Ada'}]};
  const state=world();state.events=[source,decision,mismatch];const saved=structuredClone(state);
  const projected=narratorProjection(state);
  assert.deepEqual(projected.events[1].deliveriesRef,{eventId:'source',field:'perceptions'});
  assert.equal(projected.events[1].deliveries,undefined);
  assert.deepEqual(projected.events[0].perceptions,deliveries);
  assert.deepEqual(projected.events[1].views,decision.views);
  assert.deepEqual(projected.events[2],mismatch);
  assert.deepEqual(narratorProjection(projected),projected);assert.deepEqual(state,saved);
  state.narratorMemory={through:1,summary:'The earlier source.'};
  assert.deepEqual(narratorProjection(state).events[0].deliveries,deliveries,'an archived reference target must retain its full delivery');
  assert.deepEqual(modelEventRecords([decision,source])[0].deliveries,deliveries,'a later source cannot be assumed to accompany an earlier prefix');
});

test('request counting and narrator prefix weights use the same normalized event records',async()=>{
  const state=world(),deliveries=[{characterId:'ada',text:'A report.',speaker:'Voice',excerpts:['report']}];
  state.events=[{id:'source',time:0,perceptions:deliveries},{id:'decision',type:'perception_decision',time:0,eventId:'source',deliveries:structuredClone(deliveries)},{id:'tail',time:1}];
  const settings={...DEFAULT_SETTINGS,contextTokenLimit:100};
  assert.deepEqual(contextUsage(state,[],settings,buildContextRequest),{...countMessages(buildContextRequest(state,[],settings)),limit:100,threshold:100});
  const expected=modelEventRecords(state.events),weights=[];let summary;
  await compactKnowledge(state,{settings,target:'narrator',buildRequest:(s)=>[{role:'user',content:s.narratorMemory?'small':'large'}],counter:m=>m[0].content==='large'?100:1,
    sourceCounter:text=>{const record=JSON.parse(text);weights.push(record);return record.id==='source'?5:record.id==='tail'?3:1;},
    complete:async request=>{summary=JSON.parse(request.messages[1].content);return '{"summary":"An attributed report and its distinct witnesses."}';},
  });
  assert.deepEqual(weights,expected);assert.deepEqual(summary.sources.map(s=>s.record),expected.slice(0,2));
  assert.equal(state.narratorMemory.through,2);assert.ok(state.events[1].deliveries);
});

test('internal checkpoints do not become narrator prose sources and preserve native message offsets',async()=>{
  const state=world(),messages=[{id:'one',role:'narrator',text:'First visible passage.',storyTime:0,eventCount:0},{id:'hidden',role:'narrator',text:'',internal:true,storyTime:0,eventCount:0},{id:'two',role:'narrator',text:'Second visible passage.',storyTime:1,eventCount:0},{id:'three',role:'narrator',text:'Newest visible passage.',storyTime:2,eventCount:0}];
  let payload;
  await compactKnowledge(state,{settings:{...DEFAULT_SETTINGS,contextTokenLimit:10},target:'narrator',messages,
    buildRequest:s=>[{role:'user',content:s.narratorMemory?'small':'large'}],counter:m=>m[0].content==='large'?10:1,sourceCounter:()=>1,
    complete:async request=>{payload=JSON.parse(request.messages[1].content);return '{"summary":"The first two visible passages."}';},
  });
  assert.deepEqual(payload.sources.map(s=>s.record.id),['one','two']);
  assert.equal(state.narratorMemory.throughMessages,3);assert.equal(state.narratorMemory.throughMessageId,'two');
  assert.equal(messages[1].internal,true);
});

test('publication candidates reference one complete historical publication table and keep server-side eligibility checks',async()=>{
  const state=world();state.time=12;
  state.publications=[{id:'post',time:10,text:'A sourced claim.',source:'Local bulletin',audience:{type:'online',characterIds:['ada']},expiresAt:30}];
  let payload;
  const helper=semantics(state,(p,stage,instruction)=>{payload=p;assert.match(instruction,/candidate.publicationId/);assert.equal(stage,'Resolving public awareness');});
  helper.exposures();state.publications.push({id:'later',time:13,text:'Future post.'});await helper.flush();
  assert.equal(payload.world.publications.length,1);assert.deepEqual(payload.world.publications[0],state.publications[0]);
  for(const c of payload.candidates){assert.equal(c.publicationId,'post');assert.equal(c.publication,undefined);}
  assert.equal(Object.keys(state.exposureDecisions).length,3);
});

test('publication references retain internal full-source validation for ineligible online awareness',async()=>{
  const state=world();state.publications=[{id:'restricted',time:0,text:'A restricted post.',source:'Private board',audience:{type:'online',characterIds:['ada']}}];
  const saved=structuredClone(state);
  const helper=createSemantics(state,{}, {generate:async(_env,_stage,_instruction,payload,validate)=>{
    validate({decisions:payload.candidates.map(c=>({key:c.key,aware:true,reason:'Claimed awareness.'}))});
  },remember:()=>{throw Error('Must not remember an invalid exposure.');},log:()=>{throw Error('Must not log an invalid exposure.');},assertObservable:()=>{},applyViews:()=>{}});
  helper.exposures();await assert.rejects(helper.flush(),/eligible online access/);assert.deepEqual(state,saved);
});

test('unified presentation suppresses legacy display deltas but keeps perception surveys',async()=>{
  const state=world();let calls=0;
  const helper=semantics(state,p=>{calls++;assert.equal(p.presentationContext,undefined);},{unifiedPresentation:true});
  helper.survey({candidate:'Visible prose.',alreadyShown:[]});await helper.flush();assert.equal(calls,1);
  const legacy=semantics(state,p=>assert.equal(p.presentationContext.candidate,'Visible prose.'));
  legacy.survey({candidate:'Visible prose.',alreadyShown:[]});await legacy.flush();
});

test('actor nearby appearance omits only facts duplicated in its complete remembered appearance map',()=>{
  const state=world(),ada=state.characters[1];
  ada.seenAppearance={ben:{name:'Ben',facts:[{key:'coat',text:'An old coat.',time:0}],current:[],time:1,location:'Elsewhere'}};
  const context=characterContext(state,'ada');
  assert.equal(context.nearby.find(c=>c.id==='ben').rememberedAppearance,undefined);
  assert.deepEqual(context.rememberedAppearances.ben,ada.seenAppearance.ben);
});

function illustrationFixture(){
  const state=world(),branch={id:'branch',messages:[{id:'image-anchor',role:'narrator',text:'The room.',snapshot:state},{id:'player',role:'player',text:'I wait.',snapshot:state},{id:'anchor',role:'narrator',text:'A quiet pause.',snapshot:state}],illustrations:[{id:'previous',anchorMessageId:'image-anchor',url:'/images/old.png',prompt:'Old scene.'}]};
  const story={activeBranchId:'branch',branches:{branch},illustrationJob:{id:'job'}};
  const job={id:'job',branchId:'branch',anchorMessageId:'anchor',controller:new AbortController()};
  return {story,branch,job};
}
test('automatic illustration cooldown skips provider construction and image reads; manual requests bypass it',async()=>{
  for(const manual of [false,true]){
    const {story,branch,job}=illustrationFixture();let providers=0,reads=0,requests=0;
    const illustrator=new Illustrator({store:{appendDebug:async()=>{},mutate:async(_id,_version,fn)=>fn(story),image:async()=>{reads++;return Buffer.from('prior');},saveImage:async()=>'/images/new.png'},makeProvider:()=>{providers++;return {complete:async()=>{requests++;return '{"generate":true,"prompt":"A quiet pause.","characterIds":[]}';},image:async()=>({bytes:Buffer.from('new'),extension:'png'})};}});
    await illustrator.execute('story',story,branch,2,{...DEFAULT_SETTINGS,imageCooldown:3},job,manual);
    assert.equal(story.illustrationJob.status,manual?'completed':'skipped');
    assert.equal(providers,manual?1:0);assert.equal(requests,manual?1:0);assert.equal(reads,manual?2:0);
    assert.equal(illustrator.jobs.size,0);
  }
});
