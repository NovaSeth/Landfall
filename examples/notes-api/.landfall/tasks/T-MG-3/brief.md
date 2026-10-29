# Request body size limit and JSON errors that leak no internals (T-MG-3)
<!-- Task brief (ORC-4). Every path is absolute (ORC-15). -->

Executor: landfall:implementer (class: critical — flag security; kind: task).
Review: cross-provider (Codex through `landfall exec --role reviewer`), then a scoped re-review of any fix.
Ignore skills, plugins and MCP tools you may have; never call an AI provider; this brief and the files it names are your only context (PRI-3).
Worktree: ../notes-api-wt/T-MG-3 (branch task/T-MG-3-body-limit-safe-errors from main at 10bd2ba1b314; dependencies: none). Update the branch only with `git merge origin/main`, never rebase.
Budget: 12 minutes; when it nears, stop at a green commit and list the rest under Follow-up in the report.
Rules: ORC-2 ORC-17 ORC-18 COD-1 COD-2 COD-3 COD-12 COD-14; read them with `landfall rule <ID…>` run in the worktree.

## Spec
- **Problem:** src/app.mjs (T-MG-2) caps a body at 64 KiB and answers 400 when it is exceeded. The decided limit is 16 KiB (D-MG-2), and the right status for that is 413. A POST without a JSON content type is accepted. An unexpected error must return no internals: no stack, no path, no thrown message (OWASP A05 and A09).
- **Success criteria:**
  - a 17 KiB body gets 413, and the server buffers no more than 16 KiB of it;
  - a wrong content type gets 415;
  - a forced error whose message holds a file path returns exactly `{"error":"internal error"}`.
- **Approaches:**
  - (a) Count bytes while reading and destroy the request past the limit. **Chosen:** it bounds memory for chunked bodies too.
  - (b) Check only `content-length`. Rejected: a chunked body has none.

## Scope
Modify: ../notes-api-wt/T-MG-3/src/app.mjs. Tests: test/limits.test.mjs (new). Adjust test/api.test.mjs only where it asserts the old 64 KiB or 400 behaviour (an intended change: say so in the report). Nothing else.

## Acceptance
1. A body over 16 KiB returns 413 `{error: "body too large"}`. A `content-length` above the limit is refused before reading. A chunked body is counted while it is read, and reading stops at the limit.
2. A POST whose content type is not `application/json` (parameters such as charset allowed) returns 415 `{error}`.
3. Any unexpected error returns 500 with exactly `{"error":"internal error"}`, and the error is written to stderr once.
4. Cite the decision next to the limit: `// D-MG-2: 16 KiB body limit`.

## TDD
Write test/limits.test.mjs first, with four cases:
- a 17 KiB body with content-length;
- a chunked body past the limit;
- a wrong content type;
- a store whose `list` throws `new Error('/secret/path')`.

Keep the failing output, then implement.

## Gate (in order, each as its own command)
```bash
npm test
landfall secrets
```
Commits: one RED (tests), one GREEN (code); conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Report
Reply with the whole report:
- frontmatter: `red:` and `green:` lines;
- `# Report: T-MG-3` and a `Status:` line;
- decisions per acceptance point;
- files, RED/GREEN, the gate, and open issues.

Final 5 lines: status, commits, tests, concerns, "report in reply".
