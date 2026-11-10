# Independent review ledger

Scope: Hearth local app, base 33b6ce7a100e8c656fafa0758f5e56af7a8cc601 to working tree, including staged additions. Review command: `git diff 33b6ce7a100e8c656fafa0758f5e56af7a8cc601 -- README.md docs/design.md public scripts server.mjs src test`.

Reviewer: Codex provider, gpt-6.1-sol, high reasoning effort (reported by T3). No usage figures returned. No publishing or pushing authorized/performed.

## Round 1

Verdict: CHANGES. Covering checks before review: syntax checks and 52 tests passed. Diff before review: 3,309 insertions, 6 deletions across 18 files.

| ID | Severity | Outcome |
| --- | --- | --- |
| S1 | should | Fixed: authorize a later verbatim player utterance at its actual source and recipients; characters who learned it may relay it. Keep narrator-only fragments protected from unrelated observations. |
| S2 | should | Fixed: the sender remembers their own communication independently of recipient delivery, using the same event ID. |
| S3 | should | Fixed: time advancement resolves applicable hourly reading opportunities and pending changes chronologically, before publication expiry. |
| S4 | should | Fixed: persist revision drafts per story/branch/message, reopen after a failed revision when possible, and clear only after success. |

No findings declined. Added targeted engine regressions and a unit exercise of the actual browser revision controller using a failed transport.

## Round 2

Verdict: APPROVE. S1-S4 all independently verified resolved; no related regressions found. Reviewer independently reran `npm run check` and `npm test`, with 57/57 tests passing. No code changed during either review run.

Behavior diff after fixes, including targeted tests and this ledger before this final report: 3,428 insertions and 6 deletions across 20 files. The increase adds source-aware disclosure, sender retention, chronological exposure opportunities, recoverable edit drafts, and regression coverage. No findings were declined; usage figures were not returned. No PR, push, or deployment was performed.

## Verification limits

- HTTP/API integration and proxy serialization were exercised with scripted local responses, without subscription spending.
- No live ChatGPT/openai-oauth request or Android runtime test was possible from this Windows workspace.
- The UI received syntax, DOM/API wiring inspection, and a targeted unit exercise of its revision controller; it did not receive browser rendering/interaction verification.

## Termux installation workflow

Scope: base c830536ec6c4efd231e12150a2ee9fee14ae9f52 to installer, launcher, README, and related tests. User explicitly authorized publishing the project to GitHub for one-command phone installation.

Reviewer: Codex provider, gpt-6.1-sol on high reasoning effort. Round 1 verdict: CHANGES. Syntax, Bash syntax, and all 62 then-current tests passed before review. Initial workflow diff: 290 insertions, 11 deletions across 7 files.

| ID | Severity | Outcome |
| --- | --- | --- |
| T1 | should | Fixed: bootstrap exposes only a hashed canonical data-directory identity and process ID. Port reuse requires the requested identity; registry reuse additionally verifies its recorded PID. Other libraries count as occupied listeners. |
| T2 | should | Fixed: normal startup establishes the proxy before choosing the app port. A proxy on the preferred app port is skipped in favor of an adjacent free port. |

Added regressions for a different library at the same port, a registry pointing at the wrong PID, and a stopped proxy taking the preferred port during startup. No findings declined. Live OAuth and Android interaction remain untested; subprocess and HTTP tests use local scripted proxies without subscription spending.

Termux round 2 verdict: APPROVE. T1/T2 independently confirmed resolved, no related regressions found. Reviewer independently passed JavaScript and Bash syntax checks and all 63 tests, with no skips. Workflow diff after fixes: 341 insertions and 15 deletions across 10 files before this final documentation update. No findings declined; usage figures were not returned.

## Inline image proxy compatibility

Base: 1f35511a911ee648f91ed0a8175de0eb6ed9cd68. User reported `URL scheme must be http or https, got data:` while illustrating a story. Reproduced the exact error in a local HTTP regression before changing the provider.

Image-containing text requests now use the same loopback subscription proxy's native `/responses` endpoint, preserving inline image bytes, instructions, supplied history, and model selection. Ordinary text chat and multipart image generation/edit calls keep their existing routes. Visual refusals, failed/incomplete results, and missing answers are surfaced without fallback or retry.

Reviewer: Codex provider, gpt-6.1-sol on high reasoning effort. One round, verdict APPROVE, no actionable findings. Reviewer checked the scoped diff but did not rerun tests. Root ran JavaScript checks and all 66 tests successfully; the new regression failed before the fix and passed after it. One pre-existing background-job test timeout was isolated and its test helper given a real deadline and terminal-error diagnostics. Behavior/test diff: 85 insertions, 1 deletion across 3 files, before this documentation update. No findings declined; usage figures were not returned. No live OAuth or phone inference was used during verification.

## Local delivery, context curation and AI debug logs

Base: 2c99e38838f8f10abc000ba6798a370775cff5cd. Reproduced a missing-reply case caused by optional empty local recipient lists. These now mean ordinary local delivery, while nonempty restricted lists and required remote recipients keep their boundaries. Restricted narrator observations also respect player delivery before display.

Added an independent introduction curator using a configurable helper model, with cited background identity and source excerpts for retrospective memories. Genuine arrivals receive no retrospective observations. Interpreter and memory summaries use the same explicit helper selection; blank means the selected chat model. Source/provenance checks are deterministic; interpreting identity and historical perception remains model-dependent.

Per-story local debug records retain prepared prompts, raw text replies and diagnostic errors independently of story transaction rollback, including failed revisions. The UI offers selectable text, copy and .txt download. Image content is represented by metadata and hashes. Logs stay under ignored data/debug, are absent from story exports, and are deleted with the story.

Pre-review checks: JavaScript syntax checks and all 75 tests passed, including local delivery, helper routing, evidenced handoff, rejected citations, restricted sources, raw empty proxy responses, failed-revision logs and deletion/late-write protection. Static DOM identifier/selector check passed. No live subscription inference, Android runtime or browser rendering test was performed.

Reviewer: Codex provider, gpt-6.1-sol on high reasoning effort. Round 1 verdict CHANGES. Initial diff: 435 insertions and 43 deletions across 20 files. Reviewer independently passed syntax checks and all 75 tests on rerun after a transient Windows rename EPERM; no files changed during review.

| ID | Severity | Outcome |
| --- | --- | --- |
| S1 | should | Fixed: story-operation and illustrator catch boundaries append terminal errors with stage/branch/turn metadata independently of rollback, covering parsing/schema/memory/decision failures after a successful provider reply. Added two HTTP regressions that failed before the fix and pass afterward. |

After S1, root passed syntax checks and all 77 tests. No findings declined; usage figures were not returned. Round 2 checks only S1 and the changed error boundaries.

Round 2 verdict APPROVE: S1 resolved and no related regressions found. Reviewer independently passed syntax checks, both new regressions and all 77 tests on rerun; the initial full run encountered the same transient Windows rename EPERM. No files changed during review. Two rounds total with gpt-6.1-sol on high reasoning effort. Diff after S1 before this final ledger entry: 484 insertions and 43 deletions across 20 files. The increase adds terminal error boundaries and two regression tests. No findings declined; usage figures were not returned. User-authorized publication follows approval. Live OAuth, Android runtime and browser rendering remain untested.

## Illustrator description and narration handoff

Base: 2afb296bdac7d1a035c65448f03fced93ffc0e58. A user debug log confirmed the illustrator received an empty appearance field while visual details remained in the authored persona description. Include full authored descriptions for present people and tell the illustrator to use visual facts from both fields, overriding contradictory earlier image notes. The user explicitly permits private background in this backstage role; actor knowledge filtering remains separate.

A context-handoff audit also found missing recent narration: the illustrator previously saw player observation records only. Include recent narrator passages up to the selected anchor, stripping explicit thought/OOC annotations and excluding snapshots and later passages. Two HTTP regressions reproduced the missing description and prose-only detail before the fixes and passed after. This small scoped fix was checked locally without another delegated review. Live model judgment and Android runtime remain untested.

Other confirmed follow-ups: nearby-character contexts still lack visible details stored only in mixed descriptions (requires public visual-profile extraction, not full biography sharing). Introduction curation still uses a recent transcript window and exact excerpts (older prose-only background identity needs retrieval, and synthesized memories need source-linked validation). The audit did not remove those character-knowledge boundaries.

JavaScript syntax checks passed. All 79 tests passed on rerun after the initial full suite hit the previously documented transient Windows rename EPERM in an existing image/export test. No live OAuth or image generation was performed for this change.

## Maintained appearance and library management

Base: a139b17980a9c5fa43aaed8ae8499d81ccba71d4. User approved maintained physical features, current presentation, source-linked helper updates and observer-specific last-seen appearances, including correction and rewind. Also requested archive/rename/delete directly from library history.

Implemented source-linked visual helper patches at resolved boundaries, separate actual/visible descriptions, remembered observer views, and sight access for established blindness/temporary inability to see. Pure player speech and private spans do not directly become physical-update sources. Self actor contexts strip backstage source excerpts; other actor views receive only visible and previously observed details. Historical recipients retain intermediate appearance updates during skips. Illustrator uses selected-anchor visual state and concealment instructions. Semantic extraction and perception judgments remain model-dependent.

Appearance corrections create a new branch and checkpoint; inspector editing supports flexible details and sight correction. Old branches/snapshots remain untouched. Existing saves initialize lazily at their next resolved boundary. Imports validate new visual fields. Library metadata updates are inference-free, version/busy guarded, persist archive/title, and preserve branches. UI exposes per-entry management, active/archive filters, target-safe deletion and correction draft recovery.

Repeated Windows replacement-lock EPERM in the existing image tests motivated bounded atomic rename retries for Windows EPERM/EBUSY only. Prior saves are never deleted as fallback. Added a focused retry regression.

Checks before independent review: all 96 tests passed, covering engine, HTTP, metadata, UI-controller and storage regressions; static DOM selector/ID and JavaScript syntax checks passed. No live inference, Android runtime or browser rendering tested. Review round 1 pending.

Round 1: Codex provider, gpt-6.1-sol on high reasoning effort, verdict CHANGES. Reviewer independently passed syntax checks, all 96 tests and diff whitespace checks. Initial diff: 733 insertions and 43 deletions across 19 files. No files changed during review.

| ID | Severity | Outcome |
| --- | --- | --- |
| S1 | blocker | Fixed: local encounter sources replay pairwise perception for their recorded participants, including arrival/departure sources with no visual patches. A full runTurn skip regression now retains a visitor's red-coat view without learning the later green coat. |
| S2 | blocker | Fixed: pre-opening visual_correction events are allowed by the opening establishment guard. HTTP regression rewinds to an empty branch, corrects appearance and successfully continues into the opening. |
| S3 | should | Fixed: initialization evidence is sorted by fictional time and checkpoint/event boundary with stable ties. Message eventCount and legacy snapshot event counts preserve equal-time ordering. Regression covers older red narration versus newer green events at distinct and equal times. |

All three focused regressions failed before the fixes and pass afterward. Root passed syntax checks and all 99 tests after the fixes. No findings declined; usage figures were not returned. Diff before this ledger addition: 792 insertions and 45 deletions across 19 files. Round 2 checks open findings and changed chronology/opening code only.

Round 2 verdict APPROVE: S1/S2/S3 resolved, with no concrete related regressions. Reviewer independently passed 28 targeted tests, syntax and whitespace checks, and additional speaker/sight-guard/legacy-boundary checks. No code changed during review. Two rounds total with gpt-6.1-sol on high reasoning effort; no findings declined and usage figures were not returned. Diff before this final entry: 802 insertions and 45 deletions across 19 files. The increase adds encounter replay, legacy source ordering, opening compatibility and three regression tests. User-authorized publication follows approval; no live subscription inference, Android runtime or browser rendering verification was performed.

## Editable character system prompts

Base: 5568be0b85e818e594da0f677d2e2262fa367965. User asked how creation works and requested custom character system prompts. Narrator proposes introduction profiles, the helper curates permissible background/memories with the general roleplay prompt, and the engine persists character records in story snapshots.

Added shared Settings.characterPrompt and user-authored per-character systemPrompt in optional cast setup and the inspector. Actor calls compose general, shared, individual and engine protocol layers. Personal prompts are excluded from other actor contexts and backstage world projections; generated introductions start with a blank individual addition. Existing-character edits create non-observable branch checkpoints without completion requests, retaining previous prompts/continuations. Imports, exports, saved setups, clearing prompts and pre-opening edits are covered. UI retains a failed save's draft.

Root checks: syntax and all 105 tests passed, including prompt composition/isolation, curator general-rule inheritance, ignored model-authored prompt fields, branch/rewind/export/import preservation, validation and UI draft recovery. No live inference, Android or browser-render verification performed. Independent review pending.

Independent review: Codex provider, gpt-6.1-sol on high reasoning effort. One round, verdict APPROVE, no actionable findings. Reviewer independently passed syntax, whitespace and static DOM checks and all 105 tests on full rerun after a Windows EPERM rename failure in an existing illustration test; the isolated test also passed. No code changed during review. Diff before this final ledger entry: 210 insertions and 14 deletions across 13 files. No findings fixed or declined; usage figures were not returned. User-authorized publication follows approval. No live subscription inference or Android/browser rendering tested.

## Authored placement and off-scene local actions

Base: 8fa24694d4c99942cc6b328bc3ab7e2c76c0ef69. A supplied private debug log confirmed substantive actor replies were rewritten to empty text after validation rejected all off-scene local text. The player's location record had not followed a completed action at an established landmark, so narration and actor positions diverged. No user log, screenshots or story fixtures are included in the repository.

Added helper-based resolution for authored actions that place the player without a walking command, with exact observable-action evidence, known location/history context, and conservative continuity repair from retained prior player actions. Repairs do not undo later movement, invent arrivals or replay old speech. New actions mark placement resolved, and legacy checkpoints are reviewed once. Local NPC actions/speech now stay with their actual witnesses rather than being rejected solely because the player is elsewhere. Explicit absent recipients remain invalid, and only observations delivered to the player are displayed.

Synthetic regressions cover implicit placement before the next actor, continuation of a stale save, off-scene actions followed by a visible arrival, private/speech exclusion, and later-movement precedence. A private in-memory replay used the supplied log's original nonempty responses with a scripted sourced placement decision: arrival and reply were displayed with two actor requests and zero schema-correction requests. No files or live inference were used for that replay. A preliminary full suite hit the previously documented Windows EPERM image-test failure; verification continues before review.

Root verification before review: all 110 tests passed on full rerun; JavaScript syntax and diff whitespace checks passed. New coverage is entirely synthetic. No live inference, Android runtime or browser rendering tested. Independent review pending.

Round 1: Codex provider, gpt-6.1-sol on high reasoning effort, verdict CHANGES. Reviewer passed syntax, whitespace and 50 engine/placement tests with synthetic reproductions. S1 (should) fixed: structure/privacy/channel/recipient identity validation precedes placement, while local presence and location validation run after sourced placement and again before applying input. Explicit recipients are preserved; a genuinely absent recipient still fails. S2 (nit) fixed with an advancing segment cursor so a later authored action is not confused with identical text in an earlier private span. These are narrow changes within the existing placement path. Three focused cases failed before fixes and pass afterward. Full rerun: all 112 tests passed, syntax and whitespace checks passed. Initial full run again hit the documented Windows EPERM in an existing image test. No findings declined; usage figures were not returned. Round 2 checks S1/S2 and changed validation/source lookup only.

Round 2 verdict APPROVE: S1 and S2 resolved, no concrete related regressions. Reviewer independently passed 52 engine/placement tests, syntax and scoped whitespace checks. No files changed during review. Two rounds total, Codex provider gpt-6.1-sol on high reasoning effort. Diff before this entry: 232 insertions and 16 deletions across eight files (round 1: 197 insertions and 11 deletions); growth is the validation-order fix, sequential source lookup and regression coverage. No findings declined; usage figures unavailable. User-authorized publication follows approval. No live subscription inference, Android runtime or browser rendering tested.
## Helper-driven perception, awareness, scheduling and model controls

Base: 0ea8b26eedbc98a991e6b69ddebc676bbbcc1c2f. User requested semantic helpers instead of location/probability algorithms, reactive interactions, dropdown model selection and per-model-role reasoning effort. A private log established that an audible nearby call had been stored only for its author. No private attachments or story fixtures were added to the repo.

Implemented source-bound local perception with per-observer text and visible-detail selection across descriptive location labels. Helpers resolve historical public awareness without fixed probabilities and select each next actor from fresh delivered state, using narrator suggestions as advisory and yielding for player response opportunities. Code retains source/identity/privacy/access guards, chronological checkpoint boundaries, atomic turns and response caps. Actor contexts receive only permitted observations and approved current sight. Local events/awareness decisions and views persist in rewindable snapshots. Movement feasibility also routes to the helper model.

Settings uses proxy-populated model selects, preserves unavailable saved selections and blank helper inheritance, and keeps four independent effort fields (narrator, actors, helper, illustrator decision). Explicit effort reaches the appropriate text route and debug log; image generation retains separate quality settings. Unsupported models/effort errors do not trigger fallback. Tests use scripted models, including a shared fixture for older orchestration tests; that fixture's simplistic policies are not app behavior.

Root verification before review: syntax and whitespace passed; all 130 tests passed on full rerun. Nine new semantic regressions cover cross-location calls with partial perception, reactive selection/yield, co-located indistinct speech, private-audience/citation failures, approved sight, historical public awareness, intermediate outfits, same-minute future-source exclusion and rewind. Additional provider/UI/routing tests cover catalog metadata, stale/failing refresh preservation and effort wire formats. Existing API branches/import/export/debug logging pass. Earlier full runs hit the documented Windows EPERM in the existing image/export test; its isolated rerun and final full run passed. No live subscription requests, Android runtime or browser rendering tested. Independent review pending; budget three rounds.

Round 1: Codex provider, gpt-6.1-sol on high reasoning effort, verdict CHANGES. Reviewer independently passed syntax and all 130 tests. Initial scoped diff: 576 insertions and 105 deletions across 26 files. No code changed during review. Findings:

- S1 (blocker), fixed: actual clock advancement now awaits each pending event's perception, visual updates and message checkpoint before advancing. Synchronous clock remains only trial validation. Regression checks time 5 vs later event at 10, full snapshot-prefix equality, retained pending work and successful continuation from the earlier snapshot.
- S2 (blocker), fixed: visual replay scans only changes absent from the queued snapshot, with original source-boundary eligibility. Narration can supersede an already-applied event outfit without stale replay overwriting it.
- S3 (should), fixed: approved views pass historical sight independently of the live observer's later impairment. Pending blindfold regression and direct historical-view application both pass.
- S4 (should), fixed: narrator-planned remote observations explicitly addressed to the player display their actual delivered text, matching actor remote delivery.
- S5 (should), fixed: both helper text and speaker label pass the private-fragment guard, using the author's knowledge at that historical source. Authored-source permission cannot authorize unrelated private thought content in a transformed delivery.

All five focused regressions failed before fixes and pass afterward. Added source-authority and direct sight regressions; adjusted the existing pending-visual fixture to answer the new per-boundary requests rather than requiring both future sources together. Root checks: syntax and whitespace passed; all 137 tests passed on full rerun after the known transient Windows EPERM image-test failure. No findings declined; usage unavailable. Round 2 reviews these IDs and changed clock/source/visual/privacy code only.

Publication note: at the user's explicit request, the tested working tree was published as 49fe5d875c1d717e910a12a62ab8180a3dc41cfd while round 2 was still running. The review continued unchanged.

Round 2 verdict CHANGES: S1-S5 resolved with no remaining related findings. Reviewer independently passed syntax, whitespace and all 137 tests on rerun after the documented Windows EPERM image-test failure. S6 (should) identified an unvalidated generated time field overriding canonical log timestamps. Fixed with the minimal change: log always stamps state.time; optional at remains the validated scheduling field. A regression failed with generated time:999 at minute 5 before the fix and passes after, checking clock, message snapshot, observation, visual fact and source timestamps. Root passed syntax/whitespace and all 138 tests on full rerun (initial run hit the same documented image-test EPERM). No findings declined; usage unavailable. Follow-up publication is authorized by the user's request to publish tested changes while review continues. Round 3 is limited to S6 and the one-line log change plus regression.

Round 3 verdict APPROVE: S6 resolved, with no concrete related regressions and no additional code change needed. Reviewer passed syntax, whitespace and all 16 semantic tests. Both independent full runs passed 137/138 with different existing image tests hitting the documented Windows rename EPERM; root's preceding full rerun passed 138/138. Three review rounds total with Codex provider gpt-6.1-sol on high reasoning effort. All S1-S6 fixed, none declined, usage unavailable. Diff before this final entry: 688 insertions and 109 deletions across 26 files, versus initial 576/105; growth is chronological boundary completion, five review regressions, strengthened source privacy and the one-line canonical timestamp fix plus regressions. Publication at the user's request preceded final approval; engine Git object verified against published commit 1916e3eb41ba4c368a703567eb846bdb7c8b9d76. No live inference, Android runtime or browser rendering was tested.
