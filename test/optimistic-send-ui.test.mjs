import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const story = (patch = {}) => ({ id: 'story', activeBranchId: 'main', version: 1, title: 'Test', branches: [],
  branch: { name: 'Main', messages: [{ id: 'opening', role: 'narrator', text: 'Opening' }], illustrations: [] }, ...patch });
const completed = (base, text) => ({ ...structuredClone(base), version: base.version + 1, busy: false,
  branch: { ...structuredClone(base.branch), messages: [...base.branch.messages,
    { id: 'player-new', role: 'player', speaker: 'You', text }, { id: 'reply-new', role: 'narrator', text: 'Reply' }] } });

// Run the actual composer, mutation, polling, selection and transcript controllers.
// Deferred API promises make the before-await behavior observable without a browser.
function controller(api, { initial = story(), persisted = new Map() } = {}) {
  let document;
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      Object.assign(this, { tagName: tag, className, textContent: text, value: '', style: {}, dataset: {}, children: [], handlers: {}, attributes: {}, scrollTop: 0, scrollHeight: 100, open: false });
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, action) { this.handlers[event] = action; }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    querySelectorAll(selector) {
      const matches = element => selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('[data-') && Object.hasOwn(element.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  }
  const fields = new Map(), timers = new Map(), copies = [], errors = [];
  let sequence = 0;
  const field = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
  document = { activeElement: null, hidden: false, querySelector: () => null };
  const state = { story: initial, submissions: {}, selection: 0, pollToken: 0, nearBottom: true };
  const storage = { get: key => persisted.get(key) ?? null, set: (key, value) => persisted.set(key, value), remove: key => persisted.delete(key), json: key => JSON.parse(persisted.get(key) || 'null') };
  const context = {
    state, $: field, document, storage, api, AbortController, crypto: { randomUUID: () => `submission-${++sequence}` },
    focusBeforeDialog: new WeakMap(), navigator: { clipboard: { writeText: async value => copies.push(value) } },
    node: (tag, cls, text) => new Element(tag, cls, text),
    button: (text, cls, action) => { const element = new Element('button', cls, text); element.handlers.click = action; return element; },
    hide: (id, hidden = true) => { field(id).hidden = hidden; }, storyPath: (id, suffix = '') => `/api/stories/${id}${suffix}`,
    dateLabel: () => '', setDrawer() {}, clearError() {}, showError: error => errors.push(error), toast() {}, inlineError() {},
    upsertSummary() {}, renderLibrary() {}, updateControls() {}, updateMessageControls() {}, refreshLibrary() {},
    renderBranches() {}, renderGallery() {}, renderInspector() {}, scrollToBottom() {}, imageActive: () => false,
    requestAnimationFrame: fn => fn(), setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(source.slice(source.indexOf('  function persistComposer('), source.indexOf('  function updateMessageControls()')), context);
  vm.runInNewContext(source.match(/  function locked\(\) \{[^\n]+/)[0], context);
  vm.runInNewContext(source.slice(source.indexOf('  function stopPolling('), source.indexOf('  function regenerationBoundary(')), context);
  context.renderTranscript();
  return { context, state, field, persisted, copies, errors,
    submit: value => { field('composer').value = value; return field('composer-form').handlers.submit({ preventDefault() {} }); },
    poll: async () => { const first = timers.entries().next().value; assert.ok(first, 'a poll is scheduled'); timers.delete(first[0]); await first[1](); },
    pending: () => field('conversation').querySelectorAll('[data-submission-token]'),
    player: () => field('conversation').children.filter(element => element.dataset.role === 'player'),
  };
}

test('send clears immediately, keeps optimistic text outside canonical state and reconciles once across busy/final polls', async () => {
  const request = defer(), base = story(); let polled = { ...structuredClone(base), busy: true }, requests = 0;
  const c = controller(async (path, options) => { if (options?.method === 'POST') { requests++; return request.promise; } return polled; });
  const sending = c.submit('  My action\n');
  assert.equal(c.field('composer').value, '');
  assert.equal(c.pending().length, 1); assert.equal(c.player()[0].children[1].textContent, 'My action');
  assert.equal(c.state.story.branch.messages.length, 1); assert.equal(c.field('conversation').querySelectorAll('[data-message-action]').length, 1);
  assert.match(c.pending()[0].children[0].children[1].textContent, /Sending.*not yet saved/);
  c.field('composer').value = 'Next draft'; c.field('composer').handlers.input();
  await c.poll(); assert.equal(c.player().length, 1); assert.match(c.pending()[0].children[0].children[1].textContent, /Generating/);
  polled = completed(base, 'My action'); await c.poll();
  assert.equal(c.player().length, 1); assert.equal(c.pending().length, 0);
  request.resolve(polled); await sending;
  assert.equal(c.player().length, 1); assert.equal(c.field('composer').value, 'Next draft'); assert.equal(requests, 1);
  assert.equal(JSON.parse(c.persisted.get('submissions:story')).length, 0);
});

test('failure restores an empty composer, retains recovery and never overwrites a newer draft', async () => {
  for (const nextDraft of ['', 'A new unsent idea']) {
    const request = defer(); const c = controller(async (_path, options) => options?.method === 'POST' ? request.promise : story());
    const sending = c.submit(' Original submitted draft '); c.field('composer').value = nextDraft;
    request.reject(new Error('Generation failed')); await sending;
    assert.equal(c.field('composer').value, nextDraft || ' Original submitted draft ');
    assert.equal(c.pending().length, 1); assert.match(c.pending()[0].children[0].children[1].textContent, /Not sent.*recoverable/);
    const controls = c.pending()[0].children.at(-1).children;
    await controls.find(element => element.textContent === 'Copy submitted text').handlers.click();
    assert.deepEqual(c.copies, [' Original submitted draft ']);
    controls.find(element => element.textContent === 'Restore to composer').handlers.click();
    assert.equal(c.field('composer').value, nextDraft || ' Original submitted draft ');
    assert.equal(c.state.story.branch.messages.length, 1);
  }
});

test('Detailed startup notices before the canonical player do not leave duplicate or falsely failed submissions', async () => {
  const request = defer(), base = story(), final = completed(base, 'I arrive');
  final.branch.messages.splice(1, 0, { id: 'startup-appearance', role: 'narrator', text: 'Ada notices your appearance.' });
  const c = controller(async (_path, options) => options?.method === 'POST' ? request.promise : final);
  const sending = c.submit('I arrive'); await c.poll();
  assert.equal(c.pending().length, 0); assert.equal(c.player().length, 1);
  request.resolve(final); await sending;
  assert.equal(c.pending().length, 0); assert.equal(c.player().length, 1); assert.equal(c.field('composer').value, '');
});

test('stop and an aborted turn preserve the next draft and leave submitted text recoverable', async () => {
  const request = defer(); let cancelled = false;
  const c = controller(async (path, options) => {
    if (path.endsWith('/cancel')) { cancelled = true; request.reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })); return { cancelled: true }; }
    return options?.method === 'POST' ? request.promise : story();
  });
  const sending = c.submit('Stopped action'); c.field('composer').value = 'New idea';
  await c.field('stop-generation').handlers.click(); await sending;
  assert.equal(cancelled, true); assert.equal(c.field('composer').value, 'New idea');
  assert.equal(c.pending().length, 1); assert.equal(c.state.story.branch.messages.length, 1);
});

test('network uncertainty blocks duplicate retry, then canonical recovery clears pending without resending', async () => {
  const request = defer(), base = story(); let online = false, requests = 0;
  const c = controller(async (_path, options) => {
    if (options?.method === 'POST') { requests++; return request.promise; }
    if (!online) throw new Error('Offline');
    return completed(base, 'Uncertain action');
  });
  const sending = c.submit('Uncertain action'); request.reject(new Error('Offline')); await sending;
  assert.equal(c.context.locked(), true); assert.match(c.pending()[0].children[0].children[1].textContent, /Checking delivery/);
  await c.submit('Uncertain action'); assert.equal(requests, 1);
  online = true; await c.poll(); assert.equal(c.pending().length, 0); assert.equal(c.player().length, 1); assert.equal(c.context.locked(), false);
});

test('reconnect uses persisted boundary and isolates submissions across stories, branches and stale versions', async () => {
  const request = defer(), base = story(); let online = false;
  const c = controller(async (_path, options) => { if (options?.method === 'POST') return request.promise; throw new Error('Offline'); });
  const sending = c.submit('Persisted action'); request.reject(new Error('Offline')); await sending;
  const persisted = c.persisted;
  const saved = completed(base, 'Persisted action');
  const d = controller(async path => {
    if (path.endsWith('/other')) return story({ id: 'other' });
    return online ? saved : { ...base, busy: true };
  }, { persisted });
  await d.context.selectStory('story'); assert.equal(d.pending().length, 1);
  d.context.applyStory(story({ activeBranchId: 'alternate', version: 2 })); assert.equal(d.pending().length, 0);
  d.context.applyStory({ ...base, version: 3, busy: true }); assert.equal(d.pending().length, 1);
  d.context.applyStory(saved); assert.equal(d.pending().length, 1, 'stale result cannot clear a newer view');
  await d.context.selectStory('other'); assert.equal(d.pending().length, 0);
  online = true; await d.context.selectStory('story'); assert.equal(d.pending().length, 0); assert.equal(d.player().length, 1);
});

test('an identical earlier player passage cannot falsely acknowledge a failed new send', async () => {
  const base = story({ branch: { messages: [{ id: 'old-player', role: 'player', text: 'Again' }, { id: 'opening', role: 'narrator', text: 'Before' }], illustrations: [] } });
  const c = controller(async (_path, options) => { if (options?.method === 'POST') throw new Error('Failed'); return { ...base, version: 2 }; }, { initial: base });
  await c.submit('Again'); assert.equal(c.pending().length, 1); assert.equal(c.state.submissions.story[0].status, 'failed');
});

test('sending over a LAN HTTP origin works when secure-context randomUUID is unavailable', async () => {
  const request = defer(); const c = controller(async (_path, options) => options?.method === 'POST' ? request.promise : story());
  c.context.crypto = {};
  const sending = c.submit('LAN action'); assert.equal(c.field('composer').value, ''); assert.equal(c.pending().length, 1);
  assert.match(c.pending()[0].dataset.submissionToken, /^local-/);
  request.resolve(completed(story(), 'LAN action')); await sending; assert.equal(c.pending().length, 0);
});
