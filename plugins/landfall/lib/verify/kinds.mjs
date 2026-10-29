// Verify state files (spec §5.1, §8.4, SD-16, SD-47): the test baseline `baseline/tests.json`, the verify record
// `tasks/<id>/verify.json` and the typed review records `tasks/<id>/review-r<k>.json`. All are lib/state kinds: the
// verify unit reads and writes them only through a store opened with these kinds (lib/state open), so every write
// is validated, atomic, locked and refused for a newer schema like any other state file.
// Addition to §5.1: baseline/tests.json may carry `pinnedBy`, the decision of the last `baseline pin` (kept when
// verify grows the baseline; outside the sha256, which covers the inventory only).
// Additions to §8.4 (review r1, findings-r1.md #2, #6, #8): verify.json binds what it verified by `gatesSha` (the
// profile gates it ran) and `baselineSha` (the working baseline after the run), and `inventory.weak` reports a test
// gate collected only by the generic scan. Gate output never enters committed state: a gate entry keeps result, exit
// and duration; the last 4 KB of output (as lines; state strings refuse line breaks) go to `local/verify/<id>.log`.
import { KINDS, LIMITS, PATTERNS, defineKind, open } from '../state/index.mjs';

export const TEST_ID_MAX = 300; // spec §5.1 tests[].id
export const TAIL_CHARS = 4096; // spec §7.6 step 2: the last 4 KB of output
export const RESULTS = Object.freeze(['pass', 'fail', 'baseline-shrunk', 'route-escalated', 'missing-artifact', 'error']);
export const GATE_RESULTS = Object.freeze(['pass', 'fail', 'timeout', 'error']);
export const REVIEW_VERDICTS = Object.freeze(['approved', 'needs-fixes']);

const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
const bool = { t: 'enum', of: [true, false] };
const time = { t: 'time' };
const count = { t: 'int', min: 0, max: Number.MAX_SAFE_INTEGER };
const many = (of, max = 1000000) => ({ t: 'arr', max, of });
const cls = { t: 'enum', of: ['trivial', 'standard', 'critical'], null: true };
const sha = str(64, { re: PATTERNS.sha, null: true });
const testId = str(TEST_ID_MAX, { min: 1 });
const fingerprint = str(TEST_ID_MAX + 13, { min: 1 }); // <id>@<12 hex>
const collector = str(80, { re: /^[a-z][a-z0-9-]*(?:\+[a-z][a-z0-9-]*)*$/ });
const REVIEW_KEY = /^T-[A-Z]{2,4}-[1-9]\d{0,5}\/review-r[1-9]\d{0,2}$/;

export const VERIFY_KINDS = Object.freeze({
  baseline: defineKind('baseline', 1, {
    dir: 'baseline',
    file: () => 'baseline/tests.json',
    match: /^baseline\/tests\.json$/,
    fields: {
      collector,
      head: sha,
      collectedAt: time,
      tests: many({ t: 'obj', f: { id: testId, file: str(LIMITS.path), skipped: bool } }),
      failing: many(fingerprint, 100000),
      sha256: str(64, { re: PATTERNS.sha256 }),
      pinnedBy: str(LIMITS.token, { re: PATTERNS.decisionId }),
    },
    opt: ['pinnedBy'],
  }),
  verify: defineKind('verify', 1, {
    dir: 'tasks',
    keyPattern: PATTERNS.taskId,
    file: (id) => `tasks/${id}/verify.json`,
    match: /^tasks\/(T-[A-Z]{2,4}-[1-9]\d{0,5})\/verify\.json$/,
    key: 'task',
    fields: {
      task: str(LIMITS.token, { re: PATTERNS.taskId }),
      head: sha,
      gatesSha: str(64, { re: PATTERNS.sha256 }),
      baselineSha: str(64, { re: PATTERNS.sha256, null: true }),
      class: cls,
      startedAt: time,
      durationMs: count,
      gates: many({
        t: 'obj',
        f: {
          name: str(40, { min: 1 }), cmd: str(300, { min: 1 }), exit: { t: 'int', min: 0, max: 255, null: true }, durationMs: count,
          result: { t: 'enum', of: GATE_RESULTS },
        },
      }, 100),
      inventory: {
        t: 'obj',
        f: { collector: str(80, { re: /^(?:none|[a-z][a-z0-9-]*(?:\+[a-z][a-z0-9-]*)*)$/ }), total: count, added: many(testId), removed: many(testId), newlySkipped: many(testId), allowedBy: many(str(LIMITS.token, { re: PATTERNS.decisionId }), 10000), weak: bool, tests: many({ t: 'obj', f: { id: testId, file: str(LIMITS.path), skipped: bool } }) },
        opt: ['tests'],
      },
      failures: { t: 'obj', f: { preexisting: many(fingerprint, 100000), new: many(fingerprint, 100000) } },
      route: { t: 'obj', f: { declared: cls, actual: cls, escalated: bool, missingSteps: many(str(40, { re: PATTERNS.kebab }), 20) } },
      artifacts: { t: 'obj', f: { report: bool, review: { t: 'enum', of: ['approved', 'missing', 'not-required'] } } },
      result: { t: 'enum', of: RESULTS },
    },
  }),
  // The output tails of the latest verify of a task: machine-local (local/ is never committed), JSON text.
  verifyLog: defineKind('verifyLog', 1, {
    dir: 'local/verify',
    keyPattern: PATTERNS.taskId,
    file: (id) => `local/verify/${id}.log`,
    match: /^local\/verify\/(T-[A-Z]{2,4}-[1-9]\d{0,5})\.log$/,
    key: 'task',
    fields: {
      task: str(LIMITS.token, { re: PATTERNS.taskId }),
      at: time,
      gates: many({ t: 'obj', f: { name: str(40, { min: 1 }), lines: many(str(TAIL_CHARS), TAIL_CHARS) } }, 100),
    },
  }),
  // The output tails of one run: the n-th write-mode verify of a task (<id>-<n>) or the n-th merge run (<id>-m<n>);
  // machine-local, kept next to the latest log so a failed run never hides the one before it.
  verifyAttempt: defineKind('verifyAttempt', 1, {
    dir: 'local/verify',
    keyPattern: /^T-[A-Z]{2,4}-[1-9]\d{0,5}-m?[1-9]\d{0,3}$/,
    file: (k) => `local/verify/${k}.log`,
    match: /^local\/verify\/(T-[A-Z]{2,4}-[1-9]\d{0,5}-m?[1-9]\d{0,3})\.log$/,
    fields: {
      task: str(LIMITS.token, { re: PATTERNS.taskId }),
      at: time,
      gates: many({ t: 'obj', f: { name: str(40, { min: 1 }), lines: many(str(TAIL_CHARS), TAIL_CHARS) } }, 100),
    },
  }),
  // A passing gate set's runs for one tree (gate-cache.mjs): machine-local, read before the gates run again.
  gateCache: defineKind('gateCache', 1, {
    dir: 'local/gate-cache',
    keyPattern: PATTERNS.sha256,
    file: (k) => `local/gate-cache/${k}.json`,
    match: /^local\/gate-cache\/([0-9a-f]{64})\.json$/,
    fields: {
      tree: str(64, { re: PATTERNS.sha }),
      gatesSha: str(64, { re: PATTERNS.sha256 }),
      collectors: str(200, { min: 1 }),
      version: str(LIMITS.version, { null: true }),
      patterns: str(64, { re: /^(none|[0-9a-f]{64})$/ }),
      at: time,
      mac:str(64, { re: PATTERNS.sha256 }),
      runs: many({
        t: 'obj',
        f: {
          name: str(40, { min: 1 }), cmd: str(300, { min: 1 }), exit: { t: 'int', min: 0, max: 255, null: true }, durationMs: count,
          result: { t: 'enum', of: GATE_RESULTS }, kind: str(40, { min: 1 }), tail: many(str(TAIL_CHARS), TAIL_CHARS),
          report: { t: 'data', maxBytes: 8 * 1024 * 1024 },
        },
        opt: ['report'],
      }, 100),
    },
  }),
  review: defineKind('review', 1, {
    dir: 'tasks',
    keyPattern: REVIEW_KEY,
    file: (key) => `tasks/${key}.json`,
    match: /^tasks\/(T-[A-Z]{2,4}-[1-9]\d{0,5}\/review-r[1-9]\d{0,2})\.json$/,
    fields: {
      verdict: { t: 'enum', of: REVIEW_VERDICTS },
      reviewer: { t: 'obj', f: { kind: { t: 'enum', of: ['claude', 'external'] }, id: str(LIMITS.actor, { re: PATTERNS.actor }) } },
      findings: many({
        t: 'obj',
        f: {
          id: str(40, { min: 1 }), severity: { t: 'enum', of: ['blocking', 'minor'] }, path: str(LIMITS.path, { null: true }),
          line: { t: 'int', min: 1, max: 100000000, null: true }, rule: str(40, { null: true }), text: str(500, { min: 1 }),
        },
      }, 1000),
    },
  }),
});

// The key of round `round` of a task's review record: tasks/<id>/review-r<round>.json.
export const reviewKey = (id, round) => `${id}/review-r${round}`;

// The store of a state directory with the verify kinds added (the profile reads its own kinds through lib/profile).
export const openStore = (dir, names) => open(dir, { names, kinds: { ...KINDS, ...VERIFY_KINDS } });
