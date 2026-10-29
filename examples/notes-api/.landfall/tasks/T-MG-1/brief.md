# Notes store: create, list, get and delete notes in a JSON file, written atomically (T-MG-1)
<!-- Task brief (ORC-4). Every path is absolute (ORC-15). -->

Executor: landfall:implementer (class: standard — 90 LOC > 30; kind: task).
Review: none
Ignore skills, plugins and MCP tools you may have; never call an AI provider; this brief and the files it names are your only context (PRI-3).
Worktree: ../notes-api-wt/T-MG-1 (branch task/T-MG-1-notes-store from main at 8250b80c74538577dcbd27824e04e1e167292d25; dependencies installed: yes, there are none). Update the branch only with `git merge origin/main`, never rebase.
Budget: 12 minutes; when it nears, stop at a green commit and list the rest under Follow-up in the report.
Rules: ORC-2 ORC-17 ORC-18 COD-1 COD-2 COD-3 COD-12 COD-14; read them with `landfall rule <ID…>` run in the worktree.

## Problem
The service needs a place to keep notes. Nothing exists yet besides package.json and a smoke test.

## Scope
Create: ../notes-api-wt/T-MG-1/src/store.mjs. Tests: ../notes-api-wt/T-MG-1/test/store.test.mjs. Nothing else.

## Contracts
Produces, for T-MG-2 (the HTTP API): `openStore(file)` returns `{ create({title, body}), list(), get(id), remove(id) }`. All functions are synchronous.
- `create` returns the note `{id, title, body, createdAt}`; `id` comes from `crypto.randomUUID()` and `createdAt` is an ISO string.
- `list` returns the notes, oldest first.
- `get` returns a note, or null.
- `remove` returns true or false.
- A missing file reads as no notes.

## Acceptance
1. Notes survive a new `openStore` on the same file.
2. Every write goes to `<file>.tmp-<random>` and is then renamed onto the file. Cite decision D-MG-1 next to that code as `// D-MG-1: atomic write by rename` (COD-12).
3. A corrupt file (not JSON, or not an array) throws an Error whose message names the file. It never silently starts empty.
4. `create` refuses a title that is not a non-empty string of at most 200 characters, and a body that is not a string of at most 10000 characters, with a TypeError.

## TDD
Write test/store.test.mjs first (temp dirs from `fs.mkdtempSync(os.tmpdir() …)`), covering points 1–4. Run it, keep the failing output, then implement.

## Gate (in order)
```bash
npm test
landfall secrets; echo "exit $?"
```
Commits: one RED (test), one GREEN (code); conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Report
Reply with the whole report:
- frontmatter: `red: {"command", "exit", "excerpt"}` and `green: {…}`;
- `# Report: T-MG-1` and a `Status:` line;
- decisions per acceptance point;
- files, RED/GREEN, the gate, and open issues.

Final 5 lines: status, commits, tests, concerns, "report in reply".
