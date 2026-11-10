import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, runTurn, applyAuthoredMessage, characterContext, parseJson } from '../src/engine.mjs';

const settings = { chatModel: 'test-model', roleplayPrompt: 'General editable rules.', maxResponders: 3, contextMessages: 24 };
function world() {
  return createInitialState({ title: 'Hearth test', premise: 'A quiet cafe; a hidden ledger exists elsewhere.', location: 'cafe', persona: { name: 'Pat', description: 'A traveller.' }, characters: [
    { name: 'Ada', description: 'A regular.', appearance: 'Red scarf', location: 'cafe' },
    { name: 'Ben', description: 'A visitor.', location: 'road' },
    { name: 'Cy', description: 'A quiet bystander.', location: 'cafe' },
  ] });
}
const find = (state, name) => state.characters.find(c => c.name === name);
const texts = who => who.knowledge.map(k => k.text).join('\n');
const plan = (events = [], speakers = [], text = 'The scene holds.') => ({ events, speakers, text });
const actor = (text, extra = {}) => ({ text, privateState: 'My own reflection.', movement: null, ...extra });
function fake(...responses) {
  const calls = [];
  const complete = async request => {
    // These existing orchestration tests script dialogue, not visual parsing.
    // Dedicated visual-state tests exercise real patches and helper failures.
    if(request.messages[0].content.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    calls.push(request);
    assert.equal(request.model, 'test-model');
    assert.equal(request.json, true);
    assert.ok(responses.length, `Unexpected completion: ${request.messages[0].content.slice(-400)}`);
    const next = responses.shift();
    const value = typeof next === 'function' ? await next(request) : next;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  complete.calls = calls;
  complete.done = () => assert.equal(responses.length, 0, 'All expected model requests were used.');
  return complete;
}
function payload(request) { return JSON.parse(request.messages[1].content); }
function turn(state, complete, extra = {}) { return runTurn({ state, messages: [], input: null, settings, complete, ...extra }); }

test('initial state is complete, distinct, serializable, and excludes premise from actor context', () => {
  const setup = { premise: 'A secret premise', persona: { name: 'Pat' }, characters: [{ name: 'Ada', online: { access: true, interests: ['art'], connections: ['Pat'] } }] };
  const state = createInitialState(setup);
  assert.equal(state.characters[0].id, 'player');
  assert.notEqual(state.characters[1].id, createInitialState(setup).characters[1].id);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  setup.characters[0].online.interests.push('changed');
  assert.deepEqual(state.characters[1].online.interests, ['art']);
  const context = characterContext(state, state.characters[1].id);
  assert.ok(!JSON.stringify(context).includes('A secret premise'));
  context.character.online.interests.push('mutated');
  assert.deepEqual(state.characters[1].online.interests, ['art']);
  assert.throws(() => characterContext(state, 'player'), /never an AI actor/);
});

test('characters receive their own compact memory and recent observations without archived repetition', () => {
  const state = world(), ada = find(state, 'Ada');
  ada.knowledge = [{ text: 'Older observation' }, { text: 'Recent observation' }];
  ada.memory = { summary: 'Ada remembers the earlier encounter.', through: 1, time: 0, sourceIds: ['original'] };
  find(state, 'Ben').memory = { summary: 'BEN SECRET SUMMARY', through: 0 };
  const context = characterContext(state, ada.id);
  assert.equal(context.memory.summary, 'Ada remembers the earlier encounter.');
  assert.deepEqual(context.knowledge, [{ text: 'Recent observation' }]);
  assert.ok(!JSON.stringify(context).includes('BEN SECRET SUMMARY'));
});

test('shared setting knowledge reaches everyone without becoming invented personal exposure', async () => {
  const state = world(), ada = find(state, 'Ada');
  const complete = fake(plan([{ type: 'background', text: 'Dragons are an ordinary part of this world.' }], [ada.id]), request => {
    assert.deepEqual(payload(request).context.sharedBackground, ['Dragons are an ordinary part of this world.']);
    return actor('The road is quiet.');
  });
  const result = await turn(state, complete);
  assert.deepEqual(characterContext(result.state, find(state, 'Ben').id).sharedBackground, ['Dragons are an ordinary part of this world.']);
  assert.ok(!texts(find(result.state, 'Ben')).includes('Dragons'));
});

test('a thought about a later time cannot authorize skipping the conversation', async () => {
  const state = world(), input = '[THOUGHT: Skip to tomorrow.]';
  const bad = { segments: [{ kind: 'thought', text: input }], allowMajorTimeSkip: true, timeSkipEvidence: 'Skip to tomorrow.' };
  const complete = fake(bad, bad);
  await assert.rejects(turn(state, complete, { input }), /thoughts cannot authorize/);
  assert.equal(state.time, 0);
});

test('a later authored utterance can disclose an earlier private thought only to its recipients', async () => {
  const state = world(), ada = find(state, 'Ada');
  const secret = 'The key is under the mat.';
  const input = `[THOUGHT: ${secret}]`;
  const first = await turn(state, fake({ segments: [{ kind: 'thought', text: input }], allowMajorTimeSkip: false }, plan()), { input });
  const spoken = `"${secret}"`;
  const second = await turn(first.state, fake(
    { segments: [{ kind: 'speech', text: spoken, recipients: [ada.id] }], allowMajorTimeSkip: false },
    plan([], [ada.id]),
    actor(secret, { recipients: ['player'] }),
  ), { input: spoken });
  assert.match(texts(find(second.state, 'Ada')), /key is under the mat/);
  assert.ok(!texts(find(second.state, 'Cy')).includes(secret));
  assert.ok(!texts(find(second.state, 'Ben')).includes(secret));
  const leak = plan([{ type: 'observation', text: secret, recipients: [find(second.state, 'Cy').id], location: 'cafe' }]);
  await assert.rejects(turn(second.state, fake(leak, leak)), /Private player content/);
});

test('identical words in an explicit thought and a separate spoken span retain source boundaries', async () => {
  const state = world(), secret = 'The key is under the mat.', thought = `[THOUGHT: ${secret}]`, spoken = `"${secret}"`, input = `${thought} ${spoken}`;
  const result = await turn(state, fake({ segments: [{ kind: 'thought', text: thought }, { kind: 'speech', text: spoken }], allowMajorTimeSkip: false }, plan()), { input });
  assert.ok(texts(find(result.state, 'Ada')).includes(secret));
  assert.ok(!texts(find(result.state, 'Ben')).includes(secret));
});

test('remote senders retain their own utterance using the same event as recipient delivery', async () => {
  const state = world(), ben = find(state, 'Ben');
  const result = await turn(state, fake(plan([], [ben.id]), actor('I will call you at dusk.', { channel: 'phone', recipients: ['player'] })));
  const sender = find(result.state, 'Ben').knowledge.find(k => k.text === 'I will call you at dusk.');
  const receiver = result.state.characters.find(c => c.id === 'player').knowledge.find(k => k.text === 'I will call you at dusk.');
  assert.ok(sender); assert.equal(sender.eventId, receiver.eventId);
  assert.match(texts(characterContext(result.state, ben.id)), /call you at dusk/);
  assert.ok(!texts(find(result.state, 'Ada')).includes('call you at dusk'));
});

test('empty local recipient lists deliver player speech and a generated answer to nearby witnesses', async () => {
  const state = world(), ada = find(state, 'Ada'), input = '"Does the instructor lead this lesson?" [OOC: Keep the reply brief.]';
  const responses = [
    { segments: [{ kind: 'speech', text: '"Does the instructor lead this lesson?"', recipients: [] }, { kind: 'ooc', text: '[OOC: Keep the reply brief.]' }], allowMajorTimeSkip: false },
    plan([{ type: 'observation', text: 'The instructor sets down a pad.', location: 'cafe', recipients: [] }], [ada.id], 'Ada is within speaking distance.'),
    actor('Yes, the instructor leads the lesson.', { channel: 'local', recipients: [] }),
  ];
  const calls=[];
  const complete=async request=>{
    if(request.messages[0].content.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    calls.push(request);
    if(request.messages[0].content.includes('brief player-visible pause'))return JSON.stringify({text:'The room settles.'});
    const response=responses.shift();assert.ok(response,'Unexpected completion');
    if(response.privateState) {
      const context=payload(request).context;
      assert.match(texts(context),/Does the instructor/);assert.match(texts(context),/sets down a pad/);
      assert.ok(!JSON.stringify(context).includes('Keep the reply brief'));
    }
    return JSON.stringify(response);
  };
  const result=await turn(state,complete,{input});
  assert.equal(result.messages.filter(m=>m.role==='character').length,1,'A generated local answer must not disappear');
  assert.equal(result.messages.find(m=>m.role==='character').text,'Yes, the instructor leads the lesson.');
  for(const name of ['Ada','Cy'])assert.match(texts(find(result.state,name)),/instructor leads the lesson/);
  assert.match(texts(result.state.characters.find(c=>c.id==='player')),/instructor leads the lesson/);
  assert.ok(!texts(find(result.state,'Ben')).includes('instructor leads'));
  assert.equal(calls.length,3,'A visible answer does not need replacement filler narration');
});

test('a restricted local whisper is not widened to the player, and empty remote lists still fail', async () => {
  const state=world(),ada=find(state,'Ada'),cy=find(state,'Cy'),ben=find(state,'Ben');
  const whispered=await turn(state,fake(plan([], [ada.id]),actor('A whispered aside.',{recipients:[cy.id]}),{text:'The room is quiet.'}));
  assert.ok(!whispered.messages.some(m=>m.role==='character'));
  assert.match(texts(find(whispered.state,'Cy')),/whispered aside/);
  assert.ok(!texts(whispered.state.characters.find(c=>c.id==='player')).includes('whispered aside'));
  const invalid=actor('A remote message.',{channel:'phone',recipients:[]});
  await assert.rejects(turn(state,fake(plan([], [ben.id]),invalid,invalid)),/Remote communication needs explicit recipients/);
  const silent=await turn(state,fake(plan([], [ada.id]),actor('',{recipients:[]}),{text:'Ada remains quiet.'}));
  assert.ok(!silent.messages.some(m=>m.role==='character'));
});

test('a long skip resolves reading opportunities before a publication expires', async () => {
  const state = world(), ben = find(state, 'Ben');
  ben.online = { access: true, interests: [], connections: ['player'] };
  state.publications.push({ id: 'expiring-notice', time: 0, expiresAt: 180, text: 'Tonight the bridge closes.', source: 'community feed', authorId: 'player', audience: { type: 'online', characterIds: [ben.id] } });
  state.exposureDecisions[`expiring-notice:${ben.id}:0:0`] = false;
  const input = '[OOC: Skip eight hours.]';
  const interpretation = { segments: [{ kind: 'ooc', text: input }], allowMajorTimeSkip: true, timeSkipEvidence: 'Skip eight hours.' };
  const short = await turn(state, fake(interpretation, plan([{ type: 'time', minutes: 60 }])), { input });
  const long = await turn(state, fake(interpretation, plan([{ type: 'time', minutes: 480 }])), { input });
  const read = s => find(s, 'Ben').knowledge.find(k => k.publicationId === 'expiring-notice');
  assert.equal(read(short.state).time, 60); assert.equal(read(long.state).time, 60); assert.equal(long.state.time, 480);
  assert.equal(long.state.exposureDecisions[`expiring-notice:${ben.id}:0:0`], false);
  const disconnected = structuredClone(state);
  disconnected.pending.push({ type: 'activity', at: 30, characterId: ben.id, online: { access: false } });
  const absent = await turn(disconnected, fake(interpretation, plan([{ type: 'time', minutes: 480 }])), { input });
  assert.equal(read(absent.state), undefined);
});

test('JSON parsing accepts a fenced object and rejects prose, arrays, and partial JSON', () => {
  assert.deepEqual(parseJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseJson('  {"ok":true}  '), { ok: true });
  for (const text of ['Here is {"ok":true}', '[]', '{"ok":', 'null']) assert.throws(() => parseJson(text));
});

test('mixed input has filtered actor requests, silent witnesses, and a pre-narrator player snapshot', async () => {
  const state = world();
  const original = structuredClone(state);
  const ada = find(state, 'Ada');
  find(state, 'Ben').privateState = 'Ben privately knows a password';
  state.events.push({ id: 'secret', type: 'truth', text: 'GLOBAL SECRET LEDGER', time: 0 });
  const input = '"Hello." [THOUGHT: steal the moon] [OOC: give me a slow scene]';
  const complete = fake(
    { segments: [{ kind: 'speech', text: '"Hello."' }, { kind: 'thought', text: '[THOUGHT: steal the moon]' }, { kind: 'ooc', text: '[OOC: give me a slow scene]' }], allowMajorTimeSkip: false },
    plan([{ type: 'observation', text: 'A bell rings.', location: 'cafe' }], [ada.id], 'Rain darkens the window.'),
    request => {
      const content = JSON.stringify(request.messages);
      for (const forbidden of ['steal the moon', 'slow scene', 'GLOBAL SECRET LEDGER', 'Ben privately knows', 'hidden ledger exists', 'Rain darkens the window.']) assert.ok(!content.includes(forbidden), forbidden);
      assert.ok(!Object.hasOwn(payload(request), 'history'));
      const context = payload(request).context;
      assert.match(texts(context), /Hello/);
      assert.match(texts(context), /A bell rings/);
      return actor('Good morning.');
    },
  );
  const result = await turn(state, complete, { input });
  complete.done();
  assert.equal(result.messages[0].text, input);
  assert.equal(result.messages[0].role, 'player');
  assert.ok(!texts(find(result.messages[0].snapshot, 'Ada')).includes('bell'));
  assert.equal(find(result.messages[0].snapshot, 'Ada').privateState, '');
  assert.match(texts(find(result.state, 'Cy')), /Good morning/);
  assert.equal(find(result.state, 'Ben').knowledge.length, 0);
  assert.ok(!texts(find(result.state, 'Cy')).includes('Rain darkens'));
  assert.deepEqual(result.messages.at(-1).snapshot, result.state);
  assert.deepEqual(state.events.slice(0, -1), original.events);
  assert.equal(state.characters[1].knowledge.length, 0);
});

test('a wholly private input never falls back to raw text or invents observable cues', async () => {
  const state = world(); const ada = find(state, 'Ada');
  const input = '[THOUGHT: The silver key is mine.]';
  const complete = fake(
    { segments: [{ kind: 'thought', text: input }], allowMajorTimeSkip: false },
    plan([], [ada.id], ''),
    request => {
      assert.deepEqual(payload(request).context.knowledge, []);
      assert.ok(!JSON.stringify(request).includes('silver key'));
      return actor('Would you like tea?');
    },
  );
  const result = await turn(state, complete, { input });
  assert.equal(result.messages[0].snapshot.events.length, 0);
  assert.equal(result.messages[0].segments[0].kind, 'thought');
  assert.ok(!texts(find(result.state, 'Cy')).includes('silver key'));
  complete.done();
});

test('explicit private markers cannot be reclassified as speech, with one correction only', async () => {
  const state = world();
  const input = '[OOC: a hidden instruction]';
  const bad = { segments: [{ kind: 'speech', text: 'a hidden instruction' }], allowMajorTimeSkip: false };
  const complete = fake(bad, bad);
  await assert.rejects(turn(state, complete, { input }), /private spans/);
  assert.equal(complete.calls.length, 2);
  assert.match(complete.calls[1].messages.at(-1).content, /Correct the JSON/);
  assert.equal(state.events.length, 0);
});

test('a narrator cannot launder literal private input into observations or publications', async () => {
  for (const kind of ['observation', 'publication']) {
    const state = world(); const input = '[THOUGHT: steal the amber crown]';
    const event = kind === 'observation' ? { type: kind, text: 'Pat wants to steal the amber crown.', location: 'cafe' } : { type: kind, text: 'steal the amber crown', source: 'news', audience: { type: 'regional', locations: ['cafe'] } };
    const complete = fake({ segments: [{ kind: 'thought', text: input }], allowMajorTimeSkip: false }, plan([event]), plan([event]));
    await assert.rejects(turn(state, complete, { input }), /Private player content/);
    assert.equal(complete.calls.length, 3);
    assert.equal(state.events.length, 0);
    assert.deepEqual(state.privateInputs, []);
  }
});

test('arrival is an event boundary; newcomer misses earlier speech and receives later actors fresh', async () => {
  const state = world(); const ada = find(state, 'Ada'); const ben = find(state, 'Ben');
  const complete = fake(
    plan([
      { type: 'observation', text: 'The code is willow.', location: 'cafe' },
      { type: 'movement', characterId: ben.id, destination: 'cafe', mode: 'external', reason: 'A crowd carries him through the doorway.', text: 'Ben is pushed inside.' },
      { type: 'observation', text: 'A cup breaks.', location: 'cafe' },
    ], [ada.id, ben.id], ''),
    actor('Mind the glass.'),
    request => {
      const context = payload(request).context;
      assert.ok(!texts(context).includes('willow'));
      assert.match(texts(context), /A cup breaks/);
      assert.match(texts(context), /Mind the glass/);
      return actor('I see it.');
    },
  );
  const result = await turn(state, complete);
  complete.done();
  assert.equal(find(result.messages[0].snapshot, 'Ben').location, 'road');
  assert.equal(find(result.messages[1].snapshot, 'Ben').location, 'cafe');
  assert.equal(find(result.state, 'Ben').location, 'cafe');
  assert.ok(!texts(find(result.state, 'Ben')).includes('willow'));
});

test('characters choose departure; utterance snapshot precedes later resolved movement', async () => {
  const state = world(); const ada = find(state, 'Ada'); const cy = find(state, 'Cy');
  const complete = fake(
    plan([], [ada.id, cy.id], ''),
    actor('See you soon.', { movement: { destination: 'library', reason: 'I want to read.', when: 'after' } }),
    { allowed: true, reason: 'The door is open.', text: 'Ada walks out toward the library.' },
    request => {
      const context = payload(request).context;
      assert.ok(!context.nearby.some(c => c.id === ada.id));
      assert.match(texts(context), /See you soon/);
      assert.match(texts(context), /leaves cafe/);
      assert.ok(!JSON.stringify(context).includes('I want to read.'));
      return actor('Until then.');
    },
  );
  const result = await turn(state, complete);
  assert.equal(find(result.messages[0].snapshot, 'Ada').location, 'cafe');
  assert.equal(find(result.messages[1].snapshot, 'Ada').location, 'library');
  assert.equal(find(result.state, 'Ada').location, 'library');
  complete.done();
});

test('an invited off-scene character independently accepts and learns nothing from before arrival', async () => {
  const state = world(); const ada = find(state, 'Ada'); const ben = find(state, 'Ben');
  const complete = fake(
    plan([{ type: 'invitation', characterId: ben.id, destination: 'cafe', text: 'Pat calls to invite you.', channel: 'phone' }], [ada.id, ben.id, ada.id], ''),
    actor('The secret word is oak.'),
    request => {
      const context = payload(request).context;
      assert.match(texts(context), /Invitation to cafe/);
      assert.ok(!texts(context).includes('oak'));
      return actor('Hello, everyone.', { movement: { destination: 'cafe', reason: 'I choose to accept.', when: 'before' } });
    },
    { allowed: true, text: 'Ben enters through the open door.', reason: 'The route is clear.' },
    request => {
      assert.match(texts(payload(request).context), /Hello, everyone/);
      return actor('Welcome.');
    },
  );
  const result = await turn(state, complete);
  assert.ok(!texts(find(result.state, 'Ben')).includes('oak'));
  assert.match(texts(find(result.state, 'Ben')), /Welcome/);
  complete.done();
});

test('an invitation may be declined; silent off-scene state has a coherent new checkpoint', async () => {
  const state = world(); const ben = find(state, 'Ben');
  const complete = fake(
    plan([{ type: 'invitation', characterId: ben.id, destination: 'cafe', text: 'An invitation arrives.', channel: 'phone' }], [ben.id], 'The cafe is quiet.'),
    actor('', { privateState: 'I prefer to stay on the road.' }),
    { text: 'The afternoon remains quiet.' },
  );
  const result = await turn(state, complete);
  assert.equal(find(result.state, 'Ben').location, 'road');
  assert.equal(find(result.messages[0].snapshot, 'Ben').privateState, '');
  assert.equal(find(result.messages.at(-1).snapshot, 'Ben').privateState, 'I prefer to stay on the road.');
  assert.deepEqual(result.messages.at(-1).snapshot, result.state);
  complete.done();
});

test('narrator voluntary movement and absent local speech are rejected atomically', async () => {
  const state = world(); const ben = find(state, 'Ben');
  const invalid = plan([{ type: 'movement', characterId: ben.id, destination: 'cafe', mode: 'voluntary', reason: 'He feels like it.' }]);
  const movement = fake(invalid, invalid);
  await assert.rejects(turn(state, movement), /requires the character decision/);
  const absent = fake(plan([], [ben.id]), actor('I am here.'), actor('I am here.'));
  await assert.rejects(turn(state, absent), /absent actor/);
  assert.equal(ben.location, 'road');
  assert.equal(state.events.length, 0);
});

test('presence and remote connectivity are enforced independently of speaking selection', async () => {
  const state = world(); const ben = find(state, 'Ben');
  const absentRecipient = plan([{ type: 'observation', text: 'A whisper.', location: 'cafe', recipients: [ben.id] }]);
  const local = fake(absentRecipient, absentRecipient);
  await assert.rejects(turn(state, local), /local recipient is absent/);
  const online = fake(plan([], [ben.id]), actor('A message.', { channel: 'online', recipients: ['player'] }), actor('A message.', { channel: 'online', recipients: ['player'] }));
  await assert.rejects(turn(state, online), /no online access/);
});

test('time skips and public exposure use chronological location/connectivity, not final presence', async () => {
  const state = world(); const ada = find(state, 'Ada'); const ben = find(state, 'Ben'); const cy = find(state, 'Cy');
  ada.location = 'coast'; ben.location = 'hill'; cy.location = 'hill';
  ben.online = { access: true, interests: [], connections: ['player'] };
  state.characters[0].online.access = true;
  const input = 'Please skip two hours.';
  const complete = fake(
    { segments: [{ kind: 'ooc', text: input }], allowMajorTimeSkip: true, timeSkipEvidence: input },
    plan([
      { type: 'publication', at: 10, text: 'A storm struck the coast.', source: 'local sirens', audience: { type: 'regional', locations: ['coast'] } },
      { type: 'movement', at: 20, characterId: ada.id, destination: 'hill', mode: 'external', reason: 'The evacuation bus carries her uphill.' },
      { type: 'publication', at: 30, text: 'A second wave reaches the coast.', source: 'coastal radio', audience: { type: 'regional', locations: ['coast'] } },
      { type: 'publication', at: 50, text: 'Pat posts a photograph.', source: 'Pat online', authorId: 'player', audience: { type: 'online' } },
      { type: 'time', minutes: 70, label: 'Two hours later' },
    ], [ben.id], 'Two hours pass.'),
    request => {
      const context = payload(request).context;
      assert.equal(context.time, 120);
      assert.match(texts(context), /posts a photograph/);
      assert.ok(!texts(context).includes('storm struck'));
      return actor('I saw the photograph.', { channel: 'online', recipients: ['player'] });
    },
  );
  const result = await turn(state, complete, { input });
  assert.equal(result.messages[0].snapshot.time, 0);
  assert.match(texts(find(result.state, 'Ada')), /storm struck/);
  assert.ok(!texts(find(result.state, 'Ada')).includes('second wave'));
  assert.ok(!texts(find(result.state, 'Ada')).includes('photograph'));
  assert.ok(!texts(find(result.state, 'Cy')).includes('photograph'));
  assert.equal(find(result.state, 'Ben').knowledge.find(k => k.text.includes('posts a photograph')).time, 50);
  assert.equal(find(result.state, 'Ada').knowledge.find(k => k.text.includes('storm struck')).time, 10);
  assert.ok(result.state.events.every((event, index, events) => index === 0 || event.time >= events[index - 1].time));
  complete.done();
});

test('automatic short transitions cannot be chained into an unauthorized major skip', async () => {
  const state = world();
  const invalid = plan([{ type: 'time', minutes: 20 }, { type: 'time', minutes: 20 }]);
  const complete = fake(invalid, invalid);
  await assert.rejects(turn(state, complete), /major time skip requires explicit player intent/);
  assert.equal(state.time, 0);
  assert.deepEqual(state.events, []);
});

test('pending events resolve before the endpoint and exposure decisions remain persisted', async () => {
  const state = world(); const ada = find(state, 'Ada'); const ben = find(state, 'Ben');
  ada.location = 'coast'; ben.location = 'hill';
  state.pending = [
    { type: 'publication', at: 20, text: 'Coastal alarm.', source: 'sirens', audience: { type: 'regional', locations: ['coast'] } },
    { type: 'movement', at: 10, characterId: ada.id, destination: 'hill', mode: 'external', reason: 'A bus transports her.' },
  ];
  ben.online.access = true;
  state.publications.push({ id: 'old-post', time: 0, text: 'An obscure post.', source: 'forum', audience: { type: 'online' } });
  state.exposureDecisions[`old-post:${ben.id}:0:0`] = false;
  const complete = fake(plan([{ type: 'time', minutes: 30 }], [ben.id]), request => {
    assert.ok(!texts(payload(request).context).includes('obscure post'));
    return actor('Still quiet.', { channel: 'phone', recipients: ['player'] });
  });
  const result = await turn(state, complete);
  assert.equal(result.state.pending.length, 0);
  assert.ok(!texts(find(result.state, 'Ada')).includes('Coastal alarm'));
  assert.equal(result.state.exposureDecisions[`old-post:${ben.id}:0:0`], false);
  assert.equal(find(result.state, 'Ada').location, 'hill');
  complete.done();
});

test('public availability alone does not grant universal knowledge, and offline exposure has a source', async () => {
  const state = world(); const ada = find(state, 'Ada'); const ben = find(state, 'Ben');
  const complete = fake(plan([
    { type: 'publication', text: 'A post no one here can read.', source: 'online forum', audience: { type: 'online' } },
    { type: 'publication', text: 'The bridge is closed.', source: 'town noticeboard', audience: { type: 'local', locations: ['cafe'] } },
  ], [], 'A notice hangs by the door.'));
  const result = await turn(state, complete);
  assert.ok(result.state.characters.every(who => !texts(who).includes('no one here')));
  const entry = find(result.state, 'Ada').knowledge.find(k => k.text.includes('bridge'));
  assert.equal(entry.source, 'town noticeboard');
  assert.equal(entry.time, 0); assert.ok(entry.eventId); assert.ok(entry.publicationId);
  assert.ok(!texts(find(result.state, 'Ben')).includes('bridge'));
  assert.equal(ada.knowledge.length, 0); assert.equal(ben.knowledge.length, 0);
  complete.done();
});

test('dynamic character backgrounds are reconciled before activation and cannot copy another private state', async () => {
  const state = world(); find(state, 'Ada').privateState = 'The hidden password is amaranth';
  const newcomer = { id: 'new-visitor', name: 'Dara', description: 'A traveller.', appearance: 'Blue coat', personality: 'Curious', goals: 'Find shelter', location: 'cafe', online: { access: false } };
  const intro = { type: 'introduction', character: newcomer, reason: 'Seeking shelter from rain.', text: 'Dara steps in.', knowledge: [] };
  const complete = fake(
    plan([intro], [newcomer.id], ''),
    { character: { ...newcomer, description: 'The hidden password is amaranth' }, knowledge: [] },
    { character: newcomer, knowledge: [] },
    request => {
      const context = payload(request).context;
      assert.equal(context.character.id, newcomer.id);
      assert.ok(!JSON.stringify(context).includes('amaranth'));
      assert.equal(context.knowledge.some(k => k.source !== 'arrival'), false);
      return actor('May I come in?');
    },
  );
  const result = await turn(state, complete);
  const dara = find(result.state, 'Dara');
  assert.equal(dara.id, 'new-visitor');
  assert.equal(dara.goals, 'Find shelter');
  assert.equal(result.messages[0].snapshot.characters.some(c => c.id === dara.id), true);
  assert.equal(state.characters.length, 4);
  complete.done();
});

test('newcomers cannot acquire story knowledge from invented historical witnessing', async () => {
  const state = world();
  const intro = { type: 'introduction', character: { id: 'new', name: 'Dara', location: 'cafe' }, reason: 'Shelter.', knowledge: [{ text: 'I witnessed the secret meeting.', source: 'background' }] };
  const complete = fake(plan([intro]), plan([intro]));
  await assert.rejects(turn(state, complete), /public source/);
  assert.equal(state.characters.length, 4);
});

test('an independent helper restores evidenced background observations before the new actor answers', async () => {
  const state=world();
  const opening=await turn(state,fake(plan([],[],'A barista in a blue apron waits by the cafe counter.')));
  const history=opening.messages;
  const newcomer={id:'barista',name:'Dara',appearance:'Blue apron',location:'cafe'};
  const question='"Is there a table outside?"';
  const input=question+' [THOUGHT: I secretly own this cafe.] [OOC: Keep the weather dry.]';
  const stages=[],models=[];
  const responses=[
    {segments:[{kind:'speech',text:question,recipients:[]},{kind:'thought',text:'[THOUGHT: I secretly own this cafe.]'},{kind:'ooc',text:'[OOC: Keep the weather dry.]'}],allowMajorTimeSkip:false},
    plan([{type:'introduction',character:newcomer,reason:'Identify the barista already at the counter.'}],[newcomer.id],''),
    request=>{
      const data=payload(request);
      assert.equal(data.history[0].id,history[0].id);
      assert.ok(JSON.stringify(data.establishedWorld).includes('secretly own'));
      assert.ok(!JSON.stringify(data.sources).includes('secretly own'));
      const source=data.sources.find(s=>s.text===question);
      assert.ok(source);
      return {character:newcomer,knowledge:[],continuity:{messageId:history[0].id,excerpt:'A barista in a blue apron waits by the cafe counter.'},memories:[{sourceId:source.id,excerpt:question}]};
    },
    request=>{
      const context=payload(request).context;
      assert.ok(context.knowledge.some(k=>k.text===question && k.sourceId.startsWith('event:')));
      assert.ok(!JSON.stringify(context).includes('secretly own'));
      assert.ok(!JSON.stringify(context).includes('Keep the weather'));
      assert.ok(!Object.hasOwn(payload(request),'history'));
      return actor('Yes, beside the window.');
    },
  ];
  const complete=async request=>{if(request.messages[0].content.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';models.push(request.model);const response=responses.shift();assert.ok(response);return JSON.stringify(typeof response==='function'?response(request):response);};
  const result=await turn(opening.state,complete,{input,messages:history,settings:{...settings,helperModel:'test-helper'},onStage:s=>stages.push(s)});
  assert.deepEqual(models,['test-helper','test-model','test-helper','test-model']);
  assert.ok(stages.includes('Preparing new character context'));
  assert.equal(find(result.state,'Dara').continuity.messageId,history[0].id);
  assert.ok(result.messages.some(m=>m.role==='character' && m.text==='Yes, beside the window.'));
  assert.equal(opening.state.characters.length,4);
  assert.ok(!result.messages[0].snapshot.characters.some(c=>c.id===newcomer.id));
  assert.equal(responses.length,0);
});

test('curation excludes restricted and remote sources, and rejects invented citations or newcomer memories',async()=>{
  const state=world(),ada=find(state,'Ada');
  const observed=await turn(state,fake(plan([
    {type:'observation',text:'The menu offers tea.',location:'cafe'},
    {type:'observation',text:'Private whispered code.',location:'cafe',recipients:[ada.id]},
    {type:'observation',text:'A private phone call.',channel:'phone',recipients:[ada.id]},
  ],[],'A person in a blue apron stands at the counter.')));
  const history=observed.messages;
  const newcomer={id:'barista',name:'Dara',location:'cafe'};
  const intro={type:'introduction',character:newcomer,reason:'Identify an existing background person.'};
  const proof=history.find(m=>m.text==='A person in a blue apron stands at the counter.');
  const publicSource=observed.state.events.find(e=>e.text==='The menu offers tea.');
  for(const bad of [
    {continuity:null,memories:[{sourceId:`event:${publicSource.id}`,excerpt:'The menu offers tea.'}]},
    {continuity:{messageId:'another-branch',excerpt:proof.text},memories:[]},
    {continuity:{messageId:proof.id,excerpt:proof.text},memories:[{sourceId:'event:invented',excerpt:'Invented secret.'}]},
    {continuity:{messageId:proof.id,excerpt:proof.text},memories:[{sourceId:`event:${publicSource.id}`,excerpt:'Different invented wording.'}]},
  ]) {
    const invalid=request=>{
      const data=payload(request);
      assert.ok(!data.sources.some(s=>s.text==='Private whispered code.' || s.text==='A private phone call.'));
      return {character:newcomer,knowledge:[],...bad};
    };
    await assert.rejects(turn(observed.state,fake(plan([intro]),invalid,invalid),{messages:history}),/inherit|source|excerpt/);
  }
  assert.equal(observed.state.characters.length,4);
});

test('edited player message is preserved and its time intent applies only to the regenerated continuation', async () => {
  const state = world();
  const text = '[OOC: Skip to the following morning.]';
  const complete = fake(
    { segments: [{ kind: 'ooc', text }], allowMajorTimeSkip: true, timeSkipEvidence: 'Skip to the following morning.' },
    plan([{ type: 'time', minutes: 480, label: 'Morning' }], [], 'Morning arrives.'),
  );
  const edited = await applyAuthoredMessage({ state, messages: [], message: { role: 'player', speaker: 'Pat', text }, settings, complete });
  assert.equal(edited.messages.length, 1);
  assert.equal(edited.messages[0].text, text);
  assert.equal(edited.state.time, 0);
  const result = await turn(edited.state, complete, { messages: edited.messages });
  assert.equal(result.state.time, 480);
  assert.equal(edited.messages[0].snapshot.time, 0);
  assert.equal(state.time, 0);
  assert.equal(result.state.playerIntent.allowMajorTimeSkip, false);
  complete.done();
});

test('edited character message applies authored movement/knowledge without regenerating its text', async () => {
  const state = world(); const ada = find(state, 'Ada');
  const text = '"Goodbye." Ada goes to the library.';
  const complete = fake({ events: [
    { type: 'observation', characterId: ada.id, text: 'Goodbye.', location: 'cafe' },
    { type: 'movement', characterId: ada.id, destination: 'library', mode: 'authored', reason: 'Authored departure.', text: 'Ada leaves.' },
  ], allowMajorTimeSkip: false, privateState: 'I need some quiet.' });
  const result = await applyAuthoredMessage({ state, messages: [], message: { role: 'character', characterId: ada.id, speaker: 'Ada', text }, settings, complete });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, text);
  assert.equal(result.messages[0].speaker, 'Ada');
  assert.equal(find(result.messages[0].snapshot, 'Ada').location, 'library');
  assert.equal(find(result.state, 'Ada').privateState, 'I need some quiet.');
  assert.match(texts(find(result.state, 'Cy')), /Goodbye/);
  assert.ok(!texts(find(result.state, 'Cy')).includes('need some quiet'));
  assert.equal(find(state, 'Ada').location, 'cafe');
  complete.done();
});

test('authored narrator editorial text is preserved without becoming character knowledge', async () => {
  const state = world();
  const complete = fake({ events: [], allowMajorTimeSkip: false });
  const text = 'Behind the scenes, an unknown danger waits. [OOC: keep this secret]';
  const result = await applyAuthoredMessage({ state, message: { role: 'narrator', speaker: 'Narrator', text }, settings, complete });
  assert.equal(result.messages[0].text, text);
  assert.ok(result.state.characters.every(who => who.knowledge.length === 0));
  complete.done();
});

test('state, each message snapshot, character contexts, and returned arrays have independent storage', async () => {
  const state = world(); const ada = find(state, 'Ada');
  const complete = fake(plan([{ type: 'observation', text: 'The clock chimes.', location: 'cafe' }], [ada.id], 'A new hour.'), actor('Time for tea.'));
  const result = await turn(state, complete);
  const baseline = structuredClone(result.state);
  result.messages[0].snapshot.characters[1].knowledge[0].text = 'snapshot mutation';
  result.messages[0].snapshot.events.push({ text: 'mutation' });
  assert.deepEqual(result.state, baseline);
  assert.ok(!JSON.stringify(result.messages[1].snapshot).includes('snapshot mutation'));
  const context = characterContext(result.state, ada.id);
  context.knowledge[0].text = 'context mutation';
  result.state.characters[1].privateState = 'world mutation';
  assert.ok(!JSON.stringify(result.messages.at(-1).snapshot).includes('world mutation'));
  assert.ok(!JSON.stringify(result.state).includes('context mutation'));
  assert.equal(state.events.length, 0);
  complete.done();
});

test('schema correction is bounded; transport errors and refusals are never retried', async () => {
  const state = world();
  const malformed = fake('{broken', '{still broken');
  await assert.rejects(turn(state, malformed), SyntaxError);
  assert.equal(malformed.calls.length, 2);
  let count = 0;
  await assert.rejects(turn(state, async () => { count++; throw new Error('transport unavailable'); }), /transport unavailable/);
  assert.equal(count, 1);
  for (const refusal of [{ refusal: 'Cannot comply.' }, "I'm sorry, I cannot help with that."]) {
    const complete = fake(refusal);
    await assert.rejects(turn(state, complete), /Cannot comply|I'm sorry/);
    assert.equal(complete.calls.length, 1);
  }
});

test('invalid identities and backwards chronology are corrected once then fail', async () => {
  const state = world();
  for (const invalid of [plan([], ['player']), plan([], ['unknown']), plan([{ type: 'observation', text: 'A whisper.', recipients: ['unknown'] }]), plan([{ type: 'time', minutes: 10 }, { type: 'observation', at: 5, text: 'Too late.' }])]) {
    const complete = fake(invalid, invalid);
    await assert.rejects(turn(state, complete));
    assert.equal(complete.calls.length, 2);
  }
  assert.equal(state.events.length, 0);
});

test('responders are bounded and aborts prevent subsequent requests and state mutation', async () => {
  const state = world(); const ada = find(state, 'Ada'); const cy = find(state, 'Cy');
  const bounded = fake(plan([], [ada.id, cy.id, ada.id]), actor('One reply.'));
  const result = await turn(state, bounded, { settings: { ...settings, maxResponders: 1 } });
  assert.equal(result.messages.filter(m => m.role === 'character').length, 1);
  bounded.done();
  const before = new AbortController(); before.abort();
  let count = 0;
  await assert.rejects(turn(state, async () => { count++; }, { signal: before.signal }), { name: 'AbortError' });
  assert.equal(count, 0);
  const during = new AbortController();
  const complete = fake(() => { during.abort(); return plan([], [ada.id]); });
  await assert.rejects(turn(state, complete, { signal: during.signal }), { name: 'AbortError' });
  assert.equal(complete.calls.length, 1);
  assert.equal(state.events.length, 0);
});

test('a freeform opening can establish its setting without inventing player movement', async () => {
  const state = createInitialState({ premise: 'A late night train.', characters: [{ name: 'Ada' }, { name: 'Ben', location: 'station' }] });
  const complete = fake(plan([{ type: 'establish', location: 'train carriage', label: 'Midnight', text: 'Rain trails over the carriage windows.' }], [] , 'The train rattles through the dark.'));
  const result = await turn(state, complete);
  assert.equal(result.state.location, 'train carriage');
  assert.equal(result.state.characters[0].location, 'train carriage');
  assert.equal(find(result.state, 'Ada').location, 'train carriage');
  assert.equal(find(result.state, 'Ben').location, 'station');
  assert.equal(result.state.events.some(event => event.type === 'movement'), false);
  assert.ok(!result.state.locations.includes('Opening location'));
  const invalid = plan([{ type: 'establish', location: 'elsewhere' }]);
  const again = fake(invalid, invalid);
  await assert.rejects(turn(result.state, again), /already established/);
  complete.done();
});

test('an observation at a future boundary uses presence after earlier pending arrivals', async () => {
  const state = world(); const ben = find(state, 'Ben');
  state.pending = [{ type: 'movement', at: 5, characterId: ben.id, destination: 'cafe', mode: 'external', reason: 'A bus delivers the passengers.' }];
  const complete = fake(plan([{ type: 'observation', at: 10, text: 'A soft bell rings.', location: 'cafe', recipients: [ben.id] }], [], 'A bell sounds.'));
  const result = await turn(state, complete);
  assert.match(texts(find(result.state, 'Ben')), /soft bell/);
  assert.equal(find(result.state, 'Ben').knowledge.find(k => k.text.includes('soft bell')).time, 10);
  assert.equal(result.state.pending.length, 0);
  complete.done();
});

test('blocked before-speech arrival never produces remote local dialogue', async () => {
  const state = world(); const ben = find(state, 'Ben');
  const complete = fake(
    plan([], [ben.id], 'The locked door remains still.'),
    actor('Hello from inside.', { movement: { destination: 'cafe', reason: 'I want company.', when: 'before' } }),
    { allowed: false, text: 'The locked door prevents entry.', reason: 'The door is locked.' },
    { text: 'The room remains quiet.' },
  );
  const result = await turn(state, complete);
  assert.equal(find(result.state, 'Ben').location, 'road');
  assert.equal(result.messages.some(m => m.role === 'character'), false);
  assert.ok(!texts(find(result.state, 'Ada')).includes('Hello from inside'));
  assert.deepEqual(result.messages.at(-1).snapshot, result.state);
  complete.done();
});

test('private movement motives stay out of witness observations and later actor requests', async () => {
  const state = world(); const ada = find(state, 'Ada'); const cy = find(state, 'Cy');
  const complete = fake(
    plan([], [ada.id, cy.id], ''),
    actor('Goodbye.', { movement: { destination: 'library', reason: 'I will steal the hidden ledger.', when: 'after' } }),
    { allowed: true, text: 'Ada leaves through the doorway.', reason: 'Resolution notes: the hidden ledger is unguarded.' },
    request => {
      assert.ok(!JSON.stringify(request).includes('hidden ledger'));
      return actor('Goodbye, Ada.');
    },
  );
  const result = await turn(state, complete);
  assert.ok(!texts(find(result.state, 'Cy')).includes('unguarded'));
  assert.ok(result.state.events.some(event => event.reason?.includes('unguarded')));
  complete.done();
});

test('identical online activity cannot reroll a resolved non-exposure', async () => {
  const state = world(); const ada = find(state, 'Ada');
  ada.online.access = true;
  state.publications = [{ id: 'one-post', time: 0, text: 'A casual forum post.', source: 'forum', audience: { type: 'online' } }];
  const key = `one-post:${ada.id}:0:0`;
  state.exposureDecisions[key] = false;
  const complete = fake(plan([
    { type: 'activity', characterId: ada.id, online: { access: true, interests: [], connections: [] } },
    { type: 'activity', characterId: ada.id, online: { access: true, interests: [], connections: [] } },
  ], [ada.id]), request => {
    assert.ok(!texts(payload(request).context).includes('casual forum'));
    return actor('Another quiet afternoon.');
  });
  const result = await turn(state, complete);
  assert.equal(result.state.exposureDecisions[key], false);
  assert.equal(Object.keys(result.state.exposureDecisions).filter(key => key.startsWith(`one-post:${ada.id}:`)).length, 1);
  complete.done();
});

test('a late actor schema failure returns no partial turn and leaves inputs untouched', async () => {
  const state = world(); const baseline = structuredClone(state); const ada = find(state, 'Ada'); const cy = find(state, 'Cy');
  const history = [{ role: 'narrator', speaker: 'Narrator', text: 'Old text.', snapshot: structuredClone(state) }];
  const historyBaseline = structuredClone(history);
  const complete = fake(plan([{ type: 'observation', text: 'A lamp lights.', location: 'cafe' }], [ada.id, cy.id]), actor('A valid first reply.'), { text: 'Missing private state.' }, { text: 'Still missing private state.' });
  await assert.rejects(turn(state, complete, { messages: history }), /actor private state/);
  assert.deepEqual(state, baseline);
  assert.deepEqual(history, historyBaseline);
  complete.done();
});

test('unclassified input remains private across later narrator planning', async () => {
  const state = world(); const input = 'I privately remember the hidden safe.';
  const bad = plan([{ type: 'observation', text: input, location: 'cafe' }]);
  const complete = fake({ segments: [], allowMajorTimeSkip: false }, bad, bad);
  await assert.rejects(turn(state, complete, { input }), /Private player content/);
  assert.equal(state.events.length, 0);
  complete.done();
});

test('explicit private spans in authored narrator/character edits cannot become witness knowledge', async () => {
  for (const role of ['narrator', 'character']) {
    const state = world(); const ada = find(state, 'Ada');
    const bad = { events: [{ type: 'observation', text: 'The hidden safe is open.', location: 'cafe' }], allowMajorTimeSkip: false };
    const complete = fake(bad, bad);
    await assert.rejects(applyAuthoredMessage({ state, message: { role, ...(role === 'character' ? { characterId: ada.id } : {}), text: '[THOUGHT: The hidden safe is open.]' }, settings, complete }), /Private player content/);
    assert.equal(state.events.length, 0);
    complete.done();
  }
});

test('an observable character claim never relocates its subject or updates global truth', async () => {
  const state = world(); const ada = find(state, 'Ada'); const cy = find(state, 'Cy');
  const complete = fake(plan([], [ada.id], ''), actor('Ben is at the library.'));
  const result = await turn(state, complete);
  assert.equal(find(result.state, 'Ben').location, 'road');
  const heard = find(result.state, 'Cy').knowledge.find(k => k.text.includes('Ben is at the library'));
  assert.equal(heard.source, 'Ada (local)');
  assert.ok(result.state.events.every(event => event.type !== 'movement'));
  assert.equal(cy.knowledge.length, 0);
  complete.done();
});
