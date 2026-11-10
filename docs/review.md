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
