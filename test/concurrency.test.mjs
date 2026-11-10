import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {runIndependent} from '../src/concurrency.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('independent work overlaps within its cap and returns input order despite reversed completion',async()=>{
  const gates=Array.from({length:4},deferred),entered=Array.from({length:4},deferred),started=[];
  let active=0,maximum=0;
  const task=runIndependent(gates.map((gate,index)=>async()=>{
    started.push(index);active++;maximum=Math.max(maximum,active);entered[index].resolve();
    await gate.promise;active--;return `result ${index}`;
  }),{limit:2});
  assert.deepEqual(started,[0,1]);
  gates[1].resolve();await entered[2].promise;assert.deepEqual(started,[0,1,2]);
  gates[2].resolve();await entered[3].promise;assert.deepEqual(started,[0,1,2,3]);
  gates[3].resolve();gates[0].resolve();
  assert.deepEqual(await task,['result 0','result 1','result 2','result 3']);assert.equal(maximum,2);
});

test('failure aborts siblings, drains started work and preserves the original failure without starting queued work',async()=>{
  const first=deferred(),second=deferred(),aborted=deferred(),started=[],failure=new Error('Original provider failure');
  let drained=false,settled=false;
  const task=runIndependent([
    async()=>{started.push(0);await first.promise;},
    async signal=>{started.push(1);signal.addEventListener('abort',()=>aborted.resolve(signal.reason),{once:true});await second.promise;drained=true;throw new Error('A later sibling error');},
    async()=>{started.push(2);},
  ]);
  const checked=assert.rejects(task,error=>error===failure).then(()=>{settled=true;});
  first.reject(failure);assert.equal(await aborted.promise,failure);assert.equal(settled,false);assert.equal(drained,false);assert.deepEqual(started,[0,1]);
  second.resolve();await checked;assert.equal(drained,true);assert.equal(settled,true);assert.deepEqual(started,[0,1]);
});

test('parent cancellation drains active requests, preserves its reason and removes the abort listener',async()=>{
  const parent=new AbortController(),gates=[deferred(),deferred()],started=[],reason=new Error('Stopped by the player');
  let settled=false;
  const task=runIndependent([
    ...gates.map((gate,index)=>async signal=>{started.push(index);await gate.promise;assert.equal(signal.aborted,true);}),
    async()=>{started.push(2);},
  ],{signal:parent.signal});
  const checked=assert.rejects(task,error=>error===reason).then(()=>{settled=true;});
  assert.equal(getEventListeners(parent.signal,'abort').length,1);parent.abort(reason);
  assert.equal(settled,false);assert.deepEqual(started,[0,1]);gates.forEach(gate=>gate.resolve());await checked;
  assert.equal(getEventListeners(parent.signal,'abort').length,0);assert.deepEqual(started,[0,1]);
});

test('pre-cancellation starts no work and successful batches release the parent listener',async()=>{
  const cancelled=new AbortController(),reason=new Error('Already cancelled');cancelled.abort(reason);let started=false;
  await assert.rejects(runIndependent([async()=>{started=true;}],{signal:cancelled.signal}),error=>error===reason);assert.equal(started,false);
  const parent=new AbortController();assert.deepEqual(await runIndependent([async()=>1],{signal:parent.signal}),[1]);assert.equal(getEventListeners(parent.signal,'abort').length,0);
  await assert.rejects(runIndependent([],{limit:0}),/positive integer/);
});
