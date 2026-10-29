---
red: {"command": "node --test test/limits.test.mjs", "exit": 1, "excerpt": "413 expected, actual 400 (x2); 415 expected, actual 201; error log callCount expected 1, actual 0"}
green: {"command": "npm test", "exit": 0, "excerpt": "tests 17, pass 17, fail 0"}
---
# Report: T-MG-3

Status: DONE

## Decisions per acceptance point
1. MAX_BODY is 16 KiB, under `// D-MG-2: 16 KiB body limit`.
   - A content-length above the limit is refused before reading.
   - A chunked body is counted per chunk; on overflow, the buffered chunks are dropped and the data listener removed. The reply is 413 `{error:"body too large"}` with `connection: close`.
   - The request is destroyed on the response's finish, so that the 413 is still sent.
2. A POST whose media type, read before `;`, is not application/json gets 415; a charset parameter is accepted.
3. Any error that is not an HttpError, TypeError or URIError returns exactly `{"error":"internal error"}`, logged once with console.error.

## Files
- src/app.mjs
- test/limits.test.mjs (new, four cases)

## RED / GREEN
- RED 15db7e9.
- GREEN 48a2188: 17 of 17 pass.

## Gate
- `npm test`: 17 of 17 pass.
- `landfall secrets`: clean.

## Open issues
- The chunked test asserts the status only, not the 16 KiB buffering bound.
- Store TypeError messages reach the client in 400 replies (existing behaviour).

## Fix round 1

# Report: T-MG-3 fix round 1

Status: DONE

Commits: d188e4a (RED), 650c296 (GREEN).

## F1
- src/store.mjs exports `ValidationError extends TypeError`, and validation throws it.
- app.mjs maps only HttpError and ValidationError to client responses; everything else returns 500 `{"error":"internal error"}`, logged once.
- Invalid JSON throws HttpError(400), and a bad percent-escape in the id returns 400 `invalid note id`.
- Tests: the store throws a TypeError and a URIError with message /secret/path, and each case expects exactly 500 and one log line.

## F2
- `req.pause()` on overflow, before removing the data listeners; the 413 and close sequence is kept.
- A raw-socket test sends nine 4 KiB chunks and asserts the 413, `req.isPaused()`, and at most 16384 + 4096 + 32 bytes emitted.

## Gate
- `npm test`: 23 of 23 pass.
- `landfall secrets`: clean.
