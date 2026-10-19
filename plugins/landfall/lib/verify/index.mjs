// Verify unit (spec §4.2, §7.6, §8.4, SD-15, SD-16, SD-47, GC3): gates re-run from the profile, the test inventory
// (reporter collectors and the generic scan), the hash-pinned baseline with failure fingerprints, verify.json, and
// the `task done` and `task merge` rules, typed review records and the baseline repair. The public interface; other
// units import only this file. The unit writes verify.json, baseline/tests.json, review-r<k>.json,
// local/verify/<id>.log and the task's class, events and done state, all through lib/state.
export { REVIEW_VERDICTS, RESULTS, TAIL_CHARS, TEST_ID_MAX, VERIFY_KINDS, openStore, reviewKey } from './kinds.mjs';
export { REPORTERS, parseReport } from './reporters.mjs';
export { blankComments, scanRepo, scanSource } from './scan.mjs';
export { normalizeMessage, testId } from './inventory.mjs';
export { baselineSha, compareInventory, excusable, fingerprint, referenceOf, splitFailures } from './baseline.mjs';
export { reportHasEvidence, reviewState } from './artifacts.mjs';
export { runGate, tailLines } from './gates.mjs';
export { evaluate, gatesSha, verifyTask } from './run.mjs';
export { markDone } from './done.mjs';
export { mergeTask } from './merge.mjs';
export { reviewErrors, reviewSchema, recordReview, schemaErrors } from './review.mjs';
export { PIN_KINDS, pinBaseline, showBaseline } from './pin.mjs';
