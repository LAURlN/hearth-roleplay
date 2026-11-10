import test from 'node:test';
import assert from 'node:assert/strict';
import {atomicRename} from '../src/store.mjs';

test('a transient Windows replacement lock is retried without deleting the existing save',async()=>{
  let calls=0;const args=[];
  await atomicRename('temporary','saved',{platform:'win32',renameFile:async(...paths)=>{args.push(paths);if(++calls<3)throw Object.assign(new Error('Reader holds file'),{code:'EPERM'});}});
  assert.equal(calls,3);assert.deepEqual(args,[['temporary','saved'],['temporary','saved'],['temporary','saved']]);
  let nonLockCalls=0;
  await assert.rejects(atomicRename('temporary','saved',{platform:'win32',renameFile:async()=>{nonLockCalls++;throw Object.assign(new Error('Missing source'),{code:'ENOENT'});}}),{code:'ENOENT'});
  assert.equal(nonLockCalls,1);
});
