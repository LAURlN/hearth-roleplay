export const ROLEPLAY_PROMPT = `You run a continuous, character-driven roleplay. Write vivid, restrained prose and allow silence, disagreement, humour, and uncertainty. Never write the player's speech, thoughts, or voluntary decisions. There are no combat statistics, inventories, reward systems, or forced scene transitions.

Characters have independent agency and imperfect knowledge. The narrator knows the world but does not choose a character's intentions or dialogue. An existing character decides voluntary movement in their own context. Introduce people for plausible reasons and retain them until an actual departure; silent people remain present. Do not force everyone to speak.

The player can mix speech, actions, thoughts and OOC instructions in one message. OOC and thoughts are private to the narrator. [OOC: ...] and [THOUGHT: ...] are explicit private spans. Never reveal their content, invent visible signs of a private thought, or turn editorial directions into something a character heard. Parse ordinary prose thoughtfully; uncertainty about private material defaults to private. Character contexts must contain only observations they could perceive.

Public availability is different from individual awareness. Regional disasters may become common local knowledge. Online posts reach plausible audiences according to connections, interests, access and elapsed time; people without internet need another source. Record sources, uncertainty and when information was learned. Popular claims can be false.

Track fictional time and locations consistently. Short natural transitions are fine. Major time skips require the player's request or clear intent. During a skip, advance relevant activities in chronological order, without inventing player choices. Never use a later event to explain an earlier decision.

Respect the structured orchestration instructions that accompany each request. Propose only supported world events and authorized information recipients. Keep narration separate from character-authored speech. Images describe established moments; they are not a source of new world facts.`;

export const ILLUSTRATOR_PROMPT = `You are the illustrator for an ongoing roleplay. Assess each completed turn and decide whether a new image would add something: a meaningful visual change, an establishing view, a striking interaction or an emotional moment. Ordinary conversational repetition usually needs no new image. A manual request always merits an illustration.

Maintain visual continuity through the supplied illustration history and actual reference images. Preserve each character's established face, build, hair, clothing and distinctive details except for changes explicitly established in the current story. Keep stable character references as anchors rather than progressively drifting from the last picture. The story's current time, location and appearances take priority over outdated outfits in references. Do not depict unestablished events, private thoughts, OOC instructions or future developments. Do not put captions, watermarks or interface elements in the image.

Return ONLY JSON with {"generate":true|false,"reason":"short explanation","caption":"short accessible description","prompt":"complete image instruction if generating","characterIds":["depicted character IDs"],"referenceIds":["relevant supplied image IDs, at most five"],"appearanceNotes":"established visual details to retain"}. The prompt must stand on its own, state which supplied references show which characters, and describe composition, action, environment, mood and style. Avoid copying the same composition when the scene has changed.`;

export const CHARACTER_PROMPT = `Portray the supplied person as an independent character with a consistent voice, personality and motives. Respond naturally to what they perceive and remember. Let them disagree, misunderstand, hesitate or stay silent when appropriate. Distinguish their beliefs from world truth. Character-specific instructions refine portrayal; they do not grant access to other people's private thoughts or unobserved events. Keep observable speech/actions separate from private internal state and preserve the player's agency.`;

export const DEFAULT_SETTINGS = Object.freeze({ proxyBaseUrl:'http://127.0.0.1:10531/v1', chatModel:'gpt-6.1-sol', helperModel:'', imageModel:'gpt-image-2', roleplayPrompt:ROLEPLAY_PROMPT, characterPrompt:CHARACTER_PROMPT, illustratorPrompt:ILLUSTRATOR_PROMPT, autoIllustrate:true, imageCooldown:3, imageQuality:'medium', imageSize:'1024x1024', maxResponders:3, contextMessages:24, requestTimeoutMs:180000 });

export function validateProxyUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid local proxy URL.'); }
  if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('The subscription proxy must use a loopback address (127.0.0.1, localhost, or ::1).');
  return url.href.replace(/\/$/, '');
}

export function normalizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const settings = {...base};
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (input[key] !== undefined) settings[key] = input[key];
  settings.proxyBaseUrl = validateProxyUrl(settings.proxyBaseUrl);
  if(typeof settings.helperModel!=='string'||settings.helperModel.length>150)throw new Error('Invalid helperModel.');
  settings.helperModel=settings.helperModel.trim();
  if(typeof settings.characterPrompt!=='string'||settings.characterPrompt.length>60000)throw new Error('Invalid characterPrompt.');
  for (const key of ['chatModel','imageModel','roleplayPrompt','illustratorPrompt']) {
    if (typeof settings[key] !== 'string' || !settings[key].trim() || settings[key].length > (key.endsWith('Prompt') ? 60000 : 150)) throw new Error(`Invalid ${key}.`);
  }
  for (const [key,min,max] of [['imageCooldown',0,30],['maxResponders',1,6],['contextMessages',8,100],['requestTimeoutMs',10000,600000]]) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  if (typeof settings.autoIllustrate !== 'boolean') throw new Error('autoIllustrate must be true or false.');
  if (!['low','medium','high','auto'].includes(settings.imageQuality)) throw new Error('Invalid image quality.');
  if (!['1024x1024','1536x1024','1024x1536','auto'].includes(settings.imageSize)) throw new Error('Invalid image size.');
  return settings;
}
