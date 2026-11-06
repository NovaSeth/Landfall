// Fast verify (T-MG-182): `verify <id>` runs the test files of the change, the tests mapped to each changed path by its
// directory name and the profile's fastGuards; a shared or risk path, a critical task or --full runs the full gate set;
// a removed test in a changed file is still caught (compared with the same files at the base). `task merge` stays the
// one full run; the loop's next step for an approved task is its own `task merge`, not a batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

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
const verify = await lib('verify/index.mjs');
const { nextSteps } = await lib('loop/table.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-11-04T10:00:00.000Z';
const RUNNER = 'node --test --test-reporter=tap';
const GATES = [{ name: 'test', cmd: `${RUNNER} tests/*.test.mjs`, timeoutS: 120, kind: 'test' }];
const GUARDS = ['node -e 0'];
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "2 passing"}\n---\n\n# Report\n';
const T = (titles) => `import { test } from 'node:test';\n${titles.map((x) => `test('${x}', () => {});`).join('\n')}\n`;
const FILES = {
  'lib/calc/add.mjs': 'export const add = (a, b) => a + b;\n',
  'lib/other/x.mjs': 'export const x = 1;\n',
  'tests/calc-add.test.mjs': T(['adds', 'adds zero']),
  'tests/calc.test.mjs': T(['calc loads']),
  // fails: a fast run that runs it would fail, so a pass proves it did not run
  'tests/other.test.mjs': "import { test } from 'node:test';\ntest('other fails', () => { throw new Error('ran'); });\n",
};
const facts = { fastGuards: { value: GUARDS, source: 'said', evidence: 'said', confidence: 1, at: AT } };

function repo(t, { cls = 'trivial' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-fast-')));
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
  for (const [rel, text] of Object.entries(FILES)) write(rel, text);
  write('package.json', '{"type":"module"}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: GATES, facts });
  const where = state.resolve({ cwd: dir, env, names });
  const guards = verify.guardGates({ facts });
  state.recordTrust({ dataDir: where.dataDir, names, key: state.repoKey(where.dir, { env }), gates: state.gatesShaOf(guards) });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: cls, classHistory: [{ class: cls, reason: `${cls}: test`, at: AT }], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  write(`${names.stateDir}/tasks/${id}/report.md`, REPORT);
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  const run = (opts = {}) => verify.verifyTask({ cwd: dir, env, names, id, at: AT, ...opts });
  return { dir, env, id, git, write, run };
}

const plan = (paths, extra = {}) => verify.fastPlan({
  profile: { gates: GATES, facts }, change: { paths, loc: 1 }, repoFiles: [...Object.keys(FILES), 'package.json'], trusted: () => true, ...extra,
});

test('fastPlan: one changed lib module runs only its mapped tests and the fastGuards (the commands)', () => {
  const p = plan(['lib/calc/add.mjs']);
  assert.equal(p.kind, 'fast', p.why);
  assert.deepEqual(p.files, ['tests/calc-add.test.mjs', 'tests/calc.test.mjs']);
  assert.deepEqual(p.gates.map((g) => [g.name, g.cmd, g.kind]), [
    ['fast-test-1', `${RUNNER} 'tests/calc-add.test.mjs' 'tests/calc.test.mjs'`, 'test'],
    ['guard-1', 'node -e 0', 'guard'],
  ]);
  assert.equal(plan(['tests/calc-add.test.mjs', 'README.md']).gates[0].cmd, `${RUNNER} 'tests/calc-add.test.mjs'`, 'a changed test file runs itself; a document needs none');
});

test('fastPlan: package.json, tests/helpers, scripts, a risk path, an unmapped path, a critical task, --full and untrusted guards run the full set', () => {
  for (const [paths, extra, why] of [
    [['package.json'], {}, /shared or risk path changed: package\.json/],
    [['tests/helpers/env.mjs'], {}, /shared or risk path/],
    [['scripts/gen.mjs'], {}, /shared or risk path/],
    [['lib/auth/login.mjs'], { riskPaths: ['**/auth/**'] }, /shared or risk path/],
    [['lib/nothing/y.mjs'], {}, /no test file maps to lib\/nothing\/y\.mjs/],
    [['lib/calc/add.mjs'], { critical: true }, /critical/],
    [['lib/calc/add.mjs'], { full: true }, /--full/],
    [['lib/calc/add.mjs'], { trusted: () => false }, /fastGuards are not trusted/],
    [["tests/a'b.test.mjs"], {}, /cannot be passed safely/],
  ]) {
    const p = plan(paths, extra);
    assert.equal(p.kind, 'full', `${paths}: ${p.why}`);
    assert.match(p.why, why);
    assert.deepEqual(p.gates, GATES, 'full: the profile gate set');
  }
});

test('verify on a lib change runs the fast subset, records mode fast, and never the failing unrelated test', (t) => {
  const r = repo(t);
  r.write('lib/calc/add.mjs', 'export const add = (a, b) => b + a;\n');
  r.git('commit', '-q', '-am', 'change');
  const out = r.run();
  assert.equal(out.doc.result, 'pass', JSON.stringify(out.reasons));
  assert.deepEqual(out.doc.gates.map((g) => g.name), ['fast-test-1', 'guard-1']);
  assert.equal(out.doc.mode.kind, 'fast');
  assert.deepEqual(out.doc.mode.files, ['tests/calc-add.test.mjs', 'tests/calc.test.mjs']);
  assert.equal(out.doc.inventory.total, 3);
});

test('verify on a package.json change, or with --full, runs the full gate set (mode full with its reason)', (t) => {
  const r = repo(t);
  r.write('package.json', '{"type":"module","private":true}\n');
  r.git('commit', '-q', '-am', 'pkg');
  const out = r.run();
  assert.deepEqual(out.doc.gates.map((g) => g.name), ['test']);
  assert.deepEqual([out.doc.mode.kind, out.doc.result], ['full', 'fail'], 'the full suite ran the failing unrelated test');
  assert.match(out.doc.mode.why, /package\.json/);
  const r2 = repo(t);
  r2.write('lib/calc/add.mjs', 'export const add = (a, b) => b + a;\n');
  r2.git('commit', '-q', '-am', 'change');
  const full = r2.run({ full: true, ci: true });
  assert.deepEqual([full.doc.mode.kind, full.doc.mode.why, full.doc.gates.map((g) => g.name).join()], ['full', '--full', 'test']);
});

test('a test removed from a changed test file is still caught by a fast verify (baseline-shrunk)', (t) => {
  const r = repo(t);
  r.write('tests/calc-add.test.mjs', T(['adds']));
  r.git('commit', '-q', '-am', 'drop a test');
  const out = r.run();
  assert.equal(out.doc.mode.kind, 'fast');
  assert.equal(out.doc.result, 'baseline-shrunk', JSON.stringify(out.reasons));
  assert.equal(out.doc.inventory.removed.length, 1);
  assert.match(out.doc.inventory.removed[0], /adds zero/);
});

test('a test file the task deletes counts as removed in a fast verify', (t) => {
  const r = repo(t);
  r.git('rm', '-q', 'tests/calc.test.mjs');
  r.git('commit', '-q', '-m', 'drop a file');
  const out = r.run();
  assert.equal(out.doc.mode.kind, 'fast');
  assert.equal(out.doc.result, 'baseline-shrunk', JSON.stringify(out.reasons));
  assert.match(out.doc.inventory.removed.join(), /calc loads/);
});

test('loop: an approved task\'s next step is its own close at once, not held for a batch', () => {
  const task = { id: 'T-TU-1', kind: 'task', title: 't', lane: null, owner: 'TU', class: 'standard', classHistory: [], status: 'verified', round: 0, events: [{ at: AT, by: 'TU', event: 'verify', data: {} }], base: null, branch: null };
  const { steps } = nextSteps({ tasks: [task], caps: { rounds: 2 }, now: Date.parse(AT), bin: names.bin });
  const s = steps.find((x) => x.task === 'T-TU-1');
  assert.match(s.step, new RegExp(`at once, not held for a batch: \`${names.bin} close T-TU-1\``));
  assert.doesNotMatch(s.step, /--ready/);
});

test('a document-only change runs only the guards; a later full run is not refused as another collector', (t) => {
  const r = repo(t);
  r.write('README.md', '# changed\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'docs');
  const out = r.run();
  assert.equal(out.doc.result, 'pass', JSON.stringify(out.reasons));
  assert.deepEqual([out.doc.mode.kind, out.doc.gates.map((g) => g.name).join(), out.doc.inventory.collector], ['fast', 'guard-1', 'none']);
  const full = r.run({ full: true });
  assert.equal(full.doc.mode.kind, 'full');
  assert.ok(!full.reasons.some((x) => x.code === 'collector-changed'), JSON.stringify(full.reasons));
});

// Fix round 1 (review r1 F1): a path changeSince cannot pass on (control or bidi characters) or a change past the path
// cap leaves the selection blind to it, so fast mode would decide on a partial list: such a change runs the full set.
test('fastPlan: a change with a dropped or a truncated path list runs the full set', () => {
  for (const extra of [{ dropped: true }, { truncated: true }]) {
    const p = verify.fastPlan({ profile: { gates: GATES, facts }, change: { paths: ['lib/calc/add.mjs'], loc: 1, ...extra }, repoFiles: Object.keys(FILES), trusted: () => true });
    assert.equal(p.kind, 'full', JSON.stringify(extra));
    assert.match(p.why, /not every changed path/);
  }
});

test('verify: a hidden path with a control character in the diff runs the full suite', (t) => {
  const r = repo(t);
  r.write('lib/calc/add.mjs', 'export const add = (a, b) => b + a;\n');
  r.write('scripts/x\u0001.mjs', 'export {};\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'hidden');
  const out = r.run({ ci: true });
  assert.equal(out.doc.mode.kind, 'full', out.doc.mode.why);
  assert.deepEqual(out.doc.gates.map((g) => g.name), ['test']);
});

test('changeSince: a change over the path cap is truncated, so fast verify fails closed', async (t) => {
  const r = repo(t);
  const run = await lib('verify/history.mjs');
  for (let i = 0; i < 4; i++) r.write(`docs/n/f${i}.md`, 'x\n');
  const where = { worktree: r.dir };
  const head = r.git('rev-parse', 'HEAD');
  const under = run.changeSince(where, r.env, head, [], () => false, () => false, 10);
  assert.equal(under.truncated, false);
  const over = run.changeSince(where, r.env, head, [], () => false, () => false, 3);
  assert.equal(over.truncated, true);
  assert.equal(over.paths.length, 3);
  const p = verify.fastPlan({ profile: { gates: GATES, facts }, change: over, repoFiles: Object.keys(FILES), trusted: () => true });
  assert.equal(p.kind, 'full', p.why);
});
