// Verify, `task done` and `task merge` (spec §7.6, §8.2, §8.4, SD-15, SD-47, GC3; lesson 05:16): verify re-runs the
// profile's gates itself and writes verify.json; the route is re-classified from git (the class only rises);
// the report needs RED/GREEN evidence and the route's review an approved typed record; the model's prose never
// changes a result. `task done` is the only way to status done and needs a passing verify.json for the code at
// HEAD. `task merge` merges with --no-ff --no-commit, runs the outcome gates and commits only when they pass.
// This file holds no plugin name, path or literal decision ID: names come from lib/name.json, IDs are built by D().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const decisions = await lib('decisions/index.mjs');
const verify = await lib('verify/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');
const { Store } = await lib('state/store.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';
const TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\ntest('subtracts', () => {});\n";
const GATES = [{ name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }, { name: 'lint', cmd: 'node -e 0', timeoutS: 60, kind: 'lint' }];
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "2 passing"}\n---\n\n# Report\n';

function repo(t, { files = { 'calc.test.mjs': TESTS }, gates = GATES, cls = 'trivial', report = REPORT, tier = 'L2' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-task-')));
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
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT, flags: tier === 'L0' ? {} : { engine: 'on' } });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  // The applied tier (spec §7.4): L2 by default, where a standard task needs a review and a critical one an external one.
  if (tier !== 'L0') decisions.createDecision({ store, where: state.resolve({ cwd: dir, env, names }), names, env, handle, today: AT.slice(0, 10), input: { title: `Tier ${tier} from L0`, why: 'test fixture', cost: 'none', kind: 'tier', scope: [], supersedes: [] } });
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: cls, classHistory: cls ? [{ class: cls, reason: `${cls}: test`, at: AT }] : [], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  if (report !== null) write(`${names.stateDir}/tasks/${id}/report.md`, report);
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  return { base, dir, home, env, stateDir, store, handle, id, head, git, write, vstore: verify.openStore(stateDir, names) };
}

async function cli(args, { dir, env, json = true, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd: dir, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const text = out.join('');
  return { code, text, stderr: err.join(''), env: json ? JSON.parse(text) : null };
}
const run = (r, ...extra) => cli(['verify', r.id, '--yes', ...extra], r);
const done = (r) => cli(['task', 'done', r.id, '--yes'], r);
const show = (res) => `${res.text}\n${res.stderr}`;
const errorCodes = (res) => res.env.errors.map((e) => e.code);
const setGates = (r, gates) => profile.openStore(r.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
const review = (r, round, verdict, kind = 'claude') => r.vstore.write('review', verify.reviewKey(r.id, round), { verdict, reviewer: { kind, id: kind === 'claude' ? 'claude:reviewer' : 'codex' }, findings: [] });
const commitAll = (r, msg = 'work') => { r.git('add', '-A'); r.git('commit', '-q', '-m', msg); return r.git('rev-parse', 'HEAD'); };
function snapshot(dir) {
  const files = {};
  const walk = (d, rel) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (rel === '' && f.name === '.git') continue;
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p, `${rel}${f.name}/`);
      else files[`${rel}${f.name}`] = readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return files;
}

// ---- verify.json and the gates ----

test('verify re-runs every profile gate and writes verify.json in the §8.4 shape', async (t) => {
  const r = repo(t);
  const res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.env.command, res.env.ok, res.env.exit], ['verify', true, 'OK']);
  const doc = r.vstore.read('verify', r.id);
  assert.deepEqual(Object.keys(doc), ['schema', 'task', 'head', 'gatesSha', 'baselineSha', 'class', 'startedAt', 'durationMs', 'gates', 'inventory', 'failures', 'route', 'artifacts', 'result']);
  assert.equal(doc.gatesSha, verify.gatesSha(GATES));
  assert.equal(doc.baselineSha, verify.baselineSha(r.vstore.read('baseline', null)));
  assert.deepEqual([doc.schema, doc.task, doc.head, doc.class, doc.result], [1, r.id, r.git('rev-parse', 'HEAD'), 'trivial', 'pass']);
  assert.deepEqual(doc.gates.map((g) => [g.name, g.cmd, g.exit, g.result]), [['test', 'node --test', 0, 'pass'], ['lint', 'node -e 0', 0, 'pass']]);
  assert.deepEqual(Object.keys(doc.gates[0]), ['name', 'cmd', 'exit', 'durationMs', 'result'], 'no gate output in committed state');
  assert.ok(res.env.data.output[0].lines.some((l) => l.includes('adds')), 'the tail of the gate output, in the reply');
  assert.ok(r.vstore.read('verifyLog', r.id).gates[0].lines.some((l) => l.includes('adds')), 'and under local/');
  assert.deepEqual(doc.inventory, { collector: 'node-test', total: 2, added: [JSON.stringify(['', 'adds', 1]), JSON.stringify(['', 'subtracts', 1])], removed: [], newlySkipped: [], allowedBy: [], weak: false, tests: ['adds', 'subtracts'].map((n) => ({ id: JSON.stringify(['', n, 1]), file: '', skipped: false })) });
  assert.deepEqual(doc.failures, { preexisting: [], new: [] });
  assert.deepEqual(doc.route, { declared: 'trivial', actual: 'trivial', escalated: false, missingSteps: [] });
  assert.deepEqual(doc.artifacts, { report: true, review: 'not-required' });
  assert.deepEqual(res.env.data.task, r.id);
  assert.equal(res.env.data.written, true);
});

test('prose never passes a task: a failing gate fails verify whatever the report claims, and task done refuses', async (t) => {
  const r = repo(t, { gates: [...GATES, { name: 'typecheck', cmd: 'node -e "process.exit(2)"', timeoutS: 60, kind: 'typecheck' }] });
  r.write(`${names.stateDir}/tasks/${r.id}/report.md`, `${REPORT}\nAll gates pass. Status: DONE\n`);
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.equal(res.env.data.result, 'fail');
  assert.deepEqual(res.env.data.gates.map((g) => g.result), ['pass', 'pass', 'fail']);
  assert.ok(errorCodes(res).includes('gate-failed'));
  const d = await done(r);
  assert.equal(d.code, 1, show(d));
  assert.ok(errorCodes(d).includes('verify-failed'));
  assert.equal(r.store.read('task', r.id).status, 'dispatched');
});

test('a gate over its time limit is a timeout; a command that cannot run is an environment error (exit 8)', async (t) => {
  const r = repo(t, { gates: [GATES[0], { name: 'slow', cmd: 'node -e "setTimeout(() => {}, 20000)"', timeoutS: 1, kind: 'other' }] });
  let res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual(res.env.data.gates.map((g) => [g.name, g.result, g.exit]), [['test', 'pass', 0], ['slow', 'timeout', null]]);
  setGates(r, [GATES[0], { name: 'missing', cmd: 'no-such-tool-zz9 --check', timeoutS: 30, kind: 'lint' }]);
  res = await run(r);
  assert.equal(res.code, 8, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.gates[1].result, res.env.exit], ['error', 'error', 'ENV']);
});

test('no gates: exit 1 no-gates with the detected candidates; no test gate needs a gate-change decision', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': TESTS, 'package.json': '{"scripts":{"test":"node --test"}}\n' }, gates: [] });
  let res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('no-gates'));
  assert.deepEqual(res.env.data.candidates.map((g) => g.cmd), ['NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" npm run test']);
  assert.equal(r.vstore.read('verify', r.id).result, 'fail', 'a stale pass cannot survive');
  setGates(r, [GATES[1]]);
  res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('no-test-gate'));
  const did = state.allocateId(r.store, {
    prefix: 'D', handle: r.handle,
    build: (x) => decisions.formatRecord({ schema: 1, id: x, title: 'Docs only: no test gate', status: 'active', kind: 'gate-change', date: '2026-10-15', author: r.handle, supersedes: [], supersededBy: null, scope: [] }, '## What\n\nNo tests.\n\n## Why\n\nDocs.\n\n## Cost if wrong\n\nNone.\n\n## Alternatives\n\nNone.\n'),
  });
  res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual(res.env.data.inventory.allowedBy, [did]);
});

// ---- artifacts: report and review ----

test('report: missing, or without RED or GREEN evidence, is a missing artifact', async (t) => {
  const r = repo(t, { report: null });
  let res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.artifacts.report], ['missing-artifact', false]);
  assert.ok(errorCodes(res).includes('missing-artifact'));
  for (const bad of [
    '# Report\nRED: failed. GREEN: passes.\n',
    '---\nred: {"command": "node --test", "exit": 1, "excerpt": "x"}\n---\n',
    '---\nred: {"command": "node --test", "exit": 1, "excerpt": "x"}\ngreen: {"command": "node --test", "exit": 1, "excerpt": "x"}\n---\n',
    '---\nred: {"command": "", "exit": 1, "excerpt": "x"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "x"}\n---\n',
    '---\nred: failed\ngreen: passes\n---\n',
    `---\nred: {"command": "node --test", "exit": 1, "excerpt": "${'x'.repeat(2049)}"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "x"}\n---\n`,
  ]) {
    r.write(`${names.stateDir}/tasks/${r.id}/report.md`, bad);
    res = await run(r);
    assert.equal(res.env.data.artifacts.report, false, bad);
    assert.equal(res.env.data.result, 'missing-artifact', bad);
  }
  r.write(`${names.stateDir}/tasks/${r.id}/report.md`, REPORT);
  assert.equal((await run(r)).code, 0);
});

test('review: a standard task needs an approved typed review; a critical one an approved external review', async (t) => {
  const r = repo(t, { cls: 'standard' });
  let res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.artifacts.review], ['missing-artifact', 'missing']);
  review(r, 1, 'needs-fixes');
  assert.equal((await run(r)).env.data.artifacts.review, 'missing');
  review(r, 2, 'approved');
  res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.artifacts.review, 'approved');
  review(r, 10, 'needs-fixes');
  assert.equal((await run(r)).env.data.artifacts.review, 'missing', 'the latest round (10 after 2) counts');

  const c = repo(t, { cls: 'critical' });
  review(c, 1, 'approved', 'claude');
  res = await run(c);
  assert.deepEqual([res.code, res.env.data.artifacts.review], [1, 'missing']);
  review(c, 2, 'approved', 'external');
  res = await run(c);
  assert.deepEqual([res.code, res.env.data.artifacts.review], [0, 'approved'], show(res));
});

// ---- route re-classification from git ----

test('the route is re-classified from the diff against the task base: a larger change escalates and is recorded', async (t) => {
  const r = repo(t);
  for (let i = 0; i < 16; i++) r.write(`src/f${i}.js`, `export const v${i} = ${i};\n`);
  let res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.equal(res.env.data.result, 'route-escalated');
  assert.deepEqual(res.env.data.route, { declared: 'trivial', actual: 'critical', escalated: true, missingSteps: ['spec-plan', 'cross-provider-review', 'rereview'] });
  assert.equal(r.store.read('task', r.id).class, 'critical', 'the ratchet is written to task.json');
  res = await run(r);
  assert.deepEqual([res.env.data.result, res.env.data.route.escalated, res.env.data.artifacts.review], ['missing-artifact', false, 'missing']);
  // The state directory is not part of the change; risk paths count.
  const s = repo(t);
  s.write('src/auth/login.js', 'export const x = 1;\n');
  res = await run(s);
  assert.deepEqual([res.env.data.result, res.env.data.route.actual], ['route-escalated', 'critical']);
});

// ---- --ci, owner, inactive, unknown ----

test('--ci writes nothing and needs no registered owner; the result and exit code are the same', async (t) => {
  const r = repo(t);
  for (let i = 0; i < 3; i++) r.write(`src/f${i}.js`, `export const v${i} = ${i};\n`);
  const before = snapshot(r.stateDir);
  const other = { ...r, env: { ...r.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'ci@example.com' } };
  const res = await cli(['verify', r.id, '--ci', '--yes'], other);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.route.actual, res.env.data.written], ['route-escalated', 'standard', false]);
  assert.deepEqual(snapshot(r.stateDir), before, 'nothing written');
});

test('only the owner verifies with writes; an inactive repository, an unknown task and consent are refused', async (t) => {
  const r = repo(t);
  const other = { ...r, env: { ...r.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'other@example.com' } };
  state.registerHandle(r.store, { name: 'Other Person', email: 'other@example.com', at: AT });
  const before = snapshot(r.stateDir);
  let res = await cli(['verify', r.id, '--yes'], other);
  assert.equal(res.code, 7, show(res));
  assert.ok(errorCodes(res).includes('not-owner'));
  assert.deepEqual(snapshot(r.stateDir), before);
  res = await cli(['verify', 'T-ZZ-9', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'task-unknown']);
  res = await cli(['verify', 'nope', '--yes'], r);
  assert.equal(res.code, 2);
  res = await cli(['verify', r.id], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [7, 'consent-required']);
  rmSync(r.stateDir, { recursive: true, force: true });
  res = await run(r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [7, 'inactive']);
});

// ---- task done ----

test('task done: the only way to done, after a passing verify for the code at HEAD', async (t) => {
  const r = repo(t);
  let d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'verify-missing'], show(d));
  assert.equal((await run(r)).code, 0);
  d = await done(r);
  assert.equal(d.code, 0, show(d));
  const task = r.store.read('task', r.id);
  assert.equal(task.status, 'done');
  assert.deepEqual([task.events.at(-1).event, task.events.at(-1).by, task.events.at(-1).data], ['done', r.handle, { head: r.git('rev-parse', 'HEAD') }]);
  d = await done(r);
  assert.equal(d.code, 0, 'done again changes nothing');
  assert.equal(r.store.read('task', r.id).events.length, task.events.length);
  const set = await cli(['task', 'set', r.id, 'done', '--yes'], r);
  assert.notEqual(set.code, 0, 'task set never marks done');
});

test('task done refuses a verify that does not match the code: changed, uncommitted, dirty at verify, class raised', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0);
  // The baseline committed at the base anchors the later test changes (review r2 D5).
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'dispatched', options: { executor: 'claude:implementer', base: commitAll(r, 'pin the baseline') } });
  r.write('calc.test.mjs', `${TESTS}test('later', () => {});\n`);
  let d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'uncommitted-changes'], show(d));
  commitAll(r);
  d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'verify-stale'], show(d));
  // Verified with uncommitted changes: no head to close against.
  r.write('calc.test.mjs', `${TESTS}test('later', () => {});\ntest('more', () => {});\n`);
  assert.equal((await run(r)).code, 0);
  assert.equal(r.vstore.read('verify', r.id).head, null);
  commitAll(r);
  d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'verify-dirty'], show(d));
  // Verified clean, then the class is raised: the passing verify was for a lower route.
  assert.equal((await run(r)).code, 0);
  await cli(['route', r.id, '--override', 'standard', '--by', 'user', '--quote', 'Raise it, this touches billing.', '--yes'], r);
  d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'verify-stale'], show(d));
  assert.notEqual(r.store.read('task', r.id).status, 'done');
});

test('task done needs the approved review the route asks for at close time, not only at verify time', async (t) => {
  const r = repo(t, { cls: 'standard' });
  review(r, 1, 'approved');
  commitAll(r, 'review r1');
  assert.equal((await run(r)).code, 0);
  review(r, 2, 'needs-fixes');
  let d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'review-missing'], show(d));
  assert.equal(r.store.read('task', r.id).status, 'dispatched');
  // Review records are committed state: the approved round is committed and verified before closing.
  review(r, 3, 'approved');
  commitAll(r, 'review r2 and r3');
  assert.equal((await run(r)).code, 0);
  d = await done(r);
  assert.equal(d.code, 0, show(d));
});

test('task done: owner only; a cancelled task stays cancelled', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0);
  state.registerHandle(r.store, { name: 'Other Person', email: 'other@example.com', at: AT });
  const other = { ...r, env: { ...r.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'other@example.com' } };
  let d = await cli(['task', 'done', r.id, '--yes'], other);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'not-owner'], show(d));
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'cancelled', options: { reason: 'dropped' } });
  d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'task-closed'], show(d));
});

// ---- task merge ----

// The target pins and commits its baseline first (the merge's anchor, review r2 D5), then the branch starts.
async function branchRepo(t, { branchTests, mainTests = null }) {
  const r = repo(t);
  assert.equal((await run(r)).code, 0, 'the target verifies');
  commitAll(r, 'baseline on the target');
  r.git('checkout', '-q', '-b', 'feat/x');
  r.write('calc.test.mjs', branchTests);
  commitAll(r, 'feature');
  r.git('checkout', '-q', 'main');
  if (mainTests !== null) {
    r.write('calc.test.mjs', mainTests);
    commitAll(r, 'main moved');
  }
  return r;
}

test('task merge: merges with --no-commit, runs the outcome gates, commits only when they pass', async (t) => {
  const r = await branchRepo(t, { branchTests: `${TESTS}test('feature', () => {});\n` });
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.merged, true);
  const parents = r.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  assert.deepEqual(parents.slice(1), [before, r.git('rev-parse', 'feat/x')], 'a merge commit of main and the branch');
  assert.equal(r.git('status', '--porcelain'), '');
  assert.equal(res.env.data.result, 'pass');
});

test('task merge: a red gate after merging aborts the merge; nothing is committed', async (t) => {
  const r = await branchRepo(t, { branchTests: `${TESTS}test('breaks', () => { throw new Error('boom'); });\n` });
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.equal(res.env.data.result, 'fail');
  assert.ok(errorCodes(res).includes('gate-failed'));
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '', 'the merge is aborted');
  assert.equal(existsSync(join(r.dir, '.git', 'MERGE_HEAD')), false);
});

test('task merge: a semantic break only visible after merging (both sides green alone) is caught', async (t) => {
  // main removes a helper the branch's new test uses: each side passes, the merge does not.
  const r = repo(t, { files: { 'calc.test.mjs': TESTS, 'helper.mjs': 'export const two = 2;\n' } });
  assert.equal((await run(r)).code, 0);
  commitAll(r, 'baseline on the target');
  r.git('checkout', '-q', '-b', 'feat/x');
  r.write('uses.test.mjs', "import { test } from 'node:test';\nimport { two } from './helper.mjs';\ntest('uses helper', () => { if (two !== 2) throw new Error('x'); });\n");
  commitAll(r, 'feature');
  r.git('checkout', '-q', 'main');
  rmSync(join(r.dir, 'helper.mjs'));
  commitAll(r, 'remove helper');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
});

test('task merge: a conflict aborts with exit 1; a dirty tree, an unknown branch and a missing branch are refused', async (t) => {
  const r = await branchRepo(t, { branchTests: `${TESTS}test('one side', () => {});\n`, mainTests: `${TESTS}test('other side', () => {});\n` });
  const before = r.git('rev-parse', 'HEAD');
  let res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('merge-conflict'));
  assert.deepEqual(res.env.data.conflicts, ['calc.test.mjs']);
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
  r.write('stray.txt', 'x\n');
  res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'dirty-tree']);
  rmSync(join(r.dir, 'stray.txt'));
  res = await cli(['task', 'merge', r.id, '--branch', 'no-such-branch', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'unknown-branch']);
  res = await cli(['task', 'merge', r.id, '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'missing-branch']);
});

// ---- command rows ----

test('verify, task done and task merge are command rows that change files; help lists them', async (t) => {
  const row = (name) => COMMANDS.find((x) => x.name === name);
  for (const name of ['verify', 'task done', 'task merge']) {
    assert.ok(row(name) && !row(name).hidden, name);
    assert.equal(row(name).mutating, true, `${name}: changes files`);
    assert.deepEqual(row(name).args.map((a) => [a.name, Boolean(a.required)]), [['id', true]], name);
  }
  assert.deepEqual(row('verify').flags.map((f) => f.flag), ['--ci']);
  assert.deepEqual(row('task merge').flags.map((f) => f.flag), ['--branch']);
  assert.deepEqual(row('verify').exits, ['OK', 'FAIL', 'USAGE', 'REFUSED', 'ENV']);
  const r = repo(t);
  const help = await cli(['--help'], { ...r, json: false });
  for (const name of ['verify', 'task done', 'task merge']) assert.match(help.text, new RegExp(`^  ${name} `, 'm'), name);
  const text = await cli(['verify', r.id, '--yes'], { ...r, json: false });
  assert.equal(text.code, 0, show(text));
  assert.match(text.text, new RegExp(`^${r.id}: pass`, 'm'));
});

// ---- review r1 (findings-r1.md) ----

// Runs `task done` with `inject` executed when it starts its task update: the boundary between anything checked
// before the store lock and the write (Codex's injection point).
async function doneAcross(r, inject) {
  const original = Store.prototype.update;
  let fired = false;
  Store.prototype.update = function update(name, ...rest) {
    if (!fired && name === 'task') { fired = true; inject(); }
    return original.call(this, name, ...rest);
  };
  try {
    return await done(r);
  } finally {
    Store.prototype.update = original;
  }
}

test('r1 #1: task done decides inside the lock: a review, a commit or a change at the boundary keeps the task open', async (t) => {
  for (const [label, cls, inject, code] of [
    ['needs-fixes review', 'standard', (r) => review(r, 2, 'needs-fixes'), 'review-missing'],
    ['new commit', 'trivial', (r) => { r.write('calc.test.mjs', `${TESTS}test('late', () => {});\n`); commitAll(r, 'late'); }, 'verify-stale'],
    ['uncommitted change', 'trivial', (r) => r.write('calc.test.mjs', `${TESTS}test('late', () => {});\n`), 'uncommitted-changes'],
  ]) {
    const r = repo(t, { cls });
    if (cls === 'standard') { review(r, 1, 'approved'); commitAll(r, 'review'); }
    assert.equal((await run(r)).code, 0, label);
    const d = await doneAcross(r, () => inject(r));
    assert.deepEqual([d.code, errorCodes(d)[0]], [1, code], `${label}: ${show(d)}`);
    assert.notEqual(r.store.read('task', r.id).status, 'done', label);
  }
});

test('r1 #2: a gate changed after a passing verify keeps the task open (the gate ran once, as it was)', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0);
  setGates(r, [{ ...GATES[0], cmd: 'exit 1' }, GATES[1]]);
  const d = await done(r);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'gates-changed'], show(d));
});

test('r1 #2: task merge refuses a branch that weakens the target\'s gates without a new gate-change decision', async (t) => {
  const r = repo(t);
  r.git('checkout', '-q', '-b', 'feat/x');
  setGates(r, [{ ...GATES[0], cmd: 'true' }, GATES[1]]);
  r.write('calc.test.mjs', "import { test } from 'node:test';\ntest('adds', () => { throw new Error('broken'); });\ntest('subtracts', () => {});\n");
  commitAll(r, 'weaken the gate');
  r.git('checkout', '-q', 'main');
  const before = r.git('rev-parse', 'HEAD');
  let res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('gate-change-required'), show(res));
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
  // With its own gate-change decision the branch merges (the decision is the record of the weakening).
  r.git('checkout', '-q', 'feat/x');
  state.allocateId(r.store, {
    prefix: 'D', handle: r.handle,
    build: (x) => decisions.formatRecord({ schema: 1, id: x, title: 'Test gate replaced', status: 'active', kind: 'gate-change', date: '2026-10-15', author: r.handle, supersedes: [], supersededBy: null, scope: [] }, '## What\n\nReplaced.\n\n## Why\n\nTest.\n\n## Cost if wrong\n\nCoverage.\n\n## Alternatives\n\nNone.\n'),
  });
  r.write('calc.test.mjs', TESTS);
  commitAll(r, 'decision');
  r.git('checkout', '-q', 'main');
  res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 0, show(res));
});

test('r1 #3: task merge compares with the baseline committed on the target, not with what the branch brings', async (t) => {
  const r = repo(t);
  r.git('branch', 'feat/x');
  assert.equal((await run(r)).code, 0);
  commitAll(r, 'baseline on main');
  r.git('checkout', '-q', 'feat/x');
  r.git('merge', '-q', '--ff-only', 'main');
  r.write('calc.test.mjs', "import { test } from 'node:test';\ntest('adds', () => {});\n");
  const doc = r.vstore.read('baseline', null);
  const forged = { ...doc, tests: doc.tests.filter((x) => !x.id.includes('subtracts')) };
  r.vstore.write('baseline', null, { ...forged, sha256: verify.baselineSha(forged) });
  commitAll(r, 'drop a test and its baseline entry');
  r.git('checkout', '-q', 'main');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.equal(res.env.data.result, 'baseline-shrunk');
  assert.equal(r.git('rev-parse', 'HEAD'), before);
});

test('r1 #4: task merge commits exactly the tree its gates ran on: a working-tree change during the gates aborts it', async (t) => {
  const value = (v) => `export const v = ${v};\n`;
  const r = repo(t, {
    files: { 'value.mjs': value(2), 'v.test.mjs': "import { test } from 'node:test';\nimport { v } from './value.mjs';\ntest('v', () => { if (v !== 2) throw new Error(`v is ${v}`); });\n" },
    gates: [{ name: 'fix', cmd: `node -e "require('fs').writeFileSync('value.mjs', 'export const v = 2;\\n')"`, timeoutS: 60, kind: 'other' }, { name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }],
  });
  r.git('checkout', '-q', '-b', 'feat/x');
  r.write('value.mjs', value(1));
  commitAll(r, 'breaks v');
  r.git('checkout', '-q', 'main');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('merge-tree-changed'), show(res));
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(r.dir, 'value.mjs'), 'utf8'), value(2));
  assert.equal(r.git('status', '--porcelain'), '');
});

test('r1: task merge is the owner\'s and refuses a closed task', async (t) => {
  const r = await branchRepo(t, { branchTests: `${TESTS}test('feature', () => {});\n` });
  state.registerHandle(r.store, { name: 'Other Person', email: 'other@example.com', at: AT });
  commitAll(r, 'team');
  const other = { ...r, env: { ...r.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'other@example.com' } };
  let res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], other);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'not-owner'], show(res));
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'cancelled', options: { reason: 'dropped' } });
  commitAll(r, 'cancel');
  res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'task-closed'], show(res));
  assert.equal(r.git('status', '--porcelain'), '');
});

// ---- review r2 (findings-r2.md, Codex rereview-r1.md) ----

// The target pins its baseline first (an anchor for the merge), then the branch starts from it.
async function anchoredBranch(t, branchFiles, { gates = GATES } = {}) {
  const r = repo(t, { gates });
  assert.equal((await run(r)).code, 0, 'the target verifies');
  commitAll(r, 'baseline on the target');
  r.git('checkout', '-q', '-b', 'feat/x');
  for (const [rel, text] of Object.entries(branchFiles)) r.write(rel, text);
  return r;
}
const hook = (r, body) => {
  const file = join(r.dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

test('r2 D2: task merge refuses any change to the gate set without a new gate-change decision (gates added around it, reordered)', async (t) => {
  const failing = "import { test } from 'node:test';\ntest('adds', () => { throw new Error('broken'); });\ntest('subtracts', () => {});\n";
  for (const [label, gates] of [
    ['prep and cleanup around the unchanged test gate', [{ name: 'prep', cmd: 'cp fixtures/pass.txt calc.test.mjs', timeoutS: 60, kind: 'other' }, GATES[0], { name: 'cleanup', cmd: 'cp fixtures/fail.txt calc.test.mjs', timeoutS: 60, kind: 'other' }, GATES[1]]],
    ['reordered', [GATES[1], GATES[0]]],
  ]) {
    const r = await anchoredBranch(t, { 'fixtures/pass.txt': TESTS, 'fixtures/fail.txt': failing, 'calc.test.mjs': label === 'reordered' ? TESTS : failing });
    setGates(r, gates);
    commitAll(r, label);
    r.git('checkout', '-q', 'main');
    const before = r.git('rev-parse', 'HEAD');
    const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
    assert.equal(res.code, 1, `${label}: ${show(res)}`);
    assert.ok(errorCodes(res).includes('gate-change-required'), `${label}: ${show(res)}`);
    assert.equal(r.git('rev-parse', 'HEAD'), before, label);
  }
});

test('r2 D3: task merge commits with git commit, so a refusing user hook refuses the merge', async (t) => {
  const r = await anchoredBranch(t, { 'calc.test.mjs': `${TESTS}test('feature', () => {});\n` });
  commitAll(r, 'feature');
  r.git('checkout', '-q', 'main');
  hook(r, 'echo "policy: merges need a ticket" >&2\nexit 1');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'commit-failed'], show(res));
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
});

test('r2 D3: a hook that changes the committed tree undoes the commit (reset --soft) and asks for the merge again', async (t) => {
  const r = await anchoredBranch(t, { 'calc.test.mjs': `${TESTS}test('feature', () => {});\n` });
  commitAll(r, 'feature');
  r.git('checkout', '-q', 'main');
  hook(r, 'echo hooked > hooked.txt\ngit add hooked.txt');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'hook-modified-tree'], show(res));
  assert.equal(r.git('rev-parse', 'HEAD'), before, 'the branch is where it was');
  assert.match(r.git('status', '--porcelain'), /^A {2}hooked\.txt$/m, 'nothing lost: the merge stays staged');
});

test('r2 D3: a target that moves while the gates run is never moved back', async (t) => {
  const advance = { name: 'advance', cmd: 'git update-ref HEAD "$(git commit-tree HEAD^{tree} -p HEAD -m concurrent)"', timeoutS: 60, kind: 'other' };
  const r = await anchoredBranch(t, { 'calc.test.mjs': `${TESTS}test('feature', () => {});\n` }, { gates: [...GATES, advance] });
  commitAll(r, 'feature');
  r.git('checkout', '-q', 'main');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'target-moved'], show(res));
  const now = r.git('rev-parse', 'HEAD');
  assert.notEqual(now, before, 'the concurrent commit stays');
  assert.equal(r.git('rev-parse', `${now}^`), before);
});

test('r2 D3: lib/verify never resets hard, writes refs or builds commits by hand', () => {
  const dir = join(pluginDir, 'lib', 'verify');
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(text, /--hard|update-ref|commit-tree/, f);
  }
});

test('r2 D4: a weak (generic-only) test gate is always refused for a critical task; an unrelated gate-change decision does not waive it', async (t) => {
  const files = { 'test/a.test.mjs': "import { test } from 'node:test';\ntest('fast', () => {});\nif (process.env.INCLUDE_SLOW_TESTS) test('slow', () => {});\n" };
  const r = repo(t, { files, gates: [{ name: 'dots', cmd: 'node --test --test-reporter=dot', timeoutS: 120, kind: 'test' }], cls: 'critical' });
  review(r, 1, 'approved', 'external');
  state.allocateId(r.store, {
    prefix: 'D', handle: r.handle,
    build: (x) => decisions.formatRecord({ schema: 1, id: x, title: 'Increase documentation lint timeout', status: 'active', kind: 'gate-change', date: '2026-10-15', author: r.handle, supersedes: [], supersededBy: null, scope: ['docs/**'] }, '## What\n\nTimeout.\n\n## Why\n\nSlow.\n\n## Cost if wrong\n\nNone.\n\n## Alternatives\n\nNone.\n'),
  });
  commitAll(r, 'review and decision');
  const res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.ok(errorCodes(res).includes('weak-collector'), show(res));
  assert.equal(res.env.data.inventory.weak, true);
});

test('r2 D5: task merge compares with the target tip: a test added to the target after the task base and deleted by the task is refused', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0);
  const base = commitAll(r, 'baseline at the base');
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'dispatched', options: { executor: 'claude:implementer', base } });
  commitAll(r, 'dispatched');
  r.git('branch', 'feat/x');
  r.write('calc.test.mjs', `${TESTS}test('extra', () => {});\n`);
  assert.equal((await run(r)).code, 0, 'the target grows');
  commitAll(r, 'extra test on the target');
  r.git('checkout', '-q', 'feat/x');
  r.git('merge', '-q', '--no-edit', 'main');
  r.write('calc.test.mjs', TESTS);
  const doc = r.vstore.read('baseline', null);
  const forged = { ...doc, tests: doc.tests.filter((x) => !x.id.includes('extra')) };
  r.vstore.write('baseline', null, { ...forged, sha256: verify.baselineSha(forged) });
  commitAll(r, 'drop the target\'s new test');
  r.git('checkout', '-q', 'main');
  const before = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 1, show(res));
  assert.equal(res.env.data.result, 'baseline-shrunk');
  assert.equal(r.git('rev-parse', 'HEAD'), before);
});
