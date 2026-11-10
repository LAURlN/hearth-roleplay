import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

// A small DOM fixture exercises the actual transcript and menu controllers.
// It deliberately has no innerHTML API: generated prose stays literal text.
function controller(branch) {
  let document;
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      Object.assign(this, { tagName: tag, className, textContent: text, dataset: {}, children: [], attributes: {}, handlers: {}, open: false });
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, fn) { this.handlers[event] = fn; }
    focus() { document.activeElement = this; }
    querySelectorAll(selector) {
      const match = element => selector[0] === '.' ? element.className.split(' ').includes(selector.slice(1))
        : Object.hasOwn(element.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
      return this.children.flatMap(child => [ ...(match(child) ? [child] : []), ...child.querySelectorAll(selector) ]);
    }
  }
  const fields = new Map();
  const field = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
  document = { activeElement: null, querySelector: () => field('message-dialog').open ? field('message-dialog') : null };
  field('reading-pane').scrollTop = 340;
  field('composer').value = 'An unsent player draft';
  const state = { story: { id: 'story', activeBranchId: 'branch', version: 1, title: 'Test', branches: [], branch } };
  const menuReturns = new WeakMap(), revisions = [], requests = [], copied = [];
  const context = {
    state, $: field, document, focusBeforeDialog: menuReturns,
    node: (tag, className, text) => new Element(tag, className, text),
    button: (text, className, action) => { const element = new Element('button', className, text); element.addEventListener('click', action); return element; },
    dateLabel: value => value || '', makeImage: record => new Element('img', '', record.caption), openImage() {},
    updateMessageControls() {}, locked: () => false, imageActive: () => false,
    hide: (id, hidden = true) => { field(id).hidden = hidden; },
    openDialog: id => { menuReturns.set(field(id), document.activeElement); field(id).open = true; },
    closeDialog: id => { field(id).open = false; }, toast() {},
    openRevision: (mode, id) => revisions.push({ mode, id }),
    mutateStory: (path, body) => requests.push({ path, body }),
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
    upsertSummary() {}, renderLibrary() {}, updateControls() {}, renderBranches() {}, renderGallery() {}, renderInspector() {}, scrollToBottom() {},
  };
  vm.runInNewContext(source.slice(source.indexOf('  function applyStory('), source.indexOf('  function updateMessageControls()')), context);
  vm.runInNewContext(source.slice(source.indexOf('  function openMessageMenu('), source.indexOf('  function openRevision(')), context);
  vm.runInNewContext(source.slice(source.indexOf('  function regenerationBoundary('), source.indexOf("  $('regenerate').addEventListener", source.indexOf('  function regenerationBoundary('))), context);
  return { context, state, field, document, menuReturns, revisions, requests, copied };
}
const player = id => ({ id, role: 'player', speaker: 'You', text: `Player ${id}` });
const original = (id, speaker = 'Narrator') => ({ id, role: speaker === 'Narrator' ? 'narrator' : 'character', speaker, text: `Original ${id}` });
const fixture = () => ({
  messages: [player('p1'), original('n1'), original('c1', 'Ada'), { id: 'end', role: 'narrator', internal: true, text: '' }, player('p2'), original('legacy')],
  responses: [{ id: 'response', text: 'A coherent passage.\n\n“Hello,” Ada says. <script>literal</script>', sourceMessageIds: ['n1', 'c1', 'end'], anchorMessageId: 'end' }],
  illustrations: ['p1', 'n1', 'end', 'legacy'].map(anchorMessageId => ({ id: `image-${anchorMessageId}`, anchorMessageId, caption: anchorMessageId })),
});

test('one combined passage occupies its canonical position, with originals and images exactly once', () => {
  const c = controller(fixture()); c.context.renderTranscript();
  const transcript = c.field('conversation');
  assert.deepEqual(transcript.children.slice(1).map(element => element.dataset.responseId || element.dataset.messageId), ['p1', 'response', 'p2', 'legacy']);
  const group = transcript.children[2];
  assert.equal(group.children[1].textContent, c.state.story.branch.responses[0].text);
  const details = group.querySelectorAll('[data-response-details]')[0];
  assert.equal(details.open, false);
  assert.match(details.children[0].textContent, /Original contributions \(2\)/);
  assert.deepEqual(details.querySelectorAll('[data-message-action]').map(element => element.dataset.messageAction), ['n1', 'c1']);
  assert.equal(transcript.querySelectorAll('[data-message-id]').some(element => element.dataset.messageId === 'end'), false);
  assert.deepEqual(transcript.querySelectorAll('.message-image').map(element => element.dataset.transcriptFocus), ['image:image-p1', 'image:image-n1', 'image:image-end', 'image:image-legacy']);
  assert.equal(group.querySelectorAll('.message-image').length, 2);
});

test('legacy branches keep separate originals and internal checkpoints never acquire controls', () => {
  const branch = fixture(); delete branch.responses;
  const c = controller(branch); c.context.renderTranscript();
  assert.deepEqual(c.field('conversation').children.slice(1).map(element => element.dataset.messageId), ['p1', 'n1', 'c1', 'p2', 'legacy']);
  assert.equal(c.field('conversation').querySelectorAll('[data-response-details]').length, 0);
  c.context.openMessageMenu('end'); assert.equal(c.field('message-dialog').open, false);
});

test('polling refresh preserves expanded originals, keyboard focus, menu return focus, scroll and drafts', () => {
  const c = controller(fixture()); c.context.renderTranscript();
  const details = c.field('conversation').querySelectorAll('[data-response-details]')[0]; details.open = true;
  details.children[0].focus();
  c.state.story.branch.illustrations.push({ id: 'late-image', anchorMessageId: 'c1', caption: 'New illustration' });
  c.context.renderTranscript();
  assert.equal(c.field('conversation').querySelectorAll('[data-response-details]')[0].open, true);
  assert.equal(c.document.activeElement.dataset.transcriptFocus, 'details:response');
  assert.notEqual(c.document.activeElement, details.children[0]);
  assert.equal(c.field('reading-pane').scrollTop, 340);
  assert.equal(c.field('composer').value, 'An unsent player draft');
  const originalMenu = c.field('conversation').querySelectorAll('[data-message-action]').find(element => element.dataset.messageAction === 'c1');
  originalMenu.focus(); originalMenu.handlers.click();
  c.context.renderTranscript();
  assert.notEqual(c.menuReturns.get(c.field('message-dialog')), originalMenu);
  assert.equal(c.menuReturns.get(c.field('message-dialog')).dataset.messageAction, 'c1');
});

test('combined copy uses presented prose, rewind uses the final internal anchor, and original actions remain precise', async () => {
  const c = controller(fixture()); c.context.renderTranscript();
  c.context.openResponseMenu('response');
  for (const id of ['edit-message', 'delete-message', 'illustrate-message']) assert.equal(c.field(id).hidden, true);
  await c.field('copy-message').handlers.click();
  assert.equal(c.copied[0], c.state.story.branch.responses[0].text);
  c.field('rewind-message').handlers.click();
  assert.deepEqual(c.revisions, [{ mode: 'rewind', id: 'end' }]);
  c.field('edit-message').handlers.click(); c.field('delete-message').handlers.click();
  assert.equal(c.revisions.length, 1);
  c.context.openMessageMenu('c1');
  for (const id of ['edit-message', 'delete-message', 'illustrate-message']) assert.equal(c.field(id).hidden, false);
  c.field('edit-message').handlers.click(); c.field('delete-message').handlers.click(); c.field('rewind-message').handlers.click();
  assert.deepEqual(c.revisions.slice(1), [{ mode: 'edit', id: 'c1' }, { mode: 'delete', id: 'c1' }, { mode: 'rewind', id: 'c1' }]);
});

test('updated response prose invalidates the transcript even when originals remain identical', () => {
  const c = controller(fixture());
  c.context.applyStory(c.state.story);
  const updated = structuredClone(c.state.story); updated.version++; updated.branch.responses[0].text = 'Revised presentation';
  c.context.applyStory(updated);
  assert.equal(c.field('conversation').children[2].children[1].textContent, 'Revised presentation');
});

test('hidden-only passages retain chronological position, images and final-anchor controls without empty originals', async () => {
  const quiet = (id, afterMessageId) => ({ id, text: '…', sourceMessageIds: [`checkpoint-${id}`], anchorMessageId: `checkpoint-${id}`, afterMessageId });
  const branch = {
    messages: [player('p1'), player('p2')],
    responses: [quiet('opening', null), quiet('quiet1', 'p1'), quiet('quiet2', 'p1')],
    illustrations: [{ id: 'quiet-image', anchorMessageId: 'checkpoint-quiet2', caption: 'A quiet moment' }],
  };
  const c = controller(branch); c.context.renderTranscript();
  assert.deepEqual(c.field('conversation').children.slice(1).map(element => element.dataset.responseId || element.dataset.messageId), ['opening', 'p1', 'quiet1', 'quiet2', 'p2']);
  assert.equal(c.field('conversation').querySelectorAll('[data-response-details]').length, 0);
  assert.equal(c.field('conversation').querySelectorAll('[data-message-action]').length, 2);
  assert.equal(c.field('conversation').children[4].querySelectorAll('.message-image').length, 1);
  c.context.openResponseMenu('quiet2');
  await c.field('copy-message').handlers.click();
  assert.deepEqual(c.copied, ['…']);
  c.field('rewind-message').handlers.click();
  assert.deepEqual(c.revisions, [{ mode: 'rewind', id: 'checkpoint-quiet2' }]);
  assert.equal(c.context.regenerationBoundary(), null, 'an unanswered newer player turn has no continuation to regenerate');
  branch.messages.pop();
  assert.equal(c.context.regenerationBoundary().messageId, 'p1');
  branch.messages = []; branch.responses = [quiet('opening', null)];
  c.context.renderTranscript();
  assert.equal(c.field('conversation').children.length, 2, 'a quiet opening replaces the empty transcript note');
  assert.equal(c.context.regenerationBoundary().messageId, undefined, 'quiet openings can regenerate from setup');
});
