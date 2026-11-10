import test from 'node:test';
import assert from 'node:assert/strict';
import { compactKnowledge,narratorProjection } from '../src/memory.mjs';
import { createInitialState,characterContext } from '../src/engine.mjs';

test('memory compaction sees only its owner observations and preserves original records',async()=>{
  const state=createInitialState({characters:[{name:'Ada'},{name:'Ben'}]});
  state.events.push({text:'GLOBAL HIDDEN CAUSE'});state.privateInputs=['PRIVATE PLAYER THOUGHT'];state.characters[2].privateState='BEN SECRET';
  const ada=state.characters[1];ada.knowledge=Array.from({length:6},(_,i)=>({id:'fact'+i,text:'Observation '+i,source:'A witness',time:i,publicationId:'source'+i}));
  const original=structuredClone(ada.knowledge);let calls=0;
  await compactKnowledge(state,{settings:{chatModel:'test'},threshold:4,tail:2,complete:async request=>{calls++;const content=JSON.stringify(request.messages);for(const forbidden of ['GLOBAL HIDDEN CAUSE','PRIVATE PLAYER THOUGHT','BEN SECRET'])assert.ok(!content.includes(forbidden));return JSON.stringify({summary:'A witness described observations 0 through 3.'});}});
  assert.equal(calls,1);assert.equal(ada.memory.through,4);assert.deepEqual(ada.knowledge,original);assert.deepEqual(ada.memory.sourceIds,['fact0','fact1','fact2','fact3']);
  assert.equal(characterContext(state,ada.id).knowledge.length,2);
  assert.match(characterContext(state,ada.id).memory.summary,/witness/);
  await compactKnowledge(state,{settings:{},threshold:4,tail:2,complete:async()=>{throw new Error('Must not summarize twice.');}});
});
test('model-facing narrator projection is bounded without changing stored world history',()=>{
  const state=createInitialState({characters:[{name:'Ada'}]});
  state.events=Array.from({length:300},(_,i)=>({id:String(i)}));state.characters[1].knowledge=Array.from({length:200},(_,i)=>({id:String(i)}));
  state.narratorMemory={through:180,summary:'Earlier narrator continuity'};
  state.characters[1].memory={through:140,summary:'Earlier memory',sourceIds:['0']};
  const projected=narratorProjection(state);
  assert.equal(projected.events.length,120);assert.equal(projected.characters[1].knowledge.length,60);assert.equal(state.events.length,300);assert.equal(state.characters[1].knowledge.length,200);assert.equal(projected.characters[1].memory.summary,'Earlier memory');
});
