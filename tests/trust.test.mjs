// Machine trust (T-MG-77 slice B; audit D5, D6, C-2/F1-3): a repository's gate commands run (verify, baseline pin,
// task merge) and its threshold overrides count (route) only after this machine set or trusted them. A cloned
// repository ships .landfall/profile.json and config.json; `trust` records them after a y at a terminal only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', 'landfall');
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const decisions = await lib('decisions/index.mjs');
const { routerThresholds } = await lib('router/ratchet.mjs');
const { THRESHOLDS } = await lib('router/classify.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';
const TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\n";
const dataDir = () => state.machineDataDir(names, process.env);
const trustFile = () => join(dataDir(), 'trust.json');

function gitIn(dir, env, ...a) {
  const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A repository with tracked state, one task and one test gate that touches `ran` (outside the repository) when it runs.
function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'trust-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const env = { ...ISO.env };
  const git = (...a) => gitIn(dir, env, ...a);
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'calc.test.mjs'), TESTS);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  const ran = join(base, 'ran');
  const gates = [{ name: 'test', cmd: `touch '${ran}' && node --test`, timeoutS: 120, kind: 'test' }];
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'trivial', classHistory: [{ class: 'trivial', reason: 'trivial: test', at: AT }], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  return { base, dir, env, stateDir, store, handle, id, head, ran, git };
}

// A clone of `r` (its committed state; no local/): what a user gets from someone else's repository.
function clone(t, r) {
  const dir = join(r.base, 'clone');
  gitIn(r.base, r.env, 'clone', '-q', r.dir, dir);
  gitIn(dir, r.env, 'config', 'user.name', 'Test User');
  gitIn(dir, r.env, 'config', 'user.email', 'test@example.com');
  return { ...r, dir, stateDir: join(dir, names.stateDir), git: (...a) => gitIn(dir, r.env, ...a) };
}

async function cli(args, { dir, env, tty = false, answer = null, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd: dir, stdin: answer === null ? null : Readable.from([answer]) };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const text = out.join('');
  return { code, text, env: json ? JSON.parse(text) : null, stderr: err.join('') };
}
const codes = (res) => res.env.errors.map((e) => e.code);
const verifyCi = (r) => cli(['verify', r.id, '--ci', '--yes'], r);
const writeProfile = (r, gates) => writeFileSync(join(r.stateDir, 'profile.json'), `${JSON.stringify({ ...profile.emptyProfile(), gates }, null, 2)}\n`);

// ---- gates (D6) ----

test('a cloned repository: verify refuses its gates with gates-untrusted (exit 7), nothing runs, the commands listed', async (t) => {
  const c = clone(t, repo(t));
  const res = await verifyCi(c);
  assert.equal(res.code, 7, res.stderr);
  assert.deepEqual(codes(res), ['gates-untrusted']);
  assert.match(res.env.errors[0].message, /test: touch .* && node --test/);
  assert.match(res.env.errors[0].hint, /! landfall trust/);
  assert.equal(existsSync(c.ran), false, 'no gate ran');
});

test('a clone after one state write of this machine (local/ ours, no trust entry) still refuses the shipped gates', async (t) => {
  const c = clone(t, repo(t));
  state.open(c.stateDir, { names }).write('config', null, { flags: { engine: 'on' } });
  assert.equal(state.localForeign(c.stateDir).why, 'ours');
  const res = await verifyCi(c);
  assert.deepEqual([res.code, codes(res)], [7, ['gates-untrusted']]);
  assert.equal(existsSync(c.ran), false);
});

test('trust at a terminal with y records the gates; verify then runs them', async (t) => {
  const c = clone(t, repo(t));
  const shown = await cli(['trust'], { ...c, tty: true, answer: 'y\n', json: false });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stderr, /repository: .*\n.*\n  test: touch .* && node --test\nTrust these for this repository on this machine\? \[y\/N\] $/);
  assert.match(shown.text, /trusted for this repository on this machine/);
  const res = await verifyCi(c);
  assert.notEqual(res.code, 7, JSON.stringify(res.env.errors));
  assert.equal(existsSync(c.ran), true, 'the trusted gate ran');
});

test('trust --yes, trust without a terminal and a no answer are refused (exit 7); trust --json writes nothing', async (t) => {
  const c = clone(t, repo(t));
  rmSync(trustFile(), { force: true });
  const listed = await cli(['trust'], { ...c, tty: false, json: false });
  assert.equal(listed.code, 7);
  assert.match(listed.stderr, /hint: run `! landfall trust` in Claude Code, or `landfall trust` in a terminal/);
  const yes = await cli(['trust', '--yes'], { ...c, tty: true, answer: 'y\n', json: false });
  assert.equal(yes.code, 7);
  assert.match(yes.stderr, /--yes does not count/);
  const no = await cli(['trust'], { ...c, tty: true, answer: 'n\n', json: false });
  assert.equal(no.code, 7);
  assert.match(no.stderr, /nothing was trusted/);
  const json = await cli(['trust'], { ...c, tty: true, answer: 'y\n' });
  assert.equal(json.code, 0);
  assert.equal(json.env.data.untrusted.gates.length, 1);
  assert.equal(existsSync(trustFile()), false, 'nothing was recorded');
  assert.deepEqual([(await verifyCi(c)).code, existsSync(c.ran)], [7, false]);
});

test('gates set on this machine (profile gates set) over an empty gate set are trusted without a prompt', async (t) => {
  const c = clone(t, repo(t));
  writeProfile(c, []); // the clone ships no gates: nothing untrusted to build on (fix round 1: AR-1)
  const where = state.resolve({ cwd: c.dir, env: c.env, names });
  const d = decisions.createDecision({ store: state.open(c.stateDir, { names }), where, names, env: c.env, handle: c.handle, today: AT.slice(0, 10), input: { title: 'Gates', why: 'test', cost: 'none', kind: 'gate-change', scope: [], supersedes: [] } });
  const set = await cli(['profile', 'gates', 'set', 'test', `touch '${c.ran}' && node --test`, '--kind', 'test', '--timeout', '60', '--decision', d.id, '--yes'], c);
  assert.equal(set.code, 0, set.stderr);
  const res = await verifyCi(c);
  assert.notEqual(res.code, 7, JSON.stringify(res.env.errors));
  assert.equal(existsSync(c.ran), true);
});

// ---- fix round 1: AR-1 (a write trusts only on a trusted or empty set), AR-2 (adoption needs machine-side evidence) ----

test('AR-1: a clone with an untrusted shipped gate; profile gates set adds a second gate; verify still refuses gates-untrusted', async (t) => {
  const c = clone(t, repo(t));
  const where = state.resolve({ cwd: c.dir, env: c.env, names });
  const d = decisions.createDecision({ store: state.open(c.stateDir, { names }), where, names, env: c.env, handle: c.handle, today: AT.slice(0, 10), input: { title: 'Gates', why: 'test', cost: 'none', kind: 'gate-change', scope: [], supersedes: [] } });
  const second = join(c.base, 'ran-second');
  const set = await cli(['profile', 'gates', 'set', 'second', `touch '${second}'`, '--kind', 'test', '--timeout', '60', '--decision', d.id, '--yes'], c);
  assert.equal(set.code, 0, set.stderr);
  const res = await verifyCi(c);
  assert.deepEqual([res.code, codes(res)], [7, ['gates-untrusted']], JSON.stringify(res.env.errors));
  assert.deepEqual([existsSync(c.ran), existsSync(second)], [false, false], 'no gate ran');
});

test('AR-2: an unmarked, untracked local/ without a projects.json entry is not adopted: verify refuses, nothing runs', async (t) => {
  const r = repo(t);
  rmSync(join(r.stateDir, 'local', '.machine'));
  rmSync(trustFile(), { force: true });
  assert.equal(state.localForeign(r.stateDir).why, 'unmarked');
  const res = await verifyCi(r);
  assert.deepEqual([res.code, codes(res)], [7, ['gates-untrusted']], JSON.stringify(res.env.errors));
  assert.equal(existsSync(r.ran), false);
});

test('adoption: a repository whose state dir is linked in projects.json (machine-side evidence), with no trust entry, runs verify without a prompt', async (t) => {
  const r = repo(t);
  rmSync(join(r.stateDir, 'local', '.machine'));
  rmSync(trustFile(), { force: true });
  state.updateProject({ repo: r.dir, dataDir: dataDir(), names, patch: { stateDir: r.stateDir } }); // as `init --state-dir` links it
  t.after(() => state.updateProject({ repo: r.dir, dataDir: dataDir(), names, patch: { stateDir: null } }));
  assert.equal(state.localForeign(r.stateDir).why, 'unmarked');
  const res = await verifyCi(r);
  assert.notEqual(res.code, 7, JSON.stringify(res.env.errors));
  assert.equal(existsSync(r.ran), true);
  const entry = Object.values(JSON.parse(readFileSync(trustFile(), 'utf8')).repos)[0];
  assert.ok(entry.adoptedAt, 'the adoption is recorded');
  assert.equal(entry.gates.length, 1);
});

test('baseline pin refuses untrusted gates (exit 7) and runs none', async (t) => {
  const c = clone(t, repo(t));
  const where = state.resolve({ cwd: c.dir, env: c.env, names });
  const d = decisions.createDecision({ store: state.open(c.stateDir, { names }), where, names, env: c.env, handle: c.handle, today: AT.slice(0, 10), input: { title: 'Pin', why: 'test', cost: 'none', kind: 'gate-change', scope: [], supersedes: [] } });
  const res = await cli(['baseline', 'pin', '--decision', d.id, '--yes'], c);
  assert.deepEqual([res.code, codes(res)], [7, ['gates-untrusted']]);
  assert.equal(existsSync(c.ran), false);
});

// ---- task merge (D5) ----

test('a branch that changes a gate command and ships a gate-change decision: task merge refuses gates-untrusted', async (t) => {
  const r = repo(t);
  const evil = join(r.base, 'evil');
  r.git('checkout', '-q', '-b', 'feat');
  const where = state.resolve({ cwd: r.dir, env: r.env, names });
  decisions.createDecision({ store: state.open(r.stateDir, { names }), where, names, env: r.env, handle: r.handle, today: AT.slice(0, 10), input: { title: 'New gate', why: 'test', cost: 'none', kind: 'gate-change', scope: [], supersedes: [] } });
  writeProfile(r, [{ name: 'test', cmd: `touch '${evil}' && node --test`, timeoutS: 120, kind: 'test' }]);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'change the gate');
  r.git('checkout', '-q', 'main');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat', '--yes'], r);
  assert.deepEqual([res.code, codes(res)], [7, ['gates-untrusted']], res.stderr);
  assert.equal(existsSync(evil), false, 'the branch gate did not run');
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: r.dir, env: r.env }).status, 1, 'the merge was undone');
});

// ---- threshold overrides (C-2 / F1-3) ----

function overrides(t, { kind = 'general', byHand = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'trust-thr-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'state');
  mkdirSync(join(dir, 'decisions'), { recursive: true });
  const store = state.open(dir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.4.0', activatedAt: AT });
  writeFileSync(join(dir, 'decisions', 'D-AA-1.md'), `---\nschema: 1\nid: D-AA-1\ntitle: Use tabs\nstatus: active\nkind: ${kind}\ndate: 2026-01-01\nauthor: AA\nsupersedes: []\nsupersededBy: null\nscope: []\nallowsTestRemoval: []\n---\n\n## What\n\nUse tabs.\n\n## Why\n\nStyle.\n\n## Cost if wrong\n\nNone.\n`);
  const thresholds = { 'router.trivial.maxLoc': { value: 1000000000, decision: 'D-AA-1', at: AT }, 'router.trivial.maxFiles': { value: 1000000000, decision: 'D-AA-1', at: AT } };
  if (byHand) writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ schema: 1, thresholds }, null, 2)}\n`);
  else store.write('config', null, { thresholds });
  return routerThresholds(state.open(dir, { names }));
}

test('overrides citing an unrelated decision are ignored (repro-C thr.mjs, repro-F1 r1.mjs)', (t) => {
  const th = overrides(t, { kind: 'general' });
  assert.equal(th.trivial.maxLoc, THRESHOLDS.trivial.maxLoc);
  assert.equal(th.trivial.maxFiles, THRESHOLDS.trivial.maxFiles);
});

test('overrides citing a route-override decision but not trusted on this machine are ignored', (t) => {
  const th = overrides(t, { kind: 'route-override', byHand: true });
  assert.equal(th.trivial.maxLoc, THRESHOLDS.trivial.maxLoc);
});

test('overrides citing a route-override decision and written on this machine are applied', (t) => {
  const th = overrides(t, { kind: 'route-override', byHand: false });
  assert.equal(th.trivial.maxLoc, 1000000000);
});

// ---- fix round 2: AR-3 (a link created by init --state-dir comes with a trust entry, so it is never adopted) ----

test('AR-3: init --state-dir on a fresh repository that ships a state dir with gates: verify refuses gates-untrusted, nothing runs', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'trust-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const env = { ...ISO.env };
  const git = (...a) => gitIn(dir, env, ...a);
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'calc.test.mjs'), TESTS);
  const ext = join(dir, 'ci-state');
  mkdirSync(ext);
  const ran = join(base, 'ran');
  writeFileSync(join(ext, 'profile.json'), `${JSON.stringify({ ...profile.emptyProfile(), gates: [{ name: 'test', cmd: `touch '${ran}'`, timeoutS: 60, kind: 'test' }] }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'ships a state dir');
  const head = git('rev-parse', 'HEAD');
  rmSync(trustFile(), { force: true });
  t.after(() => state.updateProject({ repo: dir, dataDir: dataDir(), names, patch: { stateDir: null } }));
  const init = await cli(['init', '--state-dir', ext, '--handle', 'AB', '--yes'], { dir, env });
  assert.equal(init.code, 0, init.text + init.stderr);
  assert.equal(state.readProjects(dataDir(), names).projects[dir]?.stateDir, ext, 'linked');
  const key = state.repoKey(ext);
  const entry = state.readTrust(dataDir(), names).repos[key];
  assert.deepEqual(entry, { gates: [], overrides: [] }, 'an empty trust entry is recorded with the link');
  const store = state.open(ext, { names });
  const id = state.allocateId(store, {
    prefix: 'T', handle: 'AB',
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: 'AB', class: 'trivial', classHistory: [{ class: 'trivial', reason: 'trivial: test', at: AT }], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  const res = await cli(['verify', id, '--ci', '--yes'], { dir, env });
  assert.deepEqual([res.code, codes(res)], [7, ['gates-untrusted']], JSON.stringify(res.env.errors));
  assert.equal(existsSync(ran), false);
  assert.equal(state.readTrust(dataDir(), names).repos[key]?.adoptedAt, undefined, 'not adopted');
});

test('AR-3: an existing link without a trust entry is adopted once; a gate changed by hand afterwards is not adopted again', async (t) => {
  const r = repo(t);
  rmSync(join(r.stateDir, 'local', '.machine'));
  rmSync(trustFile(), { force: true });
  state.updateProject({ repo: r.dir, dataDir: dataDir(), names, patch: { stateDir: r.stateDir } }); // a link from before this release
  t.after(() => state.updateProject({ repo: r.dir, dataDir: dataDir(), names, patch: { stateDir: null } }));
  const first = await verifyCi(r);
  assert.notEqual(first.code, 7, JSON.stringify(first.env.errors));
  assert.equal(existsSync(r.ran), true);
  rmSync(r.ran);
  writeProfile(r, [{ name: 'test', cmd: `touch '${r.ran}' && node --test --test-reporter=dot`, timeoutS: 120, kind: 'test' }]);
  const second = await verifyCi(r);
  assert.deepEqual([second.code, codes(second)], [7, ['gates-untrusted']], JSON.stringify(second.env.errors));
  assert.equal(existsSync(r.ran), false);
});
