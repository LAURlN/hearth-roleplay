# Roleplay design discussion

Status: planning. Accepted requirements and proposed behavior are distinguished below; this is not an implementation specification.

## Accepted requirements

- Focus on freeform text roleplay, without the old combat, equipment, and game-content generation systems.
- Characters have independent contexts and cleanly separated knowledge.
- The narrator may know everyone's secrets and controls surroundings and consequences. Characters control their own speech, intentions, and choices.
- The narrator may introduce new characters automatically. Recurring characters retain their individual contexts.
- Scene presence must be stable, explicit, dynamic, and narratively natural: track where characters are, when they appear, and when they leave.
- Role prompts are editable. An illustrator can assess each completed turn and generate an image when appropriate.
- Every AI request, including images, must use the user's ChatGPT subscription, without a separate OpenAI Platform API key or paid API fallback.
- Target Android through a locally hosted browser interface and Termux backend.
- The player experiences one continuous conversation. Locations, simultaneous activity, and internal scene boundaries are managed behind the interface; the player does not switch scene modes or manage a cast roster.
- Time skips are supported within normal roleplay.
- The narrator may handle short transitions automatically. Major time skips require the player's request or clear intent, preserving ongoing conversations the player wants to play.
- A player message may mix observable actions, speech, private thoughts, and OOC instructions. Only the narrator receives OOC instructions; other characters cannot receive private thoughts.
- Rewinding to a message restores the corresponding world state and all character knowledge.
- Knowledge spreads naturally beyond direct witnesses through local shared events, public information, online activity, and individual exposure. Public availability is distinct from actual character awareness.
- Starting a story uses a freeform premise and player persona, with optional predefined characters. The narrator establishes the opening and introduces other characters as needed; the setup can be saved and edited for reuse.
- Provide a configurable general roleplay/narration system prompt and a separate configurable illustrator system prompt. Retain individual character definitions alongside the general rules.
- The illustrator uses a continuing illustration conversation/history and previous images for character and visual consistency rather than starting unrelated image requests each time.
- The user can copy, edit, and delete any player, narrator, or character message.
- Editing or deleting an earlier message creates a revised story branch and regenerates the AI continuation from that boundary. Preserve the old continuation as a separate recoverable branch. Restore and rebuild dependent world state and character knowledge consistently.

## Existing working integration supplied by the user

- SillyTavern: http://127.0.0.1:8000.
- openai-oauth proxy: http://127.0.0.1:10531/v1.
- Chat model: gpt-6.1-sol.
- Image model: gpt-image-2, exposed through POST /v1/images/generations.
- Authentication: ChatGPT account through Codex OAuth; no separate Platform API key.
- Quick Image Gen works in SillyTavern with enableCorsProxy enabled.
- Reference project: https://github.com/EvanZhouDev/openai-oauth.

## Proposed presence design

- Keep physical location, perception, and turn selection separate. A silent bystander remains present; a person in the same building may still be unable to hear a whisper.
- Maintain one authoritative record of whereabouts and an ordered log of arrivals, departures, and observations. Construct each character's context from their permitted observations.
- AI outputs propose actions and transitions. Application rules validate and record them; a generated list of names never silently replaces the current cast.
- Character movement reflects that character's own decisions. The narrator resolves its feasibility and consequences and may arrange external arrivals or introduce new people, without writing existing characters' intentions for them.
- Resolve presence at event boundaries inside a turn, not only once per player message. Someone who enters halfway through an exchange receives subsequent observable events, not the earlier conversation.
- Introduce arrivals and departures through visible story events. Natural causes can include invitations, duties, interrupted conversations, opening hours, or an established reason to seek someone out. Avoid arbitrary per-turn arrival rolls or forced cast rotation.
- Enforce invariants: a character has one physical location at a time; presence persists until an explicit transition; an absent character cannot speak into the current room without a communication channel; arrival does not confer prior scene knowledge; re-entry preserves prior personal knowledge.
- Distinguish world facts from claims. A character saying someone is elsewhere does not itself relocate that person.
- Rewind or regenerate from the original event boundary, restoring presence and dependent memories together. Attach asynchronous image jobs to the story revision that requested them.
- Provide an inspector for whereabouts, transition reasons, and observations so unexpected behavior can be understood and corrected.

### Refinements from independent design review

- Use utterances and movement as the initial event boundaries. Split an utterance explicitly only when an interruption changes who can perceive which part.
- For an existing character's voluntary entrance, ask that character to decide from their own permitted context. The narrator may create an invitation or opportunity, but cannot decide that they accept it. A new character may enter with a motivation established in their initial background.
- External displacement is distinct from a voluntary decision: the narrator can resolve someone being carried out without inventing their consent.
- Reconcile a newcomer's proposed background with established events before activation. Creating a character must not invent past witnesses or disclose existing secrets without a justified source.
- Player-visible narration does not automatically become character-visible information. Silent witnesses can receive observations without an AI generation call.
- If a later generation fails, retain already committed events and resume at the next event boundary. Incomplete generated proposals must not update presence or knowledge. Rewind invalidates later derived state and late generation results together.

## Proposed continuous conversation and knowledge design

### Mixed player messages

- Give the original player message to the narrator/input interpreter only. Produce ordered segments for dialogue, observable action, private thought, and OOC instruction before constructing any character context.
- Preserve natural-language input and optionally support explicit markers such as [OOC: ...] and [THOUGHT: ...] for unambiguous intent. Do not treat all italicized text or parentheses as a single category.
- Characters receive only authorized observable segments and resolved consequences. Never fall back to supplying the raw message when no observable segment remains; a wholly private message is valid.
- Keep ambiguous potentially private content narrator-only until its scope is resolved. Store segment classification with the originating message so it is stable across subsequent turns.
- Private thoughts do not automatically create observable cues. Characters may infer emotions from separately established behavior, without receiving the thought or its private explanation.
- OOC instructions can deliberately change the fiction through narrator-resolved events, but their wording and editorial rationale never become character knowledge.

### Public information and exposure

- Distinguish the event, its publication or observable effects, each character's exposure, and what that character believes. A claim becoming popular does not make it true.
- Model ordinary shared background knowledge separately from information learned during the story. Shared background must exclude recent branch-specific events and character secrets.
- A regional event can explicitly confer awareness on an affected population. For the user's tsunami example, local residents can learn that the tsunami happened without automatically learning hidden causes, all casualties, or private events associated with it.
- Online publication makes a post available to a defined audience; it does not distribute the post into every character's context. Audience membership, platform use, social connections, interests, activity times, and relevance determine plausible exposure.
- A connected and directly relevant character may have strong or guaranteed exposure; a casual user has a possible exposure; a disconnected character has no internet exposure but may learn later through another channel.
- Record actual exposure, its source, and the time learned. Use the character's circumstances at the historical time of exposure, not their current location or connectivity when generating a response.
- Resolve uncertain exposure once per opportunity. Persist the outcome, including a resolved non-exposure, so regenerating a reply does not reroll knowledge. Replaying a saved branch preserves its outcomes; new story developments may create new opportunities.
- Broad audience rules can be evaluated lazily from historical state when a character becomes relevant, avoiding an AI call for every resident. Persist resolved outcomes and reconcile newly created characters' past exposure with the established timeline.

### Time skips and rewind

- Advance story time explicitly. Resolve relevant movement, scheduled activity, news propagation, and exposure across the skipped interval before building post-skip character contexts.
- Preserve chronological event boundaries during a skip: a post published near its end must not influence a character's earlier actions. Do not simulate every minute or call every character merely because time elapsed.
- Associate each message with a story checkpoint, including internal events generated before the next displayed message.
- Rewind restores whereabouts, story time, observations, beliefs, private state, resolved exposure outcomes, pending events, and the cast as of the selected boundary. Invalidate later summaries, search indexes, character introductions, and image attachments; reject late requests from the abandoned revision.
- Keep later branches separate from the active timeline. No discarded event may remain available through prompts, summaries, retrieval, or a global public-information cache.
- Rewind controls should distinguish continuing after a retained message from undoing that message. The same interface can support replacing a message by rewinding to its preceding boundary.

## Open design decisions

- Off-scene activity: continuously simulated, or advanced only when time passes or a relevant event justifies it? Recommendation: advance on relevant events and elapsed story time, without calling every character every turn.
- Interaction structure is settled at the user interface level: one continuous conversation with internal location and event management. The scope of autonomous off-screen developments still needs to be settled.
- Private input presentation: natural prose plus optional explicit markers is proposed; exact conventions and ambiguity handling remain to be refined.
- Branch retention after edits/deletions is settled: preserve the original continuation separately and generate a revised continuation. Pure rewind should use the same branch mechanism.

## Proposed prompts, illustration continuity, and message controls

- Present separate general roleplay/narration and illustrator prompt editors. Version prompt changes so generation history remains reproducible; apply changes prospectively unless the user explicitly regenerates earlier content.
- Combine general roleplay rules with the relevant character's own identity and permitted knowledge. Configure the illustrator independently from actor contexts.
- Maintain one continuing illustration history per story branch, including generated prompts, actual images, established appearances, and relevant visual changes over story time. The renderer must receive actual visual references, not only text saying to remember an earlier picture.
- Keep stable character references available alongside recent scene images so repeated continuation does not compound visual drift. Preserve intentional changes to clothing, age, injuries, and other appearance details at their actual story times.
- The current openai-oauth implementation does not accept a conversation history or thread identifier in its image-generation request. Its generation adapter normalizes a prompt and supported image options; its image-edit endpoint accepts up to five actual reference images. Therefore, implement the persistent illustration session in the app and supply selected references to POST /v1/images/edits after the initial image, through the same subscription proxy.
- Retain the full illustration archive while selecting reference images within the proxy's per-request limit. Prefer stable references for depicted characters plus relevant recent scene/style references. Track which references were used.
- The continuing text illustrator context decides whether and what to illustrate, informed by permitted story context and previous images. It must not depict future events or disclose private thoughts/OOC instructions merely because the narrator saw them.
- Branch illustration histories at the same boundary as story histories. Abandoned future images remain with their original branch, excluded from the active branch's visual context.
- Expose Copy, Edit, Delete, and Rewind actions through a mobile-friendly message menu for player, narrator, and character messages. Copying has no effect on story state.
- For edits and deletions, restore the state preceding the changed message, apply the revision, and reconstruct dependent events, observations, exposure outcomes, and memories before generating the revised AI continuation. Do not mutate the original branch or reuse its later hidden state.
- Generate from the revised boundary without inventing new player choices or silently treating the original branch's later player actions as if they already happened in the revised branch.

Proxy reference: https://github.com/EvanZhouDev/openai-oauth/blob/main/packages/core/src/images.ts.

## Old project lessons

The old project's distinction between world events and subjective character beliefs is worth retaining. Its global broadcasts to all character histories and inconsistent updates after edits are patterns to replace with a canonical event history and filtered character views.

Reference: https://github.com/LAURlN/RP_game/blob/main/src/rp/gmOrchestrator.js.
