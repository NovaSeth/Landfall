---
red: {"command": "npm test", "exit": 1, "excerpt": "Cannot find module src/app.mjs imported from test/api.test.mjs"}
green: {"command": "npm test", "exit": 0, "excerpt": "tests 13, pass 13, fail 0"}
---
# Report: T-MG-2

Status: DONE

## Decisions per acceptance point
1. `GET /notes` returns 200 with the list.
2. `POST /notes` returns 201 with the created note. The body is capped at 64 KiB, and an oversize body returns 400; T-MG-3 replaces this with the decided limit.
3. `GET` and `DELETE /notes/<id>` return 200 and 204; an unknown id returns 404.
4. Invalid JSON, a store TypeError or a malformed URL encoding returns 400 `{error}`. An unknown path returns 404, a wrong method 405, and anything else 500 with a generic message.
5. JSON content type on every response except 204.

## Files
- src/app.mjs
- src/server.mjs
- test/api.test.mjs

## RED / GREEN
- RED 598383f.
- GREEN aad8799: 13 of 13 pass.

## Gate
- `npm test`: 13 of 13 pass.
- `landfall secrets`: clean.
