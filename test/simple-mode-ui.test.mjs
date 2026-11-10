import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function controller() {
  class Element {
    constructor(tag = 'div', className = '', text = '') { Object.assign(this, { tagName: tag, className, textContent: text, value: '', dataset: {}, children: [], handlers: {}, attributes: {} }); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(event, action) { this.handlers[event] = action; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() {}
    closest(tag) { return this.tagName === tag ? this : this.parent?.closest(tag); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    querySelectorAll(selector) {
      const matches = element => selector.split(',').some(part => {
        if (part.startsWith('.')) return element.className.split(' ').includes(part.slice(1));
        if (part.startsWith('[data-')) {
          const [, name, value] = part.match(/^\[data-([^=\]]+)(?:="([^"]*)")?\]$/);
          const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return Object.hasOwn(element.dataset, key) && (value === undefined || element.dataset[key] === value);
        }
        return element.tagName === part;
      });
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    get childElementCount() { return this.children.length; }
  }
  const fields = new Map(), saved = new Map(), submitted = [];
  const field = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
  const castDetails = new Element('details'); castDetails.append(field('cast-list'));
  field('setup-form').append(castDetails);
  const state = { story: null, settings: null };
  const context = {
    state, $: field, document: { createTextNode: text => new Element('text', '', text) }, structuredClone,
    node: (tag, cls, text) => new Element(tag, cls, text),
    button: (text, cls, action) => { const element = new Element('button', cls, text); element.handlers.click = action; return element; },
    storage: { get: key => saved.get(key) ?? null, set: (key, value) => saved.set(key, value), json: key => JSON.parse(saved.get(key) || 'null') },
    hide: (id, hidden = true) => { field(id).hidden = hidden; }, inlineError() {}, toast() {}, setDrawer() {}, openDialog() {}, closeDialog() {},
    persistComposer() {}, stopPolling() {}, updateControls() {}, resizeComposer() {}, refreshLibrary() {}, schedulePolling() {},
    api: async (path, options) => { submitted.push({ path, body: options.body }); return { id: 'created' }; }, applyStory: story => { state.story = story; },
  };
  vm.runInNewContext(source.slice(source.indexOf('  function addCharacter('), source.indexOf('  function modelEfforts(')), context);
  vm.runInNewContext(source.slice(source.indexOf("  $('reuse-story').addEventListener"), source.indexOf("  $('export-story').addEventListener")), context);
  return { context, field, state, saved, submitted };
}
const setup = { title: 'A tale', premise: 'At an inn', persona: { name: 'Pat' }, characters: [{ name: 'Ada', appearance: 'Red coat', systemPrompt: 'Actor instructions', online: { access: true, interests: ['gardens'], connections: [] } }] };

test('new and legacy setups default to Detailed; Simple survives save, load and reuse without clearing cast details', () => {
  const c = controller(); c.context.openSetup(); assert.equal(c.field('setup-mode').value, 'detailed');
  c.context.populateSetup(setup); assert.equal(c.field('setup-mode').value, 'detailed');
  c.field('setup-mode').value = 'simple'; c.field('setup-mode').handlers.change();
  const hiddenFields = c.field('setup-form').querySelectorAll('.detailed-only');
  assert.equal(hiddenFields.length, 2); assert.ok(hiddenFields.every(element => element.hidden));
  c.field('save-setup').handlers.click(); assert.equal(JSON.parse(c.saved.get('saved-setup')).mode, 'simple');
  c.context.populateSetup({ ...setup, mode: 'detailed' }); c.field('load-setup').handlers.click();
  assert.equal(c.context.collectSetup().mode, 'simple');
  assert.equal(c.context.collectSetup().characters[0].systemPrompt, 'Actor instructions');
  c.state.story = { setup: { ...setup, mode: 'simple' } }; c.field('reuse-story').handlers.click();
  assert.equal(c.field('setup-mode').value, 'simple');
  c.field('setup-mode').value = 'detailed'; c.field('setup-mode').handlers.change();
  assert.ok(c.field('setup-form').querySelectorAll('.detailed-only').every(element => !element.hidden));
  assert.equal(c.context.collectSetup().characters[0].online.interests[0], 'gardens');
});

test('story creation submits the chosen mode and setup UI explains it is fixed for all branches', async () => {
  const c = controller(); c.context.populateSetup({ ...setup, mode: 'simple' });
  await c.field('setup-form').handlers.submit({ preventDefault() {} });
  assert.equal(c.submitted[0].path, '/api/stories'); assert.equal(c.submitted[0].body.mode, 'simple');
  assert.match(html, /Simple · one narrator \+ illustrator/); assert.match(html, /mode stays with this story and all its branches/);
  assert.match(html, /id="setting-simpleModePrompt"/); assert.match(html, /id="app-version">1\.3\.0/);
});

test('Simple inspector keeps cast descriptions while suppressing separate prompts, knowledge and appearance editors', () => {
  const c = controller();
  c.state.story = { setup: { mode: 'simple' }, world: { characters: [{ id: 'ada', name: 'Ada', description: 'Gardener', appearance: 'Red coat', systemPrompt: 'Hidden', knowledge: [{ text: 'Secret' }] }] } };
  Object.assign(c.context, { renderContextUsage() {}, locked: () => false, selectInspectorTab: tab => { c.context.selectedTab = tab; } });
  vm.runInNewContext(source.slice(source.indexOf('  function inspectorCard('), source.indexOf("  $('open-inspector').addEventListener")), c.context);
  c.context.renderInspector();
  assert.equal(c.field('tab-knowledge').hidden, true); assert.equal(c.field('tab-public').hidden, true);
  assert.equal(c.context.selectedTab, 'presence');
  assert.deepEqual(c.field('panel-presence').children[0].children.filter(child => child.tagName === 'p').map(child => child.textContent), ['Whereabouts not established', 'Gardener', 'Red coat']);
  assert.equal(c.field('panel-presence').querySelectorAll('button').length, 0);
  assert.equal(c.field('panel-knowledge').children.length, 0);
});
