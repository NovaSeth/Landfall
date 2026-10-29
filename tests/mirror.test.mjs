// `landfall mirror github` (T-MG-19, D-MG-23): one-way, opt-in, idempotent; a fake gh on PATH records every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', 'landfall');
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';
const FAKE = join(root, 'tests', 'fixtures', 'mirror');

function setup(t, tasks) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mirror-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const run = (...a) => { const r = spawnSync('git', a, { cwd: dir, env: ISO.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run('-c', 'init.defaultBranch=main', 'init', '-q');
  const store = state.open(join(dir, names.stateDir), { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  for (const [id, title, status, cls, branch] of tasks) {
    store.write('task', id, { id, kind: 'task', title, lane: null, owner: handle, class: cls, classHistory: [{ class: cls, reason: 'trivial: test', at: AT }], status, round: 0, events: [], base: null, branch });
  }
  const log = join(base, 'gh.log');
  const issues = join(base, 'issues.json');
  const env = { ...ISO.env, PATH: `${FAKE}:${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ISSUES: issues };
  return { dir, store, handle, log, issues, env, base };
}
const calls = (r) => (existsSync(r.log) ? readFileSync(r.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const writes = (r) => calls(r).filter((c) => (c.args[0] === 'issue' && c.args[1] !== 'list') || (c.args[0] === 'label'));
async function cli(r, args, env = r.env) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: r.dir, stdin: null };
  const code = await main([...args, '--json'], { io });
  const text = out.join('');
  return { code, env: JSON.parse(text), stderr: err.join('') };
}
const TASKS = [['T-MG-1', 'first task', 'dispatched', 'standard', 'task/T-MG-1'], ['T-MG-2', 'second', 'done', 'trivial', null]];

test('gh auth status fails: exit 8 (ENV) with a hint, nothing else runs', async (t) => {
  const r = setup(t, TASKS);
  const res = await cli(r, ['mirror', 'github', '--yes'], { ...r.env, FAKE_GH_AUTH: 'fail' });
  assert.equal(res.code, 8, res.stderr);
  assert.match(res.env.errors[0].hint, /gh auth login/);
  assert.deepEqual(calls(r).map((c) => c.args.slice(0, 2).join(' ')), ['auth status']);
});

test('--dry-run prints the target repository and the plan and makes no writes', async (t) => {
  const r = setup(t, TASKS);
  const res = await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--dry-run']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.env.data.repo, 'acme/widgets');
  assert.deepEqual(res.env.data.plan.map((p) => [p.action, p.id]), [['create', 'T-MG-1'], ['create', 'T-MG-2']]);
  assert.deepEqual(writes(r), []);
});

test('without --repo the target is gh default repository; without --yes and a terminal it is refused (exit 7)', async (t) => {
  const r = setup(t, TASKS);
  const refused = await cli(r, ['mirror', 'github']);
  assert.equal(refused.code, 7);
  assert.deepEqual(writes(r), []);
  const res = await cli(r, ['mirror', 'github', '--dry-run']);
  assert.equal(res.env.data.repo, 'acme/widgets');
});

test('create: one issue per task with title, marker, labels, links; a done task is closed', async (t) => {
  const r = setup(t, TASKS);
  const res = await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  assert.equal(res.code, 0, res.stderr);
  const creates = calls(r).filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
  assert.equal(creates.length, 2);
  const first = creates[0];
  assert.ok(first.args.includes('T-MG-1 first task'));
  assert.deepEqual(first.args.filter((a, i) => first.args[i - 1] === '--label'), ['landfall', 'class:standard', 'status:dispatched']);
  assert.match(first.stdin, /^<!-- landfall:T-MG-1 -->\n/);
  assert.match(first.stdin, /status: dispatched/);
  assert.match(first.stdin, /branch: task\/T-MG-1/);
  const closes = calls(r).filter((c) => c.args[0] === 'issue' && c.args[1] === 'close');
  assert.deepEqual(closes.map((c) => c.args[2]), ['101']);
});

// What gh would list after a first run: built from the create calls.
function listed(r, overrides = {}) {
  const issues = calls(r).filter((c) => c.args[0] === 'issue' && c.args[1] === 'create').map((c, i) => {
    const a = c.args;
    const title = a[a.indexOf('--title') + 1];
    const id = title.split(' ')[0];
    return { number: 100 + i, title, body: c.stdin, state: id === 'T-MG-2' ? 'CLOSED' : 'OPEN', labels: a.filter((x, k) => a[k - 1] === '--label').map((name) => ({ name })), ...(overrides[id] ?? {}) };
  });
  writeFileSync(r.issues, JSON.stringify(issues));
}

test('a second run with no changes makes zero writes', async (t) => {
  const r = setup(t, TASKS);
  await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  listed(r);
  rmSync(r.log);
  const res = await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.env.data.plan.map((p) => p.action), ['none', 'none']);
  assert.deepEqual(writes(r), []);
});

test('a title change edits the existing issue by number; nothing is created', async (t) => {
  const r = setup(t, TASKS);
  await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  listed(r);
  rmSync(r.log);
  r.store.write('task', 'T-MG-1', { ...r.store.read('task', 'T-MG-1'), title: 'renamed task' });
  const res = await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  assert.equal(res.code, 0, res.stderr);
  const w = writes(r);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].args.slice(0, 3), ['issue', 'edit', '100']);
  assert.ok(w[0].args.includes('T-MG-1 renamed task'));
});

test('a task turned done closes its open issue', async (t) => {
  const r = setup(t, TASKS);
  await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  listed(r);
  rmSync(r.log);
  r.store.write('task', 'T-MG-1', { ...r.store.read('task', 'T-MG-1'), status: 'done' });
  await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  const w = writes(r);
  assert.ok(w.some((c) => c.args[1] === 'close' && c.args[2] === '100'));
});

test('a title with $(...) and backticks reaches gh byte for byte, as one argv item', async (t) => {
  const r = setup(t, [['T-MG-3', 'x $(touch pwned) `id` "q" ; rm', 'new', 'trivial', null]]);
  const res = await cli(r, ['mirror', 'github', '--repo', 'acme/widgets', '--yes']);
  assert.equal(res.code, 0, res.stderr);
  const create = calls(r).find((c) => c.args[1] === 'create');
  assert.ok(create.args.includes('T-MG-3 x $(touch pwned) `id` "q" ; rm'));
  assert.ok(create.stdin.length > 0);
  assert.equal(existsSync(join(r.dir, 'pwned')), false);
});
