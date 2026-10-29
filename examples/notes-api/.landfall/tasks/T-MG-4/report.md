---
red: {"command": "npm test", "exit": 1, "excerpt": "AssertionError: request emitted 36887 bytes (limit 20480); 19 pass, 1 fail"}
green: {"command": "npm test", "exit": 0, "excerpt": "tests 20, pass 20, fail 0 (three runs in a row)"}
---
# Report: T-MG-4

Status: DONE

## Decision
On overflow, `tooLarge` makes `resume()` a no-op on that request and pauses it. Node's `resOnFinish` → `_dump()` → `resume()` can then no longer restart the body; the request is still destroyed on the response's finish. Moving the destroy ahead of Node's finish handler did not stop the buffered bytes from flowing.

## Files
- src/app.mjs
- test/limits.test.mjs: the timing-dependent paused test is replaced by a deterministic one. Nine 4096-byte chunks go in one buffer through an in-memory Duplex, every data emit is counted until close, and the test asserts the 413 and at most 20480 bytes.

## RED / GREEN
- RED 7293847: 36887 bytes emitted.
- GREEN 1527009: 20 of 20 pass, three runs in a row.

## Gate
- `npm test`: 20 of 20 pass, three times.
- `landfall secrets`: clean.
