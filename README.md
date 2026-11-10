# Hearth

A continuous, illustrated roleplay app for Android/Termux or a desktop browser. Each character receives their own context and observations. The narrator manages the world, while characters retain their own speech and voluntary choices.

Hearth uses your existing **openai-oauth** subscription proxy for both text and images. It never configures an OpenAI Platform API key or falls back to paid API billing.

## Run on Android

In Termux, paste this command to install and start Hearth:

```sh
pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/LAURlN/hearth-roleplay/main/install.sh | bash
```

It installs Git/Node if needed, downloads Hearth into `~/hearth`, adds a `hearth` command, reuses your running subscription proxy (or starts `openai-oauth`), and opens the browser. If a ChatGPT login is needed, complete it in your browser. No separate Platform API key is used.

After installation, start it with:

```sh
hearth
```

Update and start:

```sh
hearth update
```

Stop Hearth with **Ctrl+C** in its Termux session before updating. Your stories stay in `~/hearth/data/` and are preserved by updates. The launcher leaves a shared proxy running when Hearth stops. Its default app port is **8001**, automatically trying nearby free ports if necessary, so SillyTavern can keep using port 8000. The actual address is printed on startup.

To choose a port yourself:

```sh
PORT=8002 hearth
```

Hearth calls the proxy from its own backend, so no SillyTavern CORS setting or extension is required. Node 22+ is required. The launcher installs pinned pure-JavaScript tokenizer dependencies when missing or changed; no native compilation or app build is needed. The launcher requests Termux's wake lock when available; set `HEARTH_WAKE_LOCK=0` to skip it. Set `HEARTH_NO_BROWSER=1` to avoid opening a browser automatically.

Android may pause or stop Termux in the background. Use Termux's wake lock and your device's battery settings if you want long-running generations. Saved story turns survive restarts; an interrupted turn is not partially committed.

For an existing manual installation, run `bash scripts/termux-start.sh`, or start the proxy separately and run `PORT=8001 npm start`. Installer options: `HEARTH_DIR` sets the checkout location, `HEARTH_BIN_DIR` sets where the launcher is installed, and `HEARTH_NO_START=1` installs without starting. Rerunning the installer only fast-forwards its own repository and never replaces an unrelated checkout or command.

## Run on Windows

With Node 22+ installed, run `npm ci --ignore-scripts`, then `npm start` in this directory. To change the port in PowerShell:

```powershell
$env:PORT = '8001'
npm start
```

The proxy must run on the **same device** as Hearth. A proxy on your phone is not reachable through a desktop computer's `127.0.0.1`.

## Begin a story

Open Settings and check the connection. The defaults are `http://127.0.0.1:10531/v1`, text model `gpt-6.1-sol`, and image model `gpt-image-2`. Available models depend on your account and proxy version.

Enter a premise, a player persona, and optionally a few predefined characters. Setups can be saved and reused. The narrator establishes the opening and introduces other characters as the story develops.

Settings has separate general roleplay, shared character and illustrator system prompts. The general rules apply to narration, character replies, input interpretation, appearance maintenance and the new-character curator. Shared character rules apply to actor replies only. Prompt changes in Settings apply to future requests. There are no combat stats, rewards, equipment generators, or player-managed scene modes.

Each AI character can also have an individual system prompt for voice, habits and portrayal. Set it in the optional cast setup, or open **World & knowledge → Presence → Character system prompt** to edit an existing/generated character. Actor requests combine general roleplay rules, shared character rules, that actor's individual instructions, and the engine's response/knowledge protocol. Individual prompts stay out of other actors' contexts and backstage world projections, and do not automatically add observations or knowledge. Leaving an individual prompt blank uses the shared rules alone. The player is never an AI actor.

Saving individual instructions for an existing character creates a new branch and checkpoint without an AI request; earlier prompts and continuations stay in their previous branch. Rewind/switch restores individual prompts with the character state. Shared Settings prompts remain global. Export/import and saved setups preserve individual prompts. Newly generated characters inherit the shared prompt with an empty individual addition; the narrator/helper cannot install model-authored system instructions. Characters are stored in the story's JSON snapshots, without separate per-character files.

Each library entry has a **···** menu to rename, archive/restore or delete it without opening the conversation. Switch between Library and Archived to find saved stories. Archiving retains the conversation and branches. Renaming/archive status applies to the library entry independently of fictional rewind; deleting removes the story and its debug log after confirmation.

Settings loads **model dropdowns** from your subscription proxy when opened. Select the narrator/character model, optional Helper model and image model. A blank Helper model uses the chat model. Saved selections remain visible if the proxy is offline or no longer advertises them; the app never silently changes models. Save a changed proxy URL before refreshing its list.

Set **reasoning effort** independently for narrator, characters, helpers and the illustrator's text decision. Provider default leaves the parameter unset; it is distinct from None. Advertised effort choices are used when available. Otherwise the menu shows common choices and the selected model/proxy determines support. No rejected effort or model selection triggers a fallback. Effort is recorded in the debug log. Text requests use the appropriate [OpenAI reasoning parameter](https://developers.openai.com/api/docs/guides/reasoning); image generation keeps its separate image-quality setting.

The Helper model handles input interpretation, player placement, new-character context curation, visual maintenance, perception, public awareness, movement feasibility, reactive speaker selection and memory summaries. Narration and character replies use the chat model. This is explicit task routing, with no automatic model fallback.

When a previously described background person becomes a speaking character, an independent context curator reads the narrator's available history and world context. It preserves their established identity and selects evidenced observations for their starting context. Memories must cite exact excerpts from eligible sources, with an earlier narrator passage establishing that background person; a genuine newcomer receives no retrospective memories. The curator must judge identity, historical presence and perception semantically. Source checks constrain invented information but cannot guarantee perfect model judgment. Identifiable people should be registered from their first appearance; silent registered characters already retain observations without actor generation calls. Older observations without delivery provenance are conservatively excluded from retrospective event sources.

## Privacy within the fiction

Write naturally. For unambiguous private content, use:

```text
"I'm fine." I smile. [THOUGHT: I am terrified.]
[OOC: Keep the conversation awkward; do not reveal the thought.]
```

The narrator interprets the original input. Character requests receive only their own background, private state, shared background and permitted observations. Private player fragments are not copied into character conversation history. Ordinary prose still requires model interpretation; explicit markers provide a stronger boundary for sensitive story secrets.

An authored action can establish location without an explicit walking command: sitting at an established bench or boarding a vehicle places the player there. The input helper resolves classification and placement together from the action, known locations and history before subsequent speech/actor contexts. This request overlaps initial visual preparation using a frozen starting checkpoint. Suggestions, private thoughts and OOC spans do not serve as movement evidence. Continue retains a dedicated helper for conservative repair of older saves. Repair does not invent an arrival, replay old dialogue or undo a later established movement.

An independent **perception helper** resolves each local event before the next character acts. It considers sound, distance, obstructions, attention and sight rather than comparing location names. A call from nearby bushes can reach someone on the path without revealing the caller's face, gestures or identity. Each listener receives only their own perceived version. Equal locations do not force everyone to hear every word or see hidden details. Nonempty recipients restrict an intended private audience; the helper can withhold delivery when that person cannot perceive it. Explicit remote channels retain recipient and connectivity checks.

Perception preserves meaningful observable actions and gestures instead of summarizing them away. Newly noticed appearance details can also become player-visible narration, with evidence checked against the details actually approved for the player's sight. Hidden or unchanged details cannot be added as a new description. Looking away from one person does not mean global blindness, and permission to look back does not invent that player action. Unseen actions remain unseen; other characters still receive the observations they can perceive.

A **reactive scheduling helper** chooses the next character after those observations have resolved. The narrator's speaker suggestions are advisory; an interruption can change the order, and a character can react to new information later in the same turn. The helper yields when the player should respond rather than making the cast continue talking past a new call or question. Maximum character responders is a request cap, not a target. Helpers do not author character decisions or player actions.

The World & knowledge inspector shows whereabouts, sources, observations, publications, and resolved exposure decisions. A **public-awareness helper** judges actual exposure from access, activity, geography, interests, connections and elapsed time; there are no fixed awareness probabilities. Historical opportunities are resolved during skips before publication expiry. Perception and awareness decisions are saved with source/time, so branches and rewind restore them with knowledge. Code enforces identities, explicit privacy restrictions, source citations, chronological boundaries and atomic saves. Semantic judgments depend on the selected helper model; these helpers add subscription requests and latency, all visible in the debug log.

There is **no message-count context cutoff**. Each character retains their full permitted observations, and the narrator retains its full conversation/event context, until that owner's assembled text request reaches **Context compaction threshold**, default **300,000 tokens**. A helper then summarizes approximately the oldest two thirds of that owner's retained dynamic context by token weight, merges their previous summary, and keeps the recent third verbatim. Whole source boundaries are preserved; a single oversized source may be summarized whole. Stable system rules, character profiles and current state remain in context. Narrator compression never advances a character's personal memory boundary.

The chat footer and World inspector show the current narrator context estimate and configured threshold. Counting uses local `o200k_base` BPE, including assembled system/payload text and estimated message framing. Proxy model aliases, hidden server framing and tokenizers may differ, so the display explicitly says approximate; this is not a provider-reported usage total. Choose a threshold that fits both your chat and helper models. If one prefix summary still leaves the request above the threshold, the turn fails clearly rather than silently dropping context or changing models.

Independent character and narrator summaries run with at most two requests in flight. All summaries validate before their memory changes commit together. Startup requests also cancel and drain together on failure. Character responses, perception and chronological events stay ordered; illustration already runs in the background. Original records and memory boundaries remain in saved checkpoints, so rewind restores the corresponding knowledge and summaries. Every request retains its own debug stage even when calls overlap.

## Editing, branches, and rewind

Every player, narrator and character passage has a menu for copying, editing, deleting, rewinding, or illustrating that moment. Edits and deletions create a new branch at the revised boundary and generate a new AI continuation. The old future remains selectable under Branches. Later player choices from the old branch are not silently replayed.

Rewind restores the saved world and knowledge at the chosen message. Old future memories, publications, character introductions, and illustrations stay in their old branch. Regenerate returns to the last player message and opens another continuation. A stopped or failed generation leaves the last complete saved history intact.

## Illustrations

The illustrator evaluates completed turns separately and generates asynchronously. Continue chatting while it works. Set automatic illustration, cooldown, size, quality and its own instructions in Settings, or request a specific moment manually from its message menu.

The illustrator receives the full authored descriptions of people present, including visual facts entered in the general persona description, as well as recent narration and perceptible observations. Private background can inform its understanding without becoming something characters know. Its instructions distinguish established appearance from hidden motives, thoughts and future events. Explicit thoughts/OOC annotations are stripped from the narration excerpt. Illustrating an earlier passage uses only narration at or before that passage.

Character appearance is maintained as physical features plus current presentation (clothes, concealment and temporary conditions). The helper extracts established visual facts at initialization/introduction and updates them from resolved actions and narration before the next responder. Pure spoken claims, wishes and private thought/OOC segments do not directly update visual state. Each update cites a source; unsupported proposals fail with the turn rather than silently inventing facts. Semantic extraction and visibility still depend on model judgment. Appearance maintenance adds requests through the configured Helper model, or the chat model when blank.

Visible descriptions are separate from actual features: a covered tattoo can exist without being shown, and an observer may perceive “tall” without learning an exact height. Observers retain their last-seen details while absent and perceive changes on re-entry. Established blindness or temporary inability to see blocks new visual observations. The illustrator gets authoritative visual state and instructions to respect concealment and current clothing over old image references.

Open **World & knowledge → Presence → Appearance** to inspect details and their sources or choose **Correct appearance**. You can add/remove physical and presentation details, edit their actual/visible descriptions and correct whether the person can currently see. Saving creates a new branch and checkpoint, preserving the previous state. Rewind restores appearance, observation memories and illustrations together. Existing saves initialize visual state at the next turn or correction without rewriting old checkpoints.

Each branch keeps its visual history. Actual prior images are supplied as references: stable character references and relevant recent images. The current proxy accepts up to five reference images per edit request, so Hearth retains the full gallery and selects references within that limit. The first picture uses `/images/generations`; subsequent reference-based pictures use `/images/edits`. Both use the same subscription proxy. Images from an abandoned branch are not used to depict its revised future.

## Saves and backup

Stories, branch snapshots, settings, and images live in `data/` beside the app. Use Story options → Export complete story for a portable JSON backup including images; Import story creates a new library entry. The entire `data/` directory can also be copied while the server is stopped. Imports are limited to 64 MiB. Deleting a story removes its story record; exported backups are not affected. Unreferenced image files may remain in the local data folder.

Set `HEARTH_DATA_DIR` to use another data directory. Keep one Hearth process per data directory. The server binds only to loopback and does not expose your proxy to a network. Hearth never reads the proxy's OAuth credential file.

## Verification

For troubleshooting, open **Story options → AI debug log**. Refresh, select/copy the text, use Copy all, or Download .txt. The local log includes prepared prompts, exact text replies, selected models, stages, request IDs, branches and errors, including failed/cancelled attempts. Empty or rejected text responses retain the proxy response for diagnosis. Illustrator prompts are included; image bytes are represented by metadata and hashes.

Logs begin with requests after this update; older prompts cannot be recovered. They live under ignored `data/debug/`, are excluded from story exports, and are removed when their story is deleted. Rewind restores fictional knowledge but retains the debugging record of abandoned attempts. Logs contain all private character contexts, thoughts and OOC, so inspect them before sharing. Transport headers and OAuth credentials are never logged.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use scripted local model responses rather than spending subscription quota. Real image availability and quotas are controlled by your account and the proxy. No automatic model/provider or billing fallback occurs after a refusal, quota limit, or failed request.

Design notes are in [docs/design.md](docs/design.md); module contracts are in [docs/implementation-contract.md](docs/implementation-contract.md).

Proxy reference: https://github.com/EvanZhouDev/openai-oauth.
