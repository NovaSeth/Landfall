---
red: {"command": "npm test", "exit": 1, "excerpt": "Error [ERR_MODULE_NOT_FOUND]: Cannot find module src/store.mjs imported from test/store.test.mjs; tests 2, pass 1, fail 1"}
green: {"command": "npm test", "exit": 0, "excerpt": "tests 7, pass 7, fail 0"}
---
# Report: T-MG-1

Status: DONE

## Decisions per acceptance point
1. Every call reads the file, so a second `openStore` on the same file sees the notes.
2. `save` writes `<file>.tmp-<12 hex>` and renames it onto the file, under `// D-MG-1: atomic write by rename`. A failed write or rename removes the temp file. A test spies on renameSync and checks that no temp file is left.
3. Invalid JSON, or a value that is not an array, throws an Error naming the file. A missing file reads as [].
4. `create` throws a TypeError for a title that is not a non-empty string of at most 200 characters, or a body that is not a string of at most 10000 characters. Validation runs before the file is read.

## Files
- src/store.mjs
- test/store.test.mjs

## RED / GREEN
- RED b8c1387: the module was missing.
- GREEN a16bf35: 7 of 7 tests pass.

## Gate
- `npm test`: 7 of 7 pass.
- `landfall secrets`: clean.
