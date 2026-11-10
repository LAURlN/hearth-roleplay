import test from 'node:test';
import assert from 'node:assert/strict';
import {compactKnowledge} from '../src/memory.mjs';
import {Illustrator} from '../src/illustrator.mjs';
import {DEFAULT_SETTINGS} from '../src/settings.mjs';

test('memory helpers receive helper effort for character and narrator summaries',async()=>{
  const state={time:10,characters:[{name:'Ada',knowledge:[{id:'one',text:'An attributed claim.'},{id:'two',text:'A later observation.'}]}],events:Array.from({length:240},(_,i)=>({id:String(i),text:'Timeline event'}))};
  const requests=[];
  await compactKnowledge(state,{settings:{...DEFAULT_SETTINGS,helperModel:'helper-model',helperEffort:'low',chatEffort:'high'},threshold:2,tail:0,complete:async request=>{requests.push(request);return '{"summary":"A faithful summary."}';}});
  assert.equal(requests.length,2);
  for(const request of requests){assert.equal(request.model,'helper-model');assert.equal(request.reasoningEffort,'low');}
});

test('illustrator decision receives its own effort without sending it to image generation',async()=>{
  const settings={...DEFAULT_SETTINGS,illustratorEffort:'medium',chatEffort:'high'};
  const world={timeLabel:'Afternoon',location:'room',characters:[{id:'player',name:'Pat',location:'room',knowledge:[]}]};
  const branch={id:'branch',messages:[{id:'anchor',role:'narrator',text:'Light crosses the room.',snapshot:world}],illustrations:[]};
  const job={id:'job',branchId:'branch',anchorMessageId:'anchor',controller:new AbortController()};
  const story={activeBranchId:'branch',branches:{branch},illustrationJob:{id:'job'}};
  let decision,image;
  const illustrator=new Illustrator({store:{appendDebug:async()=>{},mutate:async(_id,_version,fn)=>fn(story),saveImage:async()=>'/images/picture.png'},makeProvider:()=>({complete:async request=>{decision=request;return '{"generate":true,"prompt":"A quiet room.","characterIds":[]}';},image:async request=>{image=request;return {bytes:Buffer.from('image'),extension:'png'};}})});
  await illustrator.execute('story',story,branch,0,settings,job,false);
  assert.equal(story.illustrationJob.status,'completed');assert.equal(decision.reasoningEffort,'medium');
  assert.equal(image.reasoningEffort,undefined);assert.equal(image.reasoning_effort,undefined);
});
