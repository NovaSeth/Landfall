# HTTP API over the notes store with input validation (T-MG-2)
<!-- Task brief (ORC-4). Every path is absolute (ORC-15). -->

Executor: landfall:implementer (class: standard; kind: task).
Review: none
Ignore skills, plugins and MCP tools you may have; never call an AI provider; this brief and the files it names are your only context (PRI-3).
Worktree: ../notes-api-wt/T-MG-2 (branch task/T-MG-2-http-api from main at 31da66ed577c; dependencies: none). Update the branch only with `git merge origin/main`, never rebase.
Budget: 12 minutes; when it nears, stop at a green commit and list the rest under Follow-up in the report.
Rules: ORC-2 ORC-17 ORC-18 COD-1 COD-2 COD-3 COD-14; read them with `landfall rule <ID…>` run in the worktree.

## Problem
The notes store (src/store.mjs, from T-MG-1) has no network interface.

## Scope
Create: ../notes-api-wt/T-MG-2/src/app.mjs (the request handler) and src/server.mjs (listens on PORT or 3000; store file data/notes.json). Tests: test/api.test.mjs. Nothing else.

## Contracts
Consumes: `openStore(file)` from src/store.mjs, which returns `{create({title, body}), list(), get(id), remove(id)}`; create throws a TypeError on invalid input.
Produces: `createApp(store)`, which returns a `(req, res)` handler for `http.createServer`.

## Acceptance
1. `GET /notes` returns 200 with a JSON array.
2. `POST /notes` with a JSON body `{title, body}` returns 201 with the created note.
3. `GET /notes/<id>` returns 200 with the note; `DELETE /notes/<id>` returns 204. An unknown id returns 404.
4. Invalid JSON, or a TypeError from the store, returns 400 with `{error: "<short message>"}`. Any other path or method returns 404 or 405 with `{error}`.
5. Every response is `application/json; charset=utf-8`, except 204, which has no body.

## TDD
Write test/api.test.mjs first. Start the handler on port 0 with `http.createServer(createApp(openStore(<temp file>)))` and use `fetch`. Cover points 1–5, keep the failing output, then implement.

## Gate (in order, each as its own command)
```bash
npm test
landfall secrets
```
The secrets scan prints `secrets: clean` on exit 0.
Commits: one RED (tests), one GREEN (code); conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Report
Reply with the whole report:
- frontmatter: `red:` and `green:` lines;
- `# Report: T-MG-2` and a `Status:` line;
- decisions per acceptance point;
- files, RED/GREEN, the gate, and open issues.

Final 5 lines: status, commits, tests, concerns, "report in reply".
