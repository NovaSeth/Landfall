// Verify schema 2 and review schema 2 (T-MG-117, D-MG-38, plan M1.2, P13, RF2): a verify record may carry the
// machine it ran on (`machine { load1Start, load1End, cores }`), whether the gate cache served it (`cache`), the time
// spent waiting for the heavy-command lease (`heavyWaitMs`) and the time of the gates alone (`gatesMs`); a review
// round may name its focus (`focus`, non-empty, no duplicates). The reader before the bump refuses both as newer
// (GC9, exit 7). This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const { VERIFY_KINDS } = await import(pathToFileURL(join(pluginDir, 'lib', 'verify', 'kinds.mjs')).href);
const { EXIT } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);
const { KINDS, check } = state;
const AT = '2026-11-04T10:00:00.000Z';

const verifyDoc = (extra = {}) => ({
  schema: VERIFY_KINDS.verify.version, task: 'T-MG-1', head: 'a'.repeat(40), gatesSha: 'b'.repeat(64), baselineSha: null, class: null,
  startedAt: AT, durationMs: 1200, gates: [],
  inventory: { collector: 'none', total: 0, added: [], removed: [], newlySkipped: [], allowedBy: [], weak: false },
  failures: { preexisting: [], new: [] }, route: { declared: null, actual: null, escalated: false, missingSteps: [] },
  artifacts: { report: true, review: 'not-required' }, result: 'pass', ...extra,
});
const reviewDoc = (extra = {}) => ({ schema: VERIFY_KINDS.review.version, verdict: 'approved', reviewer: { kind: 'external', id: 'codex' }, findings: [], ...extra });
const machine = (extra = {}) => ({ load1Start: 2.37, load1End: 0.5, cores: 8, ...extra });
const paths = (errors) => errors.map((e) => `${e.path}:${e.code}`);

test('versions: the verify and review schemas are the kinds versions', () => {
  assert.equal(VERIFY_KINDS.verify.version, 4); // T-MG-195: the train field is schema 4
  assert.equal(VERIFY_KINDS.review.version, 2);
});

test('verify v2: machine, cache, heavyWaitMs and gatesMs validate and stay optional', () => {
  assert.deepEqual(check(VERIFY_KINDS.verify, verifyDoc()), [], 'none of the fields is required');
  assert.deepEqual(check(VERIFY_KINDS.verify, verifyDoc({ machine: machine(), cache: 'hit', heavyWaitMs: 590000, gatesMs: 610 })), []);
  for (const cache of ['hit', 'miss', 'off']) assert.deepEqual(check(VERIFY_KINDS.verify, verifyDoc({ cache })), [], cache);
  for (const m of [machine({ load1Start: null, load1End: null }), machine({ load1Start: 0, load1End: 12 }), machine({ cores: 1 })]) {
    assert.deepEqual(check(VERIFY_KINDS.verify, verifyDoc({ machine: m })), [], JSON.stringify(m));
  }
  assert.deepEqual(check(VERIFY_KINDS.verify, verifyDoc({ heavyWaitMs: 0, gatesMs: 0 })), []);
});

test('verify v2: a bad cache, load, core count or duration is rejected at its exact path', () => {
  const at = (extra) => paths(check(VERIFY_KINDS.verify, verifyDoc(extra)));
  assert.deepEqual(at({ cache: 'maybe' }), ['cache:invalid-value']);
  assert.deepEqual(at({ cache: null }), ['cache:invalid-value'], 'cache is absent, never null');
  assert.deepEqual(at({ machine: machine({ load1Start: 'high' }) }), ['machine.load1Start:invalid-value']);
  assert.deepEqual(at({ machine: machine({ load1End: -1 }) }), ['machine.load1End:invalid-value'], 'a load is never negative');
  assert.deepEqual(at({ machine: machine({ cores: 1.5 }) }), ['machine.cores:invalid-value'], 'cores is an integer');
  assert.deepEqual(at({ machine: machine({ cores: 0 }) }), ['machine.cores:invalid-value']);
  assert.deepEqual(at({ machine: machine({ cores: null }) }), ['machine.cores:invalid-value']);
  const { cores: _c, ...noCores } = machine();
  assert.deepEqual(at({ machine: noCores }), ['machine.cores:invalid-value'], 'every machine field is present');
  assert.deepEqual(at({ machine: machine({ host: 'x' }) }), ['machine.host:invalid-value'], 'no stray field');
  assert.deepEqual(at({ heavyWaitMs: -1 }), ['heavyWaitMs:invalid-value']);
  assert.deepEqual(at({ heavyWaitMs: 1.5 }), ['heavyWaitMs:invalid-value']);
  assert.deepEqual(at({ gatesMs: -1 }), ['gatesMs:invalid-value']);
  assert.deepEqual(at({ gatesMs: '10' }), ['gatesMs:invalid-value']);
});

test('review v2: focus is a non-empty list of security, general, data and concurrency, without duplicates', () => {
  assert.deepEqual(check(VERIFY_KINDS.review, reviewDoc()), [], 'focus is optional');
  assert.deepEqual(check(VERIFY_KINDS.review, reviewDoc({ focus: ['security'] })), []);
  assert.deepEqual(check(VERIFY_KINDS.review, reviewDoc({ focus: ['security', 'general', 'data', 'concurrency'] })), []);
  const at = (focus) => paths(check(VERIFY_KINDS.review, reviewDoc({ focus })));
  assert.deepEqual(at(['other']), ['focus.0:invalid-value']);
  assert.deepEqual(at(['security', 'Security']), ['focus.1:invalid-value']);
  assert.deepEqual(at([]), ['focus:invalid-value'], 'never empty');
  assert.deepEqual(at(['security', 'security']), ['focus.1:invalid-value'], 'no duplicates');
  assert.deepEqual(at(['data', 'general', 'data']), ['focus.2:invalid-value'], 'no duplicates');
  assert.deepEqual(at('security'), ['focus:invalid-value'], 'a list');
  assert.deepEqual(at(null), ['focus:invalid-value'], 'absent, never null');
});

test('a verify v2 and a review v2 under the reader before the bump are refused as newer (REFUSED, exit 7)', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-kinds-v2-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kinds = { ...KINDS, ...VERIFY_KINDS };
  const store = state.open(dir, { names, kinds });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  store.write('verify', 'T-MG-1', verifyDoc({ machine: machine(), cache: 'miss', heavyWaitMs: 10, gatesMs: 20 }));
  store.write('review', 'T-MG-1/review-r1', reviewDoc({ focus: ['security'] }));
  // The plugin before the bump (2.6.0): verify schema 1 and review schema 1, and no steps 008 and 009.
  const v = VERIFY_KINDS.verify;
  const r = VERIFY_KINDS.review;
  const { schema: _vs, machine: _m, cache: _c, heavyWaitMs: _h, gatesMs: _g, ...verifyFields } = v.spec.f;
  const { schema: _rs, focus: _f, ...reviewFields } = r.spec.f;
  const oldVerify = state.defineKind('verify', 1, { dir: v.dir, keyPattern: v.keyPattern, file: (id) => `tasks/${id}/verify.json`, match: v.match, key: v.key, fields: verifyFields });
  const oldReview = state.defineKind('review', 1, { dir: r.dir, keyPattern: r.keyPattern, file: (key) => `tasks/${key}.json`, match: r.match, fields: reviewFields, opt: ['run', 'sha256'] });
  const old = state.open(dir, {
    names, kinds: { ...kinds, verify: oldVerify, review: oldReview },
    migrations: state.MIGRATIONS.filter((m) => m.kind !== 'verify' && m.kind !== 'review'),
  });
  const newer = (schema, known) => (e) => e instanceof state.StateError && e.code === 'schema-newer' && e.exit === 'REFUSED'
    && EXIT.REFUSED === 7 && new RegExp(`has schema ${schema}; this plugin knows schema ${known}`).test(e.message);
  assert.throws(() => old.read('verify', 'T-MG-1'), newer(VERIFY_KINDS.verify.version, 1)); // the current verify is written at the kinds version
  assert.throws(() => old.read('review', 'T-MG-1/review-r1'), newer(VERIFY_KINDS.review.version, 1));
  assert.equal(store.read('verify', 'T-MG-1').cache, 'miss', 'the current reader reads it');
  assert.deepEqual(store.read('review', 'T-MG-1/review-r1').focus, ['security']);
});
