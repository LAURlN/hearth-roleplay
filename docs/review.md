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
