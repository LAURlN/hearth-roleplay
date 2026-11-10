import { randomUUID, createHash } from 'node:crypto';

// All mutable values crossing this module's boundary are copied. The caller owns
// persistence and commits only a successfully completed turn.
const clone = value => structuredClone(value);
const id = () => randomUUID();
const SHORT_TRANSITION = 30;
const CHANNELS = ['local', 'phone', 'online'];
const PRIVATE = new Set(['thought', 'ooc', 'ambiguous']);
const EVENT_TYPES = new Set(['establish', 'background', 'observation', 'movement', 'time', 'publication', 'invitation', 'introduction', 'activity']);

function check(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value, label, empty = false) {
  check(typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= 60000, `Invalid ${label}.`);
  return value;
}
function array(value, label, max = 100) {
  check(Array.isArray(value) && value.length <= max, `Invalid ${label}.`);
  return value;
}
function character(state, characterId) {
  const found = state.characters.find(c => c.id === characterId);
  check(found, 'Unknown character identity.');
  return found;
}
function aborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Generation cancelled.', 'AbortError');
}

export function parseJson(text) {
  string(text, 'model response');
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const result = JSON.parse(fenced ? fenced[1] : trimmed);
  check(object(result), 'Expected a JSON object.');
  return result;
}

class RefusalError extends Error {}
async function generate(env, stage, instruction, payload, validate) {
  aborted(env.signal);
  env.onStage?.(stage);
  const requests = [
    { role: 'system', content: `${env.settings.roleplayPrompt || 'Tell a coherent roleplay story with independent character agency.'}\n\n${instruction}\nReturn ONLY a JSON object. No Markdown, commentary, or response_format dependency. If you must refuse, return {"refusal":"reason"}.` },
    { role: 'user', content: JSON.stringify(payload) },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    aborted(env.signal);
    // Transport failures and refusals are never retried or routed elsewhere.
    const raw = await env.complete({ model: env.settings.chatModel || 'gpt-6.1-sol', messages: clone(requests), signal: env.signal, json: true });
    aborted(env.signal);
    if (typeof raw === 'string' && /^(?:I'm sorry|I am sorry|I cannot (?:help|assist|comply)|I can't (?:help|assist|comply))/i.test(raw.trim())) throw new RefusalError(raw);
    try {
      const result = parseJson(raw);
      if (typeof result.refusal === 'string') throw new RefusalError(result.refusal);
      validate(result);
      return result;
    } catch (error) {
      if (error instanceof RefusalError || attempt === 1) throw error;
      requests.push({ role: 'assistant', content: typeof raw === 'string' ? raw : '' });
      requests.push({ role: 'user', content: `Correct the JSON/schema error: ${error.message}. Return the same proposal corrected to the required schema; do not add new story developments.` });
    }
  }
}

function online(value = {}) {
  value = object(value) ? value : {};
  return { access: value.access === true, interests: Array.isArray(value.interests) ? [...new Set(value.interests.filter(x => typeof x === 'string'))].sort() : [], connections: Array.isArray(value.connections) ? [...new Set(value.connections.filter(x => typeof x === 'string'))].sort() : [] };
}
function makeCharacter(value, characterId, location) {
  return { id: characterId, name: String(value.name || 'Stranger'), description: String(value.description || ''), appearance: String(value.appearance || ''), personality: String(value.personality || ''), goals: String(value.goals || ''), location: String(value.location || location), knowledge: [], privateState: '', online: online(value.online) };
}

export function createInitialState(setup = {}) {
  const location = typeof setup.location === 'string' && setup.location.trim() ? setup.location : 'Opening location';
  const player = makeCharacter({ ...setup.persona, name: setup.persona?.name || 'You', location }, 'player', location);
  const cast = (Array.isArray(setup.characters) ? setup.characters : []).map(c => makeCharacter(c, id(), location));
  return {
    time: 0, timeLabel: 'Story begins', location, locations: [...new Set([location, ...cast.map(c => c.location)])],
    characters: [player, ...cast], events: [], publications: [], exposureDecisions: {}, pending: [],
    premise: String(setup.premise || ''), title: String(setup.title || 'Untitled story'), sharedBackground: [],
    playerIntent: { allowMajorTimeSkip: false }, privateInputs: [],
  };
}

// No branch history, raw player input, global event log, other characters' goals,
// other private states, unencountered publications or off-scene positions enter here.
export function characterContext(state, characterId) {
  const self = character(state, characterId);
  check(characterId !== 'player', 'The player is never an AI actor.');
  return clone({
    character: { id: self.id, name: self.name, description: self.description, appearance: self.appearance, personality: self.personality, goals: self.goals, privateState: self.privateState, online: self.online },
    time: state.time, timeLabel: state.timeLabel, location: self.location,
    sharedBackground: state.sharedBackground || [],
    memory: self.memory ? { summary: self.memory.summary, through: self.memory.through, time: self.memory.time } : null,
    knowledge: self.knowledge.slice(self.memory?.through ?? 0),
    nearby: state.characters.filter(c => c.id !== self.id && c.location === self.location).map(c => ({ id: c.id, name: c.name, appearance: c.appearance })),
  });
}

function message(state, role, text, characterId, extra = {}) {
  const who = characterId ? character(state, characterId) : null;
  return { id: id(), role, ...(characterId ? { characterId } : {}), speaker: role === 'narrator' ? 'Narrator' : who?.name || 'You', text, createdAt: new Date().toISOString(), ...clone(extra), snapshot: clone(state) };
}
function remember(state, recipient, text, source, eventId) {
  // Sources are checked before delivery. A legitimate later utterance can
  // disclose something the player previously only thought, to its actual audience.
  const who = character(state, recipient);
  if (!who.knowledge.some(k => k.eventId === eventId && k.text === text)) who.knowledge.push({ id: id(), text, source, time: state.time, ...(eventId ? { eventId } : {}) });
}
function assertObservable(state, text, { authored = false, characterId } = {}) {
  if (typeof text !== 'string') return;
  for (const hidden of state.privateInputs || []) {
    // Literal source fragments are a final code-level guard, in addition to the
    // conservative classifier. Semantic separation is specified in every prompt.
    if (hidden.length > 2 && text.toLowerCase().includes(hidden.toLowerCase())) {
      const known = characterId && character(state, characterId).knowledge.some(entry => entry.text.toLowerCase().includes(hidden.toLowerCase()));
      check(authored || known, 'Private player content cannot enter an observable context.');
    }
  }
}
function log(state, event) {
  const entry = { ...clone(event), id: id(), time: state.time };
  state.events.push(entry);
  return entry;
}
function locationExists(state, destination) {
  if (!state.locations.includes(destination)) state.locations.push(destination);
}

function validateRecipients(state, event) {
  if (event.recipients !== undefined) for (const recipient of array(event.recipients, 'recipients')) character(state, recipient);
  const channel = event.channel || 'local';
  check(CHANNELS.includes(channel), 'Invalid communication channel.');
  if (channel !== 'local') check(Array.isArray(event.recipients) && event.recipients.length > 0, 'Remote communication needs explicit recipients.');
  if (channel === 'online') {
    if (event.characterId) check(character(state, event.characterId).online.access, 'Sender has no online access.');
    for (const recipient of event.recipients) check(character(state, recipient).online.access, 'Recipient has no online access.');
  }
  if (channel === 'local') {
    const location = event.location || (event.characterId ? character(state, event.characterId).location : state.location);
    for (const recipient of event.recipients || []) check(character(state, recipient).location === location, 'A local recipient is absent.');
  }
}
function observe(state, proposal, source = 'perception', authorization = {}) {
  validateRecipients(state, proposal);
  const sourceAuthority = { ...authorization, characterId: proposal.characterId };
  assertObservable(state, proposal.text, sourceAuthority);
  assertObservable(state, source, sourceAuthority);
  const location = proposal.location || (proposal.characterId ? character(state, proposal.characterId).location : state.location);
  const recipients = proposal.recipients || state.characters.filter(c => c.location === location).map(c => c.id);
  const entry = log(state, { ...proposal, type: 'observation', location, recipients });
  const learners = new Set([...recipients, ...(proposal.characterId ? [proposal.characterId] : [])]);
  for (const recipient of learners) remember(state, recipient, proposal.text, source, entry.id);
  return entry;
}
function move(state, characterId, destination, reason, text, authorization = {}) {
  const who = character(state, characterId);
  const from = who.location;
  locationExists(state, destination);
  // Arrival and departure are distinct observations. Arrival confers no past knowledge.
  if (from !== destination) {
    observe(state, { text: `${who.name} leaves ${from}.`, location: from, characterId }, 'departure');
    who.location = destination;
    if (characterId === 'player') state.location = destination;
    const entry = log(state, { type: 'movement', characterId, from, destination, reason });
    observe(state, { text: text || `${who.name} arrives at ${destination}.`, location: destination, characterId }, 'arrival', authorization);
    exposure(state);
    return entry;
  }
}

function isAudience(pub, who) {
  const audience = pub.audience;
  if (audience.type === 'regional' || audience.type === 'local') return audience.locations.includes(who.location);
  return who.online.access && (!audience.characterIds?.length || audience.characterIds.includes(who.id));
}
function exposure(state) {
  for (const pub of state.publications) {
    if (pub.time > state.time || (pub.expiresAt !== undefined && state.time > pub.expiresAt)) continue;
    for (const who of state.characters) {
      if (who.knowledge.some(k => k.publicationId === pub.id) || !isAudience(pub, who)) continue;
      // One decision per actual reading opportunity (hour), including negative
      // outcomes. A later hour or a newly established activity is a new opportunity.
      const key = `${pub.id}:${who.id}:${Math.floor(state.time / 60)}:${who.exposureEpoch || 0}`;
      let result = state.exposureDecisions[key];
      if (result === undefined) {
        const connected = who.id === pub.authorId || who.online.connections.includes(pub.authorId) || who.online.connections.includes(state.characters.find(c => c.id === pub.authorId)?.name);
        const relevant = (pub.audience.interests || []).some(interest => who.online.interests.includes(interest));
        const probability = pub.audience.type !== 'online' || connected ? 1 : relevant ? 0.75 : 0.15;
        const sample = createHash('sha256').update(key).digest().readUInt32BE(0) / 0x100000000;
        result = sample < probability;
        state.exposureDecisions[key] = result;
      }
      if (result) {
        const event = log(state, { type: 'exposure', characterId: who.id, publicationId: pub.id, source: pub.source, text: pub.text });
        remember(state, who.id, pub.text, pub.source, event.id);
        who.knowledge.at(-1).publicationId = pub.id;
      }
    }
  }
}

function validateAudience(state, audience) {
  check(object(audience) && ['online', 'regional', 'local'].includes(audience.type), 'Invalid publication audience.');
  if (audience.type !== 'online') array(audience.locations, 'audience locations').forEach(x => string(x, 'audience location'));
  if (audience.characterIds) array(audience.characterIds, 'audience identities').forEach(x => character(state, x));
  if (audience.interests) array(audience.interests, 'audience interests').forEach(x => string(x, 'interest'));
}
function validateEvent(state, event, { authoredCharacterId } = {}) {
  check(object(event) && EVENT_TYPES.has(event.type), 'Unsupported event type.');
  if (event.at !== undefined) check(Number.isFinite(event.at) && event.at >= state.time, 'Events must be chronological.');
  if (event.text !== undefined) string(event.text, 'event text', true);
  switch (event.type) {
    case 'background':
      string(event.text, 'shared background');
      check(event.text.length <= 5000, 'Shared background must be concise.');
      assertObservable(state, event.text);
      for (const who of state.characters) if (who.privateState?.length > 3) check(!event.text.includes(who.privateState), 'Shared background cannot contain a character private state.');
      break;
    case 'establish':
      check(state.time === 0 && state.events.length === 0 && state.location === 'Opening location', 'The opening setting is already established.');
      string(event.location, 'opening location');
      if (event.label !== undefined) { string(event.label, 'opening time label'); assertObservable(state, event.label); }
      break;
    case 'observation':
      string(event.text, 'observation');
      if (event.characterId) character(state, event.characterId);
      validateRecipients(state, event);
      break;
    case 'movement':
      character(state, event.characterId);
      string(event.destination, 'movement destination'); string(event.reason, 'movement cause');
      check(event.mode === 'external' || (event.mode === 'authored' && event.characterId === authoredCharacterId), 'Voluntary movement requires the character decision request.');
      // Neither narration nor another actor may choose the player's actions.
      check(event.characterId !== 'player' || event.mode === 'external' || authoredCharacterId === 'player', 'Cannot choose player movement.');
      break;
    case 'time':
      check(Number.isFinite(event.minutes) && event.minutes >= 0, 'Invalid elapsed minutes.');
      if (event.label !== undefined) { string(event.label, 'time label'); assertObservable(state, event.label); }
      break;
    case 'publication':
      string(event.text, 'publication'); string(event.source, 'publication source');
      assertObservable(state, event.text, { characterId: event.authorId }); assertObservable(state, event.source, { characterId: event.authorId });
      validateAudience(state, event.audience);
      if (event.authorId) character(state, event.authorId);
      if (event.expiresAt !== undefined) check(Number.isFinite(event.expiresAt) && event.expiresAt >= (event.at ?? state.time), 'Invalid publication expiry.');
      break;
    case 'invitation':
      character(state, event.characterId); check(event.characterId !== 'player', 'Do not direct the player.');
      string(event.text, 'invitation'); string(event.destination, 'invitation destination');
      validateRecipients(state, { ...event, recipients: [event.characterId] });
      break;
    case 'introduction':
      check(object(event.character), 'Missing new character definition.');
      string(event.character.id, 'new character ID'); string(event.character.location, 'new character location');
      string(event.character.name, 'new character name'); string(event.reason, 'introduction reason');
      check(!state.characters.some(c => c.name.toLowerCase() === event.character.name.toLowerCase()), 'Reuse existing character identities.');
      if (event.character.id) check(!state.characters.some(c => c.id === event.character.id) && event.character.id !== 'player', 'Duplicate character identity.');
      for (const entry of event.knowledge || []) {
        check(object(entry) && typeof entry.publicationId === 'string', 'Newcomer knowledge requires a public source; do not invent past witnesses.');
        check(state.publications.some(p => p.id === entry.publicationId), 'Unknown newcomer knowledge source.');
      }
      break;
    case 'activity':
      character(state, event.characterId);
      check(object(event.online), 'Activity requires online circumstances.');
      check(typeof event.online.access === 'boolean', 'Invalid online access.');
      assertObservable(state, JSON.stringify(event.online));
      break;
  }
}

function clock(state, target, env) {
  check(Number.isFinite(target) && target >= state.time, 'Story time cannot go backwards.');
  check(env.allowMajorTimeSkip || target - env.startTime <= SHORT_TRANSITION, 'A major time skip requires explicit player intent.');
  // Pending events retain their own historical circumstances; never jump to the
  // endpoint first and retroactively expose everybody from their final location.
  state.pending.sort((a, b) => a.at - b.at);
  while (state.time < target || (state.pending.length && state.pending[0].at <= target)) {
    if (state.pending.length) check(state.pending[0].at >= state.time, 'Pending event precedes the current clock.');
    const candidates = state.publications.some(pub => pub.time <= state.time && (pub.expiresAt === undefined || pub.expiresAt >= state.time) && state.characters.some(who => isAudience(pub, who) && !who.knowledge.some(k => k.publicationId === pub.id)));
    const nextHour = candidates ? (Math.floor(state.time / 60) + 1) * 60 : Infinity;
    const nextPending = state.pending[0]?.at ?? Infinity;
    state.time = Math.min(target, nextHour, nextPending);
    while (state.pending.length && state.pending[0].at <= state.time) {
      const next = state.pending.shift();
      check(next.type !== 'time', 'Pending events must be instantaneous; use their absolute at time.');
      applyEvent(state, next, env);
    }
    exposure(state);
  }
  state.time = target;
  exposure(state);
}
function applyEvent(state, event, env) {
  check(object(event), 'Invalid event.');
  if (event.at !== undefined) {
    check(Number.isFinite(event.at) && event.at >= state.time, 'Events must be chronological.');
    if (event.at > state.time) clock(state, event.at, env);
  }
  // Validate presence after earlier scheduled events, at the actual event time.
  validateEvent(state, event, env);
  switch (event.type) {
    case 'background':
      if (!state.sharedBackground.includes(event.text)) state.sharedBackground.push(event.text);
      log(state, event);
      break;
    case 'establish': {
      const previous = state.location;
      state.location = event.location; locationExists(state, event.location);
      for (const who of state.characters) if (who.location === previous) who.location = event.location;
      state.locations = state.locations.filter(place => place !== previous);
      if (event.label) state.timeLabel = event.label;
      log(state, event);
      if (event.text) observe(state, { text: event.text, location: event.location }, 'opening surroundings');
      break;
    }
    case 'observation': observe(state, event, event.source || 'perception'); break;
    case 'movement': move(state, event.characterId, event.destination, event.reason, event.text); break;
    case 'time':
      clock(state, state.time + event.minutes, env);
      if (event.label) state.timeLabel = event.label;
      log(state, { type: 'time', minutes: event.minutes, label: state.timeLabel });
      break;
    case 'publication': {
      const pub = { ...clone(event), id: id(), time: state.time };
      state.publications.push(pub); log(state, { type: 'publication', publicationId: pub.id, text: pub.text, source: pub.source });
      exposure(state);
      break;
    }
    case 'invitation':
      observe(state, { ...event, type: 'observation', text: `${event.text} (Invitation to ${event.destination}.)`, recipients: [event.characterId], location: event.location || character(state, event.characterId).location }, 'invitation');
      break;
    case 'introduction': {
      check(event.reconciled === true, 'New character background has not been reconciled.');
      const newcomer = makeCharacter(event.character, event.character.id || id(), event.character.location || state.location);
      state.characters.push(newcomer); locationExists(state, newcomer.location);
      log(state, { type: 'introduction', characterId: newcomer.id, reason: event.reason });
      // Only genuinely accessible publications can support initial story knowledge.
      for (const known of event.knowledge || []) {
        const pub = state.publications.find(p => p.id === known.publicationId);
        check(pub.time <= state.time && (pub.expiresAt === undefined || pub.expiresAt >= state.time) && isAudience(pub, newcomer), 'Newcomer cannot access that source.');
      }
      // Proposed familiarity is not an exposure bypass. Resolve sources by the
      // same persisted audience/exposure rules used for the existing cast.
      observe(state, { text: event.text || `${newcomer.name} arrives.`, location: newcomer.location, characterId: newcomer.id }, 'arrival');
      exposure(state);
      break;
    }
    case 'activity': {
      const who = character(state, event.characterId);
      const updated = online({ ...who.online, ...event.online });
      if (JSON.stringify(who.online) !== JSON.stringify(updated)) who.exposureEpoch = (who.exposureEpoch || 0) + 1;
      who.online = updated;
      log(state, event); exposure(state); break;
    }
  }
}

const EVENT_SCHEMA = `Events execute in array order. Supported events:
{"type":"background","text":"ordinary pre-existing shared cultural/world knowledge, not a personal secret or a new story development"}. Establish a few essential public setting facts from the premise so characters share the right fictional world. Never include hidden causes or facts requiring personal exposure; use observations/publications for recent events instead.
{"type":"establish","location":"specific opening place","label":"opening time of day","text":"visible opening surroundings"}. Use ONLY as the very first event when the player is still at placeholder Opening location. It establishes the initial setting without inventing player movement. Predefined characters with actual locations retain them; people at the placeholder start at the established place.
{"type":"observation","text":"perceivable fact or claim only, never editorial/private explanation","location":"place","recipients":["optional exact IDs; omit for all local witnesses"],"channel":"local|phone|online"}.
{"type":"movement","characterId":"ID","destination":"place","mode":"external","reason":"external force, NOT voluntary choice","text":"visible arrival"}. Voluntary existing-character movement MUST instead be an invitation then that character's own decision. Never invent player choices.
{"type":"invitation","characterId":"ID","destination":"place","text":"invitation or opportunity they actually receive","channel":"phone|online|local","location":"source location for local"}.
{"type":"time","minutes":number,"label":"narrative time"}. At most 30 minutes total automatic transition per turn. Major skips only with supplied player authorization. Do not interrupt an ongoing conversation with an unwanted skip.
{"type":"publication","text":"published claim, NOT hidden causes","source":"named source","authorId":"optional ID","audience":{"type":"online|regional|local","locations":["required for regional/local"],"interests":["online topics"],"characterIds":["optional restricted online audience"]},"expiresAt":optionalNumber}.
{"type":"activity","characterId":"ID","online":{"access":boolean,"interests":[],"connections":[]}} establishes actual current connectivity/activity, not retroactive knowledge.
{"type":"introduction","character":{"id":"new stable ID unique in world","name":"name","description":"own background","appearance":"public appearance","personality":"traits","goals":"own motives","location":"place","online":{"access":false,"interests":[],"connections":[]}},"reason":"plausible arrival motivated by their own background","text":"visible arrival","knowledge":[{"publicationId":"optional established accessible publication ID"}]}.
Each event may have absolute fictional minute "at" >= current time. Keep events chronological, including within time skips. Never ascribe character dialogue or intentions to the narrator. Observations and publications are claims, not assignments of truth or relocation. Never publish private/OOC content or invent visible cues from a thought. Do not use observation events to bypass movement, time, publication or agency rules. Physical presence is persistent; silent witnesses still perceive eligible observations. Location names are exact strings.`;

function narratorHistory(messages, limit) {
  return messages.slice(-limit).map(({ role, characterId, speaker, text }) => ({ role, characterId, speaker, text }));
}
function validatePlan(state, result, env) {
  array(result.events, 'events', 60);
  // Simulate ordered transitions to validate recipients at their actual boundary.
  // Introduction reconciliation is handled separately, not trusted from the model.
  const trial = clone(state);
  for (const event of result.events) {
    if (event.type === 'introduction') {
      applyEvent(trial, { ...event, reconciled: true }, env);
    } else applyEvent(trial, event, env);
  }
  if (result.speakers !== undefined) {
    array(result.speakers, 'speakers', 20);
    for (const speakerId of result.speakers) {
      check(typeof speakerId === 'string' && speakerId !== 'player', 'Invalid speaker identity.');
      character(trial, speakerId);
    }
  }
  if (result.text !== undefined) string(result.text, 'narrator text', true);
}

function privateSpans(text) {
  const spans = [];
  const pattern = /\[(OOC|THOUGHT)\s*:\s*([^\]]*)(?:\]|$)/gi;
  for (const match of text.matchAll(pattern)) spans.push({ start: match.index, end: match.index + match[0].length, text: match[2].trim(), kind: match[1].toLowerCase() });
  return spans;
}
function protectPrivateInputs(state, input, segments = null) {
  const fragments = privateSpans(input).map(span => span.text);
  // Anything the interpreter leaves unclassified is private as well. It may not
  // be silently reintroduced by the later omniscient narrator request.
  if (segments) {
    let cursor = 0;
    for (const segment of segments) {
      const start = input.indexOf(segment.text, cursor);
      fragments.push(input.slice(cursor, start).trim());
      if (PRIVATE.has(segment.kind)) fragments.push(segment.text.replace(/^\[(?:OOC|THOUGHT)\s*:\s*/i, '').replace(/\]$/, '').trim());
      cursor = start + segment.text.length;
    }
    fragments.push(input.slice(cursor).trim());
  }
  state.privateInputs ||= [];
  for (const fragment of fragments) if (fragment && /[\p{L}\p{N}]/u.test(fragment) && !state.privateInputs.includes(fragment)) state.privateInputs.push(fragment);
}
function validateSegments(state, input, result) {
  array(result.segments, 'input segments', 80);
  const spans = privateSpans(input);
  const trial = clone(state);
  let cursor = 0;
  for (const segment of result.segments) {
    check(object(segment) && ['speech', 'action', 'thought', 'ooc', 'ambiguous'].includes(segment.kind), 'Invalid input segment kind.');
    string(segment.text, 'verbatim input segment');
    const start = input.indexOf(segment.text, cursor);
    check(start !== -1, 'Segments must be verbatim, ordered excerpts of the authored text.');
    cursor = start + segment.text.length;
    if (!PRIVATE.has(segment.kind)) {
      check(!spans.some(span => start < span.end && cursor > span.start), 'Explicit private spans cannot be observable.');
      if (segment.destination) {
        check(segment.kind === 'action', 'Only an authored action can move the player.');
        string(segment.destination, 'player destination');
        move(trial, 'player', segment.destination, 'Player-authored movement.', segment.text, { authored: true });
      }
      check(!segment.location || segment.location === trial.location, 'Player observation has no established location.');
      validateRecipients(trial, { ...segment, characterId: 'player', location: trial.location });
    } else check(!segment.destination && !segment.recipients, 'Private segments have no observable side effects.');
  }
  check(typeof result.allowMajorTimeSkip === 'boolean', 'Missing time skip intent.');
  if (result.allowMajorTimeSkip) {
    string(result.timeSkipEvidence, 'explicit time skip evidence');
    check(input.includes(result.timeSkipEvidence), 'Time skip authorization must cite the actual authored request.');
    const thoughts = spans.filter(span => span.kind === 'thought');
    let cursor = 0;
    for (const segment of result.segments) {
      const start = input.indexOf(segment.text, cursor); cursor = start + segment.text.length;
      if (segment.kind === 'thought' || segment.kind === 'ambiguous') thoughts.push({ start, end: cursor });
    }
    let position = -1, authorized = false;
    while ((position = input.indexOf(result.timeSkipEvidence, position + 1)) !== -1) if (!thoughts.some(span => position < span.end && position + result.timeSkipEvidence.length > span.start)) authorized = true;
    check(authorized, 'Private thoughts cannot authorize a major time skip.');
  }
}

async function interpretPlayer(env, state, input) {
  return generate(env, 'Interpreting player input', `You are the narrator's private input interpreter. Split mixed input conservatively; unclassified/ambiguous material stays narrator-only. Return {"segments":[{"kind":"speech|action|thought|ooc|ambiguous","text":"EXACT ordered substring of input","channel":"local|phone|online (observable only)","recipients":["optional exact IDs"],"destination":"only explicit player-authored movement action"}],"allowMajorTimeSkip":false,"timeSkipEvidence":"required exact request excerpt only if true"}. Omit nonapplicable fields. No rewriting, inferred cues, consequences or invented speech. Explicit [OOC:...] and [THOUGHT:...] spans are always private. Parentheses/italics alone do not determine privacy. A wholly private message may have zero observable segments. Identify time skip intent semantically; do not treat a thought about tomorrow as a request to skip. You may see all narrator state, but your observable segments must contain only directly authored actions/speech.`, { state, input }, result => validateSegments(state, input, result));
}
function applyPlayer(state, input, interpretation) {
  protectPrivateInputs(state, input, interpretation.segments);
  for (const segment of interpretation.segments) {
    if (PRIVATE.has(segment.kind)) continue;
    if (segment.destination) move(state, 'player', segment.destination, 'Player-authored movement.', segment.text, { authored: true });
    observe(state, { text: segment.text, characterId: 'player', location: character(state, 'player').location, channel: segment.channel || 'local', ...(segment.recipients ? { recipients: segment.recipients } : {}) }, `player ${segment.kind}`, { authored: true });
  }
  state.playerIntent = { allowMajorTimeSkip: interpretation.allowMajorTimeSkip, ...(interpretation.allowMajorTimeSkip ? { evidence: interpretation.timeSkipEvidence } : {}) };
}

async function reconcileIntroduction(env, state, event) {
  const result = await generate(env, 'Reconciling new character', `You are the narrator reconciling a new person's background BEFORE activation. Return {"character":{same fields and identity as proposal},"knowledge":[{"publicationId":"accessible existing source ID"}]}. Preserve the proposed name, ID and physical location. Retain independent motives, personality and original background, but remove invented past witnessing, knowledge of branch secrets, and retroactive relationships that imply undisclosed information. A newly invented background must not encode secret world facts, private thoughts/OOC or other characters' private state. No invented historical exposure. Initial story-event knowledge is limited to the supplied accessible publications. If an existing person fits, the proposal should have reused them instead.`, { proposal: event, establishedWorld: state }, result => {
    check(object(result.character) && result.character.id === event.character.id && result.character.name === event.character.name && result.character.location === event.character.location, 'Reconciliation cannot replace identity or location.');
    validateEvent(state, { ...event, character: result.character, knowledge: result.knowledge || [] }, env);
    // Guard literal leaks even if the reconciler accidentally copies private state.
    const background = JSON.stringify(result.character);
    assertObservable(state, background);
    for (const who of state.characters) if (who.privateState?.length > 3) check(!background.includes(who.privateState), 'New background contains another character private state.');
  });
  return { ...event, character: result.character, knowledge: result.knowledge || [], reconciled: true };
}

async function enactPlan(env, state, plan, output, { display = true } = {}) {
  for (let event of plan.events) {
    aborted(env.signal);
    if (event.at !== undefined && event.at > state.time) clock(state, event.at, env);
    if (event.type === 'introduction') event = await reconcileIntroduction(env, state, event);
    applyEvent(state, event, env);
    // Each visible event is its own boundary; a later arrival never changes an
    // earlier message's snapshot. Editorial narration itself teaches nobody.
    const visibleHere = event.type === 'introduction' ? character(state, event.character.id).location === state.location : event.type === 'movement' ? character(state, event.characterId).location === state.location || state.events.some(e => e.type === 'movement' && e.characterId === event.characterId && e.time === state.time && e.from === state.location) : (event.location || state.location) === state.location;
    if (display && event.text && visibleHere && !['background', 'publication', 'invitation', 'activity'].includes(event.type)) output.push(message(state, 'narrator', event.text));
  }
  if (display && plan.text?.trim()) output.push(message(state, 'narrator', plan.text));
}

function validateActor(state, who, result) {
  string(result.text, 'actor text', true);
  string(result.privateState, 'actor private state', true);
  if (result.channel !== undefined) check(CHANNELS.includes(result.channel), 'Invalid actor channel.');
  if (result.recipients !== undefined) for (const recipient of array(result.recipients, 'actor recipients')) character(state, recipient);
  if (result.movement != null) {
    check(object(result.movement), 'Invalid movement intent.');
    string(result.movement.destination, 'intended destination'); string(result.movement.reason, 'own movement reason');
    check(['before', 'after'].includes(result.movement.when), 'Movement must occur before or after the utterance.');
  }
  const channel = result.channel || 'local';
  if (result.text.trim()) {
    if (!(result.movement?.when === 'before' && channel === 'local')) validateRecipients(state, { ...result, characterId: who.id, location: who.location });
    check(channel !== 'local' || who.location === state.location || (result.movement?.when === 'before' && result.movement.destination === state.location), 'An absent actor cannot speak in the player location.');
    if (channel !== 'local') check(result.recipients?.includes('player'), 'Displayed remote speech must reach the player.');
    assertObservable(state, result.text, { characterId: who.id });
  }
}
async function resolveMovement(env, state, who, intent, output) {
  const result = await generate(env, `Resolving ${who.name}'s movement`, `You are the narrator resolving feasibility of a character's OWN voluntary movement intent. You may approve or block its physical feasibility and describe external consequences. Do not change their chosen destination, consent, intentions or dialogue. Return {"allowed":boolean,"text":"observable arrival/departure or obstruction, no private reasoning","reason":"physical resolution"}. No time skip or extra actions.`, { world: state, intent: { characterId: who.id, ...intent } }, result => {
    check(typeof result.allowed === 'boolean', 'Missing movement resolution.');
    string(result.text, 'movement narration', true); string(result.reason, 'movement resolution reason');
  });
  const oldLocation = who.location;
  if (result.allowed) move(state, who.id, intent.destination, result.reason, result.text);
  else if (result.text) observe(state, { text: result.text, location: who.location }, 'blocked movement');
  if (result.text && (oldLocation === state.location || who.location === state.location)) output.push(message(state, 'narrator', result.text));
  return result.allowed;
}

function environment(options, state) {
  check(typeof options.complete === 'function', 'A complete() transport must be supplied.');
  const settings = options.settings || {};
  return { complete: options.complete, signal: options.signal, onStage: options.onStage, settings, startTime: state.time, allowMajorTimeSkip: false };
}

export async function runTurn(options) {
  const state = clone(options.state);
  const history = clone(options.messages || []);
  const env = environment(options, state);
  const output = [];
  aborted(env.signal);
  if (options.input !== null && options.input !== undefined) {
    const input = string(options.input, 'player input');
    const interpretation = await interpretPlayer(env, state, input);
    applyPlayer(state, input, interpretation);
    output.push(message(state, 'player', input, 'player', { segments: interpretation.segments }));
  }
  env.allowMajorTimeSkip = state.playerIntent?.allowMajorTimeSkip === true;
  const intent = clone(state.playerIntent || {});
  state.playerIntent = { allowMajorTimeSkip: false };
  const limit = Math.max(1, Math.min(100, Number.isInteger(env.settings.contextMessages) ? env.settings.contextMessages : 24));
  const plan = await generate(env, 'Narrating surroundings', `You are the omniscient narrator/planner, NOT a character controller. Establish the opening from premise if needed. Return {"text":"player-visible narration, may be empty; never private thoughts, OOC or hidden facts","events":[],"speakers":["ordered character IDs, never player"]}. ${EVENT_SCHEMA}\nNarration text does not automatically teach characters anything: explicitly specify observable events for what witnesses should learn. Conversely do not repeat all events in text. Select only relevant speakers; silent presence persists. An absent character may receive an invitation and decide to enter in its own request. A new character must have a unique explicit ID and location and will undergo background reconciliation. Select at most ${Math.max(0, Math.min(6, env.settings.maxResponders ?? 3))} responders. Player message state is already applied; do not replay its observable segments. Process relevant events chronologically before post-skip actor contexts.`, { world: state, history: narratorHistory([...history, ...output], limit), playerIntent: intent }, result => validatePlan(state, result, env));
  await enactPlan(env, state, plan, output);
  const max = Math.max(0, Math.min(6, Number.isInteger(env.settings.maxResponders) ? env.settings.maxResponders : 3));
  for (const speakerId of (plan.speakers || []).slice(0, max)) {
    aborted(env.signal);
    const who = character(state, speakerId);
    const response = await generate(env, `${who.name} is responding`, `You play ONLY the supplied character. Your entire permitted perspective is in context; do not assume you know anything from narrator/global history or other people's private thoughts. Nearby people are physically present, not necessarily speaking. Use only your own observations/background; distinguish claims from truth. Decide your own speech, silence, thoughts and voluntary movement. Never control the player or another character. Return {"text":"ONLY your observable speech/actions, empty for silence; no private reasoning or narrator prose","privateState":"updated own internal state, not displayed","channel":"local|phone|online","recipients":["optional exact known IDs; remote speech must include player"],"movement":null|{"destination":"place","reason":"your OWN intention","when":"before|after"}}. Do not narrate successful movement in text until narrator resolution. An absent person cannot speak in the current player scene without moving there first or an established remote channel. Remote communication requires explicit recipients. Choosing not to accept an invitation is valid.`, { context: characterContext(state, who.id) }, result => validateActor(state, who, result));
    who.privateState = response.privateState;
    let movementAllowed = true;
    if (response.movement?.when === 'before') movementAllowed = await resolveMovement(env, state, who, response.movement, output);
    const blockedArrival = !movementAllowed && (response.channel || 'local') === 'local' && who.location !== state.location;
    if (response.text.trim() && !blockedArrival) {
      validateActor(state, who, { ...response, movement: null });
      const observed = observe(state, { text: response.text, characterId: who.id, location: who.location, channel: response.channel || 'local', ...(response.recipients ? { recipients: response.recipients } : {}) }, `${who.name} (${response.channel || 'local'})`);
      if (observed.recipients.includes('player')) output.push(message(state, 'character', response.text, who.id));
    }
    if (response.movement?.when === 'after') await resolveMovement(env, state, who, response.movement, output);
  }
  // A silent/off-scene decision still changes the world. Give that state a new
  // narrative checkpoint rather than mutating an earlier message's snapshot.
  if (!output.length || JSON.stringify(output.at(-1).snapshot) !== JSON.stringify(state)) {
    const closing = await generate(env, 'Closing the moment', `Return {"text":"a brief player-visible pause, surroundings or editorial response appropriate to the current moment"}. Do not invent dialogue, actions, visible cues from thoughts, new facts, or private disclosures. This is a checkpoint for already resolved events, not an extra development.`, { world: state, history: narratorHistory([...history, ...output], limit) }, result => string(result.text, 'closing narration'));
    output.push(message(state, 'narrator', closing.text));
  }
  aborted(env.signal);
  return { state: clone(state), messages: clone(output) };
}

export async function applyAuthoredMessage(options) {
  const state = clone(options.state);
  const authored = clone(options.message);
  check(object(authored) && ['player', 'narrator', 'character'].includes(authored.role), 'Invalid authored role.');
  string(authored.text, 'authored message');
  const env = environment(options, state);
  const output = [];
  if (authored.role === 'player') {
    const interpretation = await interpretPlayer(env, state, authored.text);
    applyPlayer(state, authored.text, interpretation);
    output.push(message(state, 'player', authored.text, 'player', { segments: interpretation.segments }));
  } else {
    protectPrivateInputs(state, authored.text);
    if (authored.role === 'character') {
      character(state, authored.characterId);
      check(authored.characterId !== 'player', 'Invalid authored character.');
      env.authoredCharacterId = authored.characterId;
    }
    const plan = await generate(env, 'Reconciling edited message', `A human has authored an edited ${authored.role} message. Preserve its exact displayed text. Do NOT rewrite or generate a continuation. Return {"events":[],"allowMajorTimeSkip":false,"timeSkipEvidence":"exact edited text excerpt required only if true","privateState":"optional edited character's own private thoughts"}. Reconcile only established consequences of THIS message. Editorial narration is not automatically observable; separate genuinely perceptible portions into observations. Character dialogue is observable to its actual witnesses; private thoughts stay private. Never add a new player choice. For an explicitly authored voluntary movement of the edited character only, mode "authored" is permitted. Significant time shifts explicitly written by the human count as user intent; cite their exact words. ${EVENT_SCHEMA}`, { world: state, history: narratorHistory(options.messages || [], env.settings.contextMessages || 24), message: { role: authored.role, characterId: authored.characterId, speaker: authored.speaker, text: authored.text } }, result => {
      check(typeof result.allowMajorTimeSkip === 'boolean', 'Missing authored time intent.');
      if (result.allowMajorTimeSkip) check(typeof result.timeSkipEvidence === 'string' && result.timeSkipEvidence.trim() && authored.text.includes(result.timeSkipEvidence), 'Edited skip needs exact authored evidence.');
      const validationEnv = { ...env, allowMajorTimeSkip: result.allowMajorTimeSkip };
      validatePlan(state, result, validationEnv);
      if (result.privateState !== undefined) {
        check(authored.role === 'character', 'Only edited character may receive private state.');
        string(result.privateState, 'edited private state', true);
      }
    });
    env.allowMajorTimeSkip = plan.allowMajorTimeSkip;
    await enactPlan(env, state, plan, output, { display: false });
    if (authored.role === 'character' && plan.privateState !== undefined) character(state, authored.characterId).privateState = plan.privateState;
    output.push(message(state, authored.role, authored.text, authored.role === 'character' ? authored.characterId : undefined));
  }
  if (authored.speaker) output[0].speaker = authored.speaker;
  aborted(env.signal);
  return { state: clone(state), messages: clone(output) };
}
