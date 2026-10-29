// The merge record (T-MG-80): `task merge` writes a `merged` event and mergedAt on the task through lib/state, and
// `task merge --adopt <ids…>` records tasks merged by hand after one gate run on HEAD, only for branch tips that are
// ancestors of HEAD; a failing gate records nothing. This file holds no plugin name or path: both come from lib/name.json.
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
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';
const TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\n";
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "2 passing"}\n---\n\n# Report\n';

function repo(t, { gate = 'node --test' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'merge-record-')));
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
  write('calc.test.mjs', TESTS);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: gate, timeoutS: 120, kind: 'test' }] });
  const task = (branch) => {
    const id = state.allocateId(store, {
      prefix: 'T', handle,
      build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'trivial', classHistory: [], status: 'done', round: 0, events: [], base: head, branch }),
    });
    writeFileSync(join(stateDir, 'tasks', id, 'report.md'), REPORT);
    return id;
  };
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  // A branch with one new passing test file (or a failing one), from main.
  const branch = (name, file, body = "test('ok', () => {});") => {
    git('checkout', '-q', '-b', name, 'main');
    write(file, `import { test } from 'node:test';\n${body}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    git('checkout', '-q', 'main');
    return git('rev-parse', name);
  };
  return { dir, env, stateDir, store, handle, git, write, task, branch };
}

async function cli(args, { dir, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, env: JSON.parse(out.join('')), stderr: err.join('') };
}
const merges = (r, id) => r.store.read('task', id).events.filter((e) => e.event === 'merged');

test('a single task merge writes the merged event and mergedAt through lib/state', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs');
  const id = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  const res = await cli(['task', 'merge', id, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  const commit = r.git('rev-parse', 'HEAD');
  const events = merges(r, id);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].data), ['commit', 'target', 'batch', 'adopted', 'verify']);
  assert.deepEqual([events[0].data.commit, events[0].data.target, events[0].data.batch, events[0].data.adopted], [commit, 'main', null, false]);
  assert.match(events[0].data.verify, /^[0-9a-f]{40,64}$/);
  const doc = r.store.read('task', id);
  assert.equal(doc.mergedAt, events[0].at);
  assert.equal(doc.schema, state.KINDS.task.version);
  assert.equal(r.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '', 'the code is clean; only the record is an uncommitted state write');
  // The record does not block the next merge: a second task merges with the first one's record uncommitted.
  r.branch('feat/b', 'b.test.mjs');
  const id2 = r.task('feat/b');
  const res2 = await cli(['task', 'merge', id2, '--yes'], r);
  assert.equal(res2.code, 0, JSON.stringify(res2.env.errors));
  assert.equal(merges(r, id2).length, 1);
  assert.equal(merges(r, id).length, 1, 'the first record survives the second merge');
  const show = await cli(['task', 'show', id], r);
  assert.equal(show.env.data.task.mergedAt, doc.mergedAt);
});

test('task merge --adopt records only tasks whose branch tip is an ancestor of HEAD, after one gate run', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs');
  r.branch('feat/b', 'b.test.mjs');
  const a = r.task('feat/a');
  const b = r.task('feat/b');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'tasks');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const head = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', '--adopt', a, b, '--yes'], r);
  assert.equal(res.code, 1, 'one task was not adopted');
  assert.equal(res.env.data.result, 'pass');
  assert.deepEqual(res.env.data.tasks.map((x) => [x.task, x.adopted, x.why]), [[a, true, null], [b, false, 'not-ancestor']]);
  assert.deepEqual(res.env.errors.map((e) => e.code), ['not-ancestor']);
  const ev = merges(r, a);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].data.commit, ev[0].data.target, ev[0].data.adopted, ev[0].data.batch], [head, 'main', true, null]);
  assert.equal(merges(r, b).length, 0, 'a task not merged into HEAD is not recorded');
  assert.equal(r.git('rev-parse', 'HEAD'), head, 'adopt moves nothing');
});

test('task merge --adopt with a failing gate records nothing', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs', "test('breaks', () => { throw new Error('boom'); });");
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const res = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.equal(res.code, 1);
  assert.equal(res.env.data.result, 'fail');
  assert.equal(merges(r, a).length, 0);
  assert.equal(r.store.read('task', a).mergedAt, undefined);
});

test('task merge takes --branch only with one ID (several IDs are a batch)', async (t) => {
  const r = repo(t);
  const res = await cli(['task', 'merge', 'T-MG-1', 'T-MG-2', '--branch', 'feat/a', '--yes'], r);
  assert.equal(res.code, 2);
  assert.equal(res.env.errors[0].code, 'unexpected-flag');
});

test('fix round 1 (F2): task merge --adopt whose gate changes tracked code records nothing (merge-tree-changed)', async (t) => {
  const r = repo(t, { gate: "node --test; s=$?; case \"$PWD\" in */repo) echo '// changed' >> calc.test.mjs;; esac; exit $s" });
  r.branch('feat/a', 'a.test.mjs');
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const res = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.ok(res.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(res.env.errors));
  assert.equal(merges(r, a).length, 0, 'nothing is recorded');
  assert.equal(r.store.read('task', a).mergedAt, undefined);
});

test('fix round 1: --adopt and --ready together are a usage error', async (t) => {
  const r = repo(t);
  const res = await cli(['task', 'merge', '--adopt', '--ready', '--yes'], r);
  assert.equal(res.code, 2);
  assert.equal(res.env.errors[0].code, 'unexpected-flag');
});
