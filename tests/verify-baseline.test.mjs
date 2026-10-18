// Verify baseline, end to end (spec §7.6, SD-16, SC8, GC3; Review Focus 3): `verify <task>` re-runs the profile's
// gates in a temp git repository, collects the inventory (a real `node --test` run, or the generic scan of JS,
// Python, Go and Rust test files), and rejects every SC8 mutation fixture (deleted test, .skip, xit, t.skip,
// @pytest.mark.skip, #[ignore]) unless an active decision lists the test in allowsTestRemoval. The baseline is
// hash-pinned and cannot be shrunk by editing it (its sha256 and the baseline at the task's base commit);
// pre-existing failures are fingerprinted and only new ones fail.
// This file holds no plugin name, path or literal decision ID: names come from lib/name.json, IDs are built by D().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (git, node, the gates) gets a throwaway HOME and environment (S1).
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const decisions = await lib('decisions/index.mjs');
const verify = await lib('verify/index.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';
const D = (n, h) => ['D', h, n].join('-');
const NODE_TEST = { name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' };
// Test IDs (review r1 #9): the JSON [file, title, occurrence]; node:test names no file.
const N = (title, n = 1) => JSON.stringify(['', title, n]);
const G = (file, title, n = 1) => JSON.stringify([file, title, n]);

// A throwaway repository with `files` committed, an active store (handle of the git identity), the profile gates,
// a dispatched task (base = the first commit) and its report with RED/GREEN evidence; all committed.
function repo(t, { files, gates = [NODE_TEST], cls = 'trivial' }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(dir);
  mkdirSync(home);
  const env = { ...ISO.env, HOME: home };
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT, flags: {} });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: cls, classHistory: [{ class: cls, reason: `${cls}: test`, at: AT }], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  write(`${names.stateDir}/tasks/${id}/report.md`, '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "4 passing"}\n---\n\n# Report\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  return { base, dir, home, env, stateDir, store, handle, id, head, git, write, vstore: verify.openStore(stateDir, names) };
}

async function cli(args, { dir, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const text = out.join('');
  return { code, text, stderr: err.join(''), env: json ? JSON.parse(text) : null };
}
const run = (r, ...extra) => cli(['verify', r.id, '--yes', ...extra], r);
// Commits the working baseline and makes that commit the task base: the baseline is then anchored in git (review r2
// D5), so later changes to test files are compared with it.
function pinAtBase(r) {
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'pin the baseline');
  const base = r.git('rev-parse', 'HEAD');
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'dispatched', options: { executor: 'claude:implementer', base } });
  return base;
}
const show = (res) => `${res.text}\n${res.stderr}`;
const errorCodes = (res) => res.env.errors.map((e) => e.code);

// A decision record listing test IDs in allowsTestRemoval, through lib/state's ID allocation.
function allow(r, testIds, { status = 'active', kind = 'test-removal' } = {}) {
  return state.allocateId(r.store, {
    prefix: 'D', handle: r.handle,
    build: (did) => decisions.formatRecord({
      schema: 1, id: did, title: 'Remove obsolete tests', status, kind, date: '2026-10-15', author: r.handle,
      supersedes: [], supersededBy: null, scope: [], allowsTestRemoval: testIds,
    }, '## What\n\nRemove them.\n\n## Why\n\nObsolete.\n\n## Cost if wrong\n\nLost coverage.\n\n## Alternatives\n\nKeep them.\n'),
  });
}

// ---- node:test, a real run ----

const nodeTests = ({ deleted = false, dotSkip = false, runtimeSkip = false, extra = '' } = {}) => [
  "import { test, describe, it } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('adds', () => { assert.equal(1 + 1, 2); });",
  `test${dotSkip ? '.skip' : ''}('subtracts', () => { assert.equal(2 - 1, 1); });`,
  `test('divides', (t) => { ${runtimeSkip ? "t.skip('later'); return;" : ''} assert.equal(4 / 2, 2); });`,
  "describe('suite', () => {",
  "  it('inner', () => {});",
  ...(deleted ? [] : ["  it('other', () => {});"]),
  '});',
  extra,
  '',
].join('\n');

test('SC8 end to end with node --test: the first pass pins the baseline; a deleted test, .skip and t.skip are rejected', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  let res = await run(r);
  assert.equal(res.code, 0, show(res));
  const d = res.env.data;
  assert.deepEqual([d.result, d.inventory.collector, d.inventory.total, d.inventory.removed, d.inventory.newlySkipped], ['pass', 'node-test', 5, [], []]);
  assert.deepEqual(d.inventory.added, [N('adds'), N('divides'), N('subtracts'), N('suite > inner'), N('suite > other')]);
  const pinned = r.vstore.read('baseline', null);
  assert.equal(pinned.collector, 'node-test');
  assert.deepEqual(pinned.tests.map((x) => [x.id, x.skipped]), [[N('adds'), false], [N('divides'), false], [N('subtracts'), false], [N('suite > inner'), false], [N('suite > other'), false]]);
  assert.equal(pinned.sha256, verify.baselineSha(pinned));
  pinAtBase(r);

  for (const [mutation, file, field, id] of [
    ['deleted test', nodeTests({ deleted: true }), 'removed', N('suite > other')],
    ['.skip', nodeTests({ dotSkip: true }), 'newlySkipped', N('subtracts')],
    ['t.skip', nodeTests({ runtimeSkip: true }), 'newlySkipped', N('divides')],
  ]) {
    r.write('calc.test.mjs', file);
    res = await run(r);
    assert.equal(res.code, 1, `${mutation}: ${show(res)}`);
    assert.equal(res.env.data.result, 'baseline-shrunk', mutation);
    assert.deepEqual(res.env.data.inventory[field], [id], mutation);
    assert.ok(errorCodes(res).includes('baseline-shrunk'), mutation);
    assert.ok(res.env.errors.find((e) => e.code === 'baseline-shrunk').message.includes(id), mutation);
    assert.deepEqual(r.vstore.read('baseline', null), pinned, `${mutation}: a failed verify never changes the baseline`);
    assert.equal(r.vstore.read('verify', r.id).result, 'baseline-shrunk', `${mutation}: verify.json records the result`);
  }
  r.write('calc.test.mjs', nodeTests());
  res = await run(r);
  assert.equal(res.code, 0, `restored: ${show(res)}`);
});

test('SC8: an active decision allows exactly the tests it lists; a retired one or another test\'s decision does not', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0);
  pinAtBase(r);
  r.write('calc.test.mjs', nodeTests({ deleted: true, dotSkip: true }));
  allow(r, [N('suite > other (renamed)')]);
  allow(r, [N('suite > other'), N('subtracts')], { status: 'retired' });
  let res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.inventory.removed, res.env.data.inventory.newlySkipped, res.env.data.inventory.allowedBy], [[N('suite > other')], [N('subtracts')], []]);
  const only = allow(r, [N('suite > other')]);
  res = await run(r);
  assert.equal(res.code, 1, 'the skip is still not covered');
  assert.deepEqual(res.env.data.inventory.allowedBy, [only]);
  const both = allow(r, [N('subtracts')]);
  res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual(res.env.data.inventory.allowedBy, [only, both].sort());
  // The allowed change is the new baseline: the removed test is gone, the skipped one is recorded as skipped.
  const pinned = r.vstore.read('baseline', null);
  assert.deepEqual(pinned.tests.map((x) => [x.id, x.skipped]), [[N('adds'), false], [N('divides'), false], [N('subtracts'), true], [N('suite > inner'), false]]);
});

test('SC8 end to end through the generic scan: each fixture in JS, Python and Rust test files is rejected', async (t) => {
  const js = ({ skip = false, x = false, tskip = false, deleted = false } = {}) => [
    `test${skip ? '.skip' : ''}('one', () => {});`,
    `${x ? 'xit' : 'it'}('two', () => {});`,
    `test('three', (t) => {${tskip ? " t.skip('later');" : ''} });`,
    ...(deleted ? [] : ["test('four', () => {});"]),
    '',
  ].join('\n');
  const py = ({ skip = false } = {}) => `import pytest\n\n${skip ? '@pytest.mark.skip(reason="later")\n' : ''}def test_sum():\n    assert 1 + 1 == 2\n`;
  const rs = ({ ignore = false } = {}) => `#[cfg(test)]\nmod tests {\n    #[test]\n${ignore ? '    #[ignore]\n' : ''}    fn adds() {}\n}\n`;
  const files = { 'test/calc.test.js': js(), 'tests/test_sum.py': py(), 'src/lib.rs': rs(), 'src/lib.js': "export const x = 'test(\"not a test\")';\n" };
  const r = repo(t, { files, gates: [{ name: 'check', cmd: 'node -e "console.log(\'checked\')"', timeoutS: 60, kind: 'test' }] });
  let res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.inventory.collector, 'generic');
  pinAtBase(r);
  assert.deepEqual(res.env.data.inventory.added, [G('src/lib.rs', 'adds'), G('test/calc.test.js', 'four'), G('test/calc.test.js', 'one'), G('test/calc.test.js', 'three'), G('test/calc.test.js', 'two'), G('tests/test_sum.py', 'test_sum')]);
  for (const [mutation, rel, text, id] of [
    ['deleted test', 'test/calc.test.js', js({ deleted: true }), G('test/calc.test.js', 'four')],
    ['.skip', 'test/calc.test.js', js({ skip: true }), G('test/calc.test.js', 'one')],
    ['xit', 'test/calc.test.js', js({ x: true }), G('test/calc.test.js', 'two')],
    ['t.skip', 'test/calc.test.js', js({ tskip: true }), G('test/calc.test.js', 'three')],
    ['@pytest.mark.skip', 'tests/test_sum.py', py({ skip: true }), G('tests/test_sum.py', 'test_sum')],
    ['#[ignore]', 'src/lib.rs', rs({ ignore: true }), G('src/lib.rs', 'adds')],
    ['deleted file', 'tests/test_sum.py', null, G('tests/test_sum.py', 'test_sum')],
  ]) {
    const original = files[rel];
    if (text === null) rmSync(join(r.dir, rel));
    else r.write(rel, text);
    res = await run(r);
    assert.equal(res.code, 1, `${mutation}: ${show(res)}`);
    assert.equal(res.env.data.result, 'baseline-shrunk', mutation);
    assert.deepEqual([...res.env.data.inventory.removed, ...res.env.data.inventory.newlySkipped], [id], mutation);
    r.write(rel, original);
  }
  assert.equal((await run(r)).code, 0, 'restored');
});

test('growth: an added test is pinned on pass; an un-skipped test is pinned as running; nothing new writes nothing', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests({ dotSkip: true }) } });
  assert.equal((await run(r)).code, 0);
  pinAtBase(r);
  const first = readFileSync(join(r.stateDir, 'baseline', 'tests.json'), 'utf8');
  assert.equal((await run(r)).code, 0);
  assert.equal(readFileSync(join(r.stateDir, 'baseline', 'tests.json'), 'utf8'), first, 'the same inventory rewrites nothing');
  r.write('calc.test.mjs', nodeTests({ extra: "test('multiplies', () => {});" }));
  const res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual(res.env.data.inventory.added, [N('multiplies')]);
  const pinned = r.vstore.read('baseline', null);
  assert.deepEqual(pinned.tests.filter((x) => [N('multiplies'), N('subtracts')].includes(x.id)).map((x) => [x.id, x.skipped]), [[N('multiplies'), false], [N('subtracts'), false]]);
  assert.equal(pinned.sha256, verify.baselineSha(pinned));
  // Skipping it again is a new skip.
  r.write('calc.test.mjs', nodeTests({ dotSkip: true, extra: "test('multiplies', () => {});" }));
  assert.equal((await run(r)).env.data.result, 'baseline-shrunk');
});

// ---- baseline integrity ----

test('a baseline edited by hand (sha256 no longer matches) fails verify; nothing is written', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0);
  const file = join(r.stateDir, 'baseline', 'tests.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.tests = doc.tests.filter((x) => x.id !== N('suite > other'));
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const edited = readFileSync(file, 'utf8');
  r.write('calc.test.mjs', nodeTests({ deleted: true }));
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('baseline-invalid'), show(res));
  assert.notEqual(res.env.data.result, 'pass');
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('a baseline shrunk with a recomputed sha256 is still caught: the baseline at the task base counts too', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'baseline');
  const base = r.git('rev-parse', 'HEAD');
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'dispatched', options: { executor: 'claude:implementer', base } });
  // Forge a consistent baseline without the test, then delete the test.
  const doc = r.vstore.read('baseline', null);
  const forged = { ...doc, tests: doc.tests.filter((x) => x.id !== N('suite > other')) };
  r.vstore.write('baseline', null, { ...forged, sha256: verify.baselineSha(forged) });
  r.write('calc.test.mjs', nodeTests({ deleted: true }));
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.inventory.removed], ['baseline-shrunk', [N('suite > other')]]);
});

test('a changed collector cannot be compared: verify fails instead of guessing', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0);
  profile.openStore(r.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: 'node -e 0', timeoutS: 60, kind: 'test' }] });
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('collector-changed'), show(res));
  assert.equal(r.vstore.read('baseline', null).collector, 'node-test');
});

// ---- failure fingerprints ----

test('pre-existing failures pinned in the baseline are tolerated; a new failure or a changed one fails', async (t) => {
  const failing = (msg = 'equal') => nodeTests({ extra: `test('known bug', () => { assert.${msg}(1, 2); });` });
  const r = repo(t, { files: { 'calc.test.mjs': failing() } });
  let res = await run(r);
  assert.equal(res.code, 1, 'without a baseline every failure is new');
  assert.equal(res.env.data.result, 'fail');
  const [fp] = res.env.data.failures.new;
  assert.ok(fp.startsWith(`${N('known bug')}@`) && /@[0-9a-f]{12}$/.test(fp), fp);
  assert.equal(r.vstore.read('baseline', null), null, 'a failed verify pins nothing');
  // Pin the failure (what `baseline pin` with a decision will do), through the store.
  const tests = ['adds', 'divides', 'known bug', 'subtracts', 'suite > inner', 'suite > other'].map((t) => ({ id: N(t), file: '', skipped: false }));
  const pin = { collector: 'node-test', tests, failing: [fp] };
  r.vstore.write('baseline', null, { ...pin, head: null, collectedAt: AT, sha256: verify.baselineSha(pin) });
  pinAtBase(r);
  res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.env.data.failures.preexisting, res.env.data.failures.new, res.env.data.gates[0].result], [[fp], [], 'fail']);
  r.write('calc.test.mjs', failing('deepEqual'));
  res = await run(r);
  assert.equal(res.code, 1, 'the same test failing differently is a new failure');
  assert.equal(res.env.data.failures.new.length, 1);
  r.write('calc.test.mjs', nodeTests({ extra: "test('known bug', () => { assert.equal(1, 2); });\ntest('fresh', () => { assert.ok(false); });" }));
  res = await run(r);
  assert.equal(res.code, 1);
  assert.deepEqual(res.env.data.failures.preexisting, [fp]);
  assert.ok(res.env.data.failures.new[0].startsWith(`${N('fresh')}@`));
  // Fixed: the fingerprint leaves the baseline, so breaking it again is new.
  r.write('calc.test.mjs', nodeTests({ extra: "test('known bug', () => {});" }));
  assert.equal((await run(r)).code, 0);
  assert.deepEqual(r.vstore.read('baseline', null).failing, []);
});

test('a failing test gate without a parsed failure (a crash) is never excused by the baseline', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0);
  profile.openStore(r.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ ...NODE_TEST, cmd: 'node --test; exit 3' }] });
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.gates[0].result, res.env.data.gates[0].exit], ['fail', 'fail', 3]);
});

// ---- review r1 (findings-r1.md) ----

const TAP_GATE = { name: 'test', cmd: 'NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" node --test', timeoutS: 120, kind: 'test' };
const commitAll = (r, msg = 'work') => { r.git('add', '-A'); r.git('commit', '-q', '-m', msg); return r.git('rev-parse', 'HEAD'); };
const rebase = (r, base) => state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'dispatched', options: { executor: 'claude:implementer', base } });

test('r1 #3: a base whose baseline history exists but whose file is missing or malformed is unanchored, never silent', async (t) => {
  for (const variant of ['malformed', 'deleted']) {
    const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
    assert.equal((await run(r)).code, 0);
    commitAll(r, 'baseline');
    const file = join(r.stateDir, 'baseline', 'tests.json');
    if (variant === 'malformed') writeFileSync(file, '{}\n');
    else rmSync(file);
    rebase(r, commitAll(r, `baseline ${variant}`));
    // A forged working baseline (valid sha256, no tests), then the change deletes a test.
    r.vstore.write('baseline', null, { collector: 'node-test', head: null, collectedAt: AT, tests: [], failing: [], sha256: verify.baselineSha({ collector: 'node-test', tests: [], failing: [] }) });
    r.write('calc.test.mjs', nodeTests({ deleted: true }));
    const res = await run(r);
    assert.equal(res.code, 1, `${variant}: ${show(res)}`);
    assert.ok(errorCodes(res).includes('baseline-unanchored'), `${variant}: ${show(res)}`);
  }
});

test('r1 #5: a pinned failing child does not excuse a new failure of its parent (real node --test)', async (t) => {
  const parent = (own) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => {});\ntest('parent', async (t) => {\n  await t.test('known', () => { assert.equal(1, 2); });\n${own ? "  throw new Error('NEW cleanup failure');\n" : ''}});\n`;
  for (const gate of [NODE_TEST, TAP_GATE]) {
    const r = repo(t, { files: { 'p.test.mjs': parent(false) }, gates: [gate] });
    let res = await run(r);
    assert.equal(res.code, 1, 'every failure is new without a baseline');
    const pin = { collector: 'node-test', tests: res.env.data.inventory.added.map((id) => ({ id, file: '', skipped: false })), failing: res.env.data.failures.new };
    r.vstore.write('baseline', null, { ...pin, head: null, collectedAt: AT, sha256: verify.baselineSha(pin) });
    res = await run(r);
    assert.equal(res.code, 0, `${gate.cmd}: the pinned failures are excused: ${show(res)}`);
    r.write('p.test.mjs', parent(true));
    res = await run(r);
    assert.equal(res.code, 1, `${gate.cmd}: ${show(res)}`);
    assert.ok(res.env.data.failures.new.some((f) => f.startsWith(JSON.stringify(['', 'parent', 1]))), `${gate.cmd}: the parent failure is new`);
  }
});

test('r1 #10: the same test failing with other values is a new failure (equal(1,2) pinned, equal(3,4) now)', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests({ extra: "test('amount', () => { assert.equal(1, 2); });" }) } });
  let res = await run(r);
  const pin = { collector: 'node-test', tests: res.env.data.inventory.added.map((id) => ({ id, file: '', skipped: false })), failing: res.env.data.failures.new };
  r.vstore.write('baseline', null, { ...pin, head: null, collectedAt: AT, sha256: verify.baselineSha(pin) });
  assert.equal((await run(r)).code, 0);
  r.write('calc.test.mjs', nodeTests({ extra: "test('amount', () => { assert.equal(3, 4); });" }));
  res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.equal(res.env.data.failures.new.length, 1);
});

test('r1 #8: gate output never enters committed state; it is kept under local/', async (t) => {
  const token = `SYNTH-not-a-secret-${Math.random().toString(16).slice(2)}`;
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() }, gates: [NODE_TEST, { name: 'leak', cmd: 'node -e "console.log(\'token=\' + process.env.SYNTH_LEAK)"', timeoutS: 60, kind: 'other' }] });
  const res = await cli(['verify', r.id, '--yes'], { ...r, env: { ...r.env, SYNTH_LEAK: token } });
  assert.equal(res.code, 0, show(res));
  commitAll(r, 'after verify');
  const tracked = spawnSync('git', ['grep', '-l', token], { cwd: r.dir, env: r.env, encoding: 'utf8' });
  assert.equal(tracked.stdout, '', 'no tracked file holds the gate output');
  assert.equal(tracked.status, 1);
  assert.match(readFileSync(join(r.stateDir, 'local', 'verify', `${r.id}.log`), 'utf8'), new RegExp(token));
  assert.equal(r.vstore.read('verify', r.id).gates.some((g) => 'outputTail' in g), false);
});

test('r1 #7: a task without a base commit is not verified (the route could not be re-classified)', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  r.store.update('task', r.id, (doc) => ({ ...doc, base: null }));
  r.write('src/auth/login.js', 'export const x = 1;\n');
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('base-missing'), show(res));
});

test('r1 #6, r2 D4: a test gate collected only by the generic scan is weak: reported, and always refused for a critical task', async (t) => {
  const generic = [{ name: 'check', cmd: 'node -e 0', timeoutS: 60, kind: 'test' }];
  const s = repo(t, { files: { 'test/calc.test.js': "test('one', () => {});\n" }, gates: generic, cls: 'standard' });
  s.vstore.write('review', verify.reviewKey(s.id, 1), { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] });
  let res = await run(s);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.inventory.weak, true);
  const c = repo(t, { files: { 'test/calc.test.js': "test('one', () => {});\n" }, gates: generic, cls: 'critical' });
  c.vstore.write('review', verify.reviewKey(c.id, 1), { verdict: 'approved', reviewer: { kind: 'external', id: 'codex' }, findings: [] });
  res = await run(c);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('weak-collector'), show(res));
  allow(c, [], { kind: 'gate-change' });
  res = await run(c);
  assert.ok(errorCodes(res).includes('weak-collector'), `no decision waives it: ${show(res)}`);
});

test('r1 #6: real node --test runs with focused or context-named skips are caught through the generic fallback', async (t) => {
  const js = (body) => `import { test } from 'node:test';\ntest('one', () => {});\n${body}\n`;
  const r = repo(t, { files: { 'test/a.test.mjs': js("test('two', (context) => {});") }, gates: [{ name: 'dots', cmd: 'node --test --test-reporter=dot', timeoutS: 120, kind: 'test' }] });
  assert.equal((await run(r)).code, 0);
  for (const [label, body, code] of [
    ['context.skip', "test('two', (context) => { context.skip('later'); return; });", 'baseline-shrunk'],
    ['inline block comment', "/* test('two', (context) => {}); */", 'baseline-shrunk'],
    ['.only', "test.only('two', (context) => {});", 'focused'],
  ]) {
    r.write('test/a.test.mjs', js(body));
    const res = await run(r);
    assert.equal(res.code, 1, `${label}: ${show(res)}`);
    assert.ok(errorCodes(res).includes(code), `${label}: ${show(res)}`);
  }
});

// ---- review r2 (findings-r2.md D5, Codex rereview-r1.md deviation 5) ----

test('r2 D5: with no baseline committed at the base, a task that touches test files is unanchored (pin, delete, re-pin)', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0, 'the first verify pins a working baseline');
  r.write('calc.test.mjs', nodeTests({ deleted: true }));
  const doc = r.vstore.read('baseline', null);
  const forged = { ...doc, tests: doc.tests.filter((x) => x.id !== N('suite > other')) };
  r.vstore.write('baseline', null, { ...forged, sha256: verify.baselineSha(forged) });
  // the reference is measured at the base (T-MG-37): the forged working baseline does not hide the deletion
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual(errorCodes(res), ['baseline-shrunk'], show(res));
});

test('r2 D5: with no baseline committed at the base, a task that touches no test file lands the first baseline', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests(), 'src/a.js': 'export const a = 1;\n' } });
  r.write('src/a.js', 'export const a = 2;\n');
  const res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.equal(r.vstore.read('baseline', null).tests.length, 5);
});
