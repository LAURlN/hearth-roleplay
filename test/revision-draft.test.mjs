import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual revision controller without a browser or fabricated DOM
// rendering. The transport fails; reopening must retain exactly what was typed.
test('a failed edit reopens its persisted draft; only a successful edit clears it', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function openRevision(');
  const end = source.indexOf('  function renderBranches()', start);
  const listeners = new Map(), fields = new Map(), saved = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, { value: '', open: false, addEventListener: (event,fn) => listeners.set(id + ':' + event, fn) });
    return fields.get(id);
  };
  let succeeds = false, opened = 0, submitted;
  const state = { story: { id: 'story', activeBranchId: 'original', branch: { messages: [{ id: 'message', text: 'Original text' }] } } };
  const context = { state, $: field, locked: () => false, storage: { get: key => saved.get(key) ?? null, set: (key,value) => saved.set(key,value), remove: key => saved.delete(key) }, hide(){},inlineError(){},closeDialog(){},openDialog(){opened++;},toast(){},scrollToBottom(){},mutateStory: async (_path,body) => { submitted = body; return succeeds; } };
  vm.runInNewContext(source.slice(start,end), context);
  context.openRevision('edit','message'); assert.equal(field('revision-text').value,'Original text');
  field('revision-text').value = 'A carefully rewritten passage';
  listeners.get('revision-text:input')();
  await listeners.get('revision-form:submit')({preventDefault(){}});
  assert.equal(submitted.text,'A carefully rewritten passage');assert.equal(opened,2);assert.equal(field('revision-text').value,'A carefully rewritten passage');assert.equal(saved.size,1);
  succeeds = true;
  await listeners.get('revision-form:submit')({preventDefault(){}});
  assert.equal(saved.size,0);
});
