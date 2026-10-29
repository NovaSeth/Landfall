# notes-api: an example project built with Landfall

A small JSON notes service with zero dependencies (Node ≥ 18). It was built end to end with the [Landfall](https://github.com/NovaSeth/Landfall) plugin for Claude Code. Its Landfall state is committed next to the code in `.landfall/`, so the whole process can be read back from the files.

## The service
- `npm start` serves on port 3000, or on `PORT` if set, and stores notes in `data/notes.json`.
- `GET /notes`, `POST /notes` (`{title, body}`), `GET /notes/<id>` and `DELETE /notes/<id>`. Request bodies are limited to 16 KiB; errors are JSON and leak no internals.
- `npm test` runs the tests.

## How it was built
One orchestrating Claude Code session ran the `landfall` CLI, and every change was written by an implementer subagent from a brief file. Read it in this order:

| Step | Where to look |
|---|---|
| `landfall init`, `profile observe`, three tasks with `--after` | `.landfall/profile.json`, `.landfall/tasks/T-MG-1..3/task.json` |
| A decision before the code that follows it, cited next to that code | `.landfall/decisions/D-MG-1.md` and `// D-MG-1:` in `src/store.mjs` |
| A brief per task, then a report with RED and GREEN evidence | `.landfall/tasks/T-MG-<n>/brief.md` and `report.md` |
| `verify` re-runs the gates by code; `task done`; `task merge` re-runs them on the merged tree | `.landfall/tasks/T-MG-<n>/verify.json`, `.landfall/baseline/` |
| T-MG-3 touched security, so the router made it critical. Its review came from another provider (Codex through `landfall exec`), recorded from the run with `review record --kind external --run` | `.landfall/tasks/T-MG-3/review-r1.json` (two blocking findings) |
| A fix round and a scoped re-review; at the two-round cap the orchestrator closed the review with a decision, and the open finding went to the backlog | `review-r2.json`, `.landfall/decisions/D-MG-3.md`, `.landfall/findings/` |
| The merge gate caught a timing-dependent test. `findings take` turned the open finding into T-MG-4, whose replaced test needed a decision (`decide --from-verify`) | `.landfall/tasks/T-MG-4/`, `.landfall/decisions/D-MG-4.md` |
| T-MG-3 and T-MG-4 merged as one batch with one gate run | `git log` (batch merge commits) |
| Cost and outcome per task | `.landfall/receipts/` |

## Reproduce it
1. Install Landfall: `claude plugin marketplace add NovaSeth/Landfall`, then `claude plugin install landfall@landfall-plugins`.
2. In an empty git repository, start from the first commit's `package.json` and smoke test. Ask Claude Code for the same three tasks; the `landfall:work` and `landfall:dispatch` skills drive the steps above.
3. A cross-provider review needs the Codex CLI logged in (`landfall providers` shows it). Without it, the critical route asks for a Claude review instead.

The commit history in this directory is not kept: this copy holds the final tree and its state, rebuilt for each major release.
