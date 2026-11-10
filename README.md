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

Hearth calls the proxy from its own backend, so no SillyTavern CORS setting or extension is required. Node 22+ is required; the app itself needs no dependency installation or build. The launcher requests Termux's wake lock when available; set `HEARTH_WAKE_LOCK=0` to skip it. Set `HEARTH_NO_BROWSER=1` to avoid opening a browser automatically.

Android may pause or stop Termux in the background. Use Termux's wake lock and your device's battery settings if you want long-running generations. Saved story turns survive restarts; an interrupted turn is not partially committed.

For an existing manual installation, run `bash scripts/termux-start.sh`, or start the proxy separately and run `PORT=8001 npm start`. Installer options: `HEARTH_DIR` sets the checkout location, `HEARTH_BIN_DIR` sets where the launcher is installed, and `HEARTH_NO_START=1` installs without starting. Rerunning the installer only fast-forwards its own repository and never replaces an unrelated checkout or command.

## Run on Windows

With Node 22+ installed, run `npm start` in this directory. To change the port in PowerShell:

```powershell
$env:PORT = '8001'
npm start
```

The proxy must run on the **same device** as Hearth. A proxy on your phone is not reachable through a desktop computer's `127.0.0.1`.

## Begin a story

Open Settings and check the connection. The defaults are `http://127.0.0.1:10531/v1`, text model `gpt-6.1-sol`, and image model `gpt-image-2`. Available models depend on your account and proxy version.

Enter a premise, a player persona, and optionally a few predefined characters. Setups can be saved and reused. The narrator establishes the opening and introduces other characters as the story develops.

The general roleplay prompt and illustrator prompt are separate editable settings. Prompt changes apply to future requests. There are no combat stats, rewards, equipment generators, or player-managed scene modes.

Each library entry has a **···** menu to rename, archive/restore or delete it without opening the conversation. Switch between Library and Archived to find saved stories. Archiving retains the conversation and branches. Renaming/archive status applies to the library entry independently of fictional rewind; deleting removes the story and its debug log after confirmation.

Settings also has an optional **Helper model**, used for input interpretation, new-character context curation and memory summaries. Enter a model ID offered by your subscription proxy (for example, your available Luna model); blank uses the chat model. Narration and character replies continue to use the chat model. This is explicit task routing, with no automatic model fallback.

When a previously described background person becomes a speaking character, an independent context curator reads the narrator's available history and world context. It preserves their established identity and selects evidenced observations for their starting context. Memories must cite exact excerpts from eligible sources, with an earlier narrator passage establishing that background person; a genuine newcomer receives no retrospective memories. The curator must judge identity, historical presence and perception semantically. Source checks constrain invented information but cannot guarantee perfect model judgment. Identifiable people should be registered from their first appearance; silent registered characters already retain observations without actor generation calls. Older observations without delivery provenance are conservatively excluded from retrospective event sources.

## Privacy within the fiction

Write naturally. For unambiguous private content, use:

```text
"I'm fine." I smile. [THOUGHT: I am terrified.]
[OOC: Keep the conversation awkward; do not reveal the thought.]
```

The narrator interprets the original input. Character requests receive only their own background, private state, shared background and permitted observations. Private player fragments are not copied into character conversation history. Ordinary prose still requires model interpretation; explicit markers provide a stronger boundary for sensitive story secrets.

The World & knowledge inspector shows whereabouts, sources, observations, publications, and resolved exposure decisions. Public information does not automatically imply that every character saw it. Narrator judgments still determine whether proposed fictional events are plausible; code enforces identities, recipients, chronological state, movement boundaries, and saved exposure decisions.

For longer stories, older observations are summarized separately for their owner, with recent observations kept verbatim. The narrator has its own continuity notes. Original records remain in saved checkpoints, so rewind restores the corresponding summaries and evidence as well. Summary generation also uses the subscription proxy.

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
npm run check
npm test
```

Tests use scripted local model responses rather than spending subscription quota. Real image availability and quotas are controlled by your account and the proxy. No automatic model/provider or billing fallback occurs after a refusal, quota limit, or failed request.

Design notes are in [docs/design.md](docs/design.md); module contracts are in [docs/implementation-contract.md](docs/implementation-contract.md).

Proxy reference: https://github.com/EvanZhouDev/openai-oauth.
