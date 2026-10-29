// Batch merge (T-MG-80 slice B): `task merge <id> <id>…` and `task merge --ready` merge the task branches with --no-ff
// in a temporary integration worktree, run the gates once on the integrated tree, bisect a failing batch, fast-forward
// the target only on pass and only when it has not moved, and remove the temporary branch and worktree in every case.
// The fake gate is `node --test` that logs its working directory (no sleep, no load). This file holds no plugin name
// or path: both come from lib/name.json.
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

// A repository with in-repo state, a gate that logs where it ran, done tasks and their branches.
function repo(t, { extra = '' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'batch-merge-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  const log = join(base, 'runs.log');
  mkdirSync(dir);
  mkdirSync(home);
  writeFileSync(log, '');
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
  const gate = `node --test; s=$?; pwd >> '${log}'; ${extra} exit $s`;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: gate, timeoutS: 30, kind: 'test' }] });
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  // A done task (its done event at the branch tip) on a branch from main with one new test file.
  const task = (name, file, body = "test('ok', () => {});", { status = 'done' } = {}) => {
    git('checkout', '-q', '-b', name, 'main');
    write(file, `import { test } from 'node:test';\n${body}\n`);
    git('add', '-A', '--', '.', `:(exclude)${names.stateDir}`);
    git('commit', '-q', '-m', name);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const id = state.allocateId(store, {
      prefix: 'T', handle,
      build: (tid) => ({
        id: tid, kind: 'task', title: `task ${name}`, lane: null, owner: handle, class: 'trivial', classHistory: [], status, round: 0,
        events: status === 'done' ? [{ at: AT, by: handle, event: 'done', data: { head: sha } }] : [], base: head, branch: name,
      }),
    });
    writeFileSync(join(stateDir, 'tasks', id, 'report.md'), REPORT);
    git('add', '-A');
    git('commit', '-q', '-m', `task ${id}`);
    return id;
  };
  // The gate runs on an integration tree (the base measurement runs elsewhere, under local/). A short gate takes no
  // heavy lease, so the machine's load does not delay the test.
  const runs = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(`${names.codename}-batch-`)).length;
  return { dir, env, stateDir, store, handle, git, write, task, runs };
}

async function cli(args, { dir, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, env: JSON.parse(out.join('')), stderr: err.join('') };
}
async function text(args, { dir, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main(args, { io });
  return { code, out: out.join('') };
}
const merges = (r, id) => r.store.read('task', id).events.filter((e) => e.event === 'merged');
const outcomes = (res) => res.env.data.tasks.map((x) => [x.task, x.outcome]);
// No temporary branch or worktree is left, whatever the outcome.
function cleaned(r, res) {
  assert.equal(r.git('branch', '--list', `${names.codename}/batch-*`), '', 'the integration branch is removed');
  assert.equal(r.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'only the main checkout is left');
  assert.ok(res.env.data.worktree, 'the integration worktree is named');
  assert.ok(!existsSync(res.env.data.worktree), 'the integration worktree directory is removed');
}

test('a batch of 3 passing tasks runs the gates once and records 3 merged events with the batch id', async (t) => {
  const r = repo(t);
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs'), r.task('feat/c', 'c.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.equal(r.runs(), 1, 'one gate run on the integrated tree');
  assert.equal(res.env.data.gateRuns, 1);
  assert.match(res.env.data.batch, /^batch-\d{8}T\d{6}(?:-\d+)?$/);
  assert.deepEqual(outcomes(res), ids.map((id) => [id, 'merged']));
  const head = r.git('rev-parse', 'HEAD');
  assert.notEqual(head, tip);
  assert.equal(r.git('merge-base', '--is-ancestor', tip, head), '', 'the target was fast-forwarded');
  for (const b of ['feat/a', 'feat/b', 'feat/c']) r.git('merge-base', '--is-ancestor', b, 'HEAD');
  for (const id of ids) {
    const ev = merges(r, id);
    assert.equal(ev.length, 1, id);
    assert.deepEqual([ev[0].data.commit, ev[0].data.target, ev[0].data.batch, ev[0].data.adopted], [head, 'main', res.env.data.batch, false]);
    assert.equal(r.store.read('task', id).mergedAt, ev[0].at);
  }
  cleaned(r, res);
  const shown = await text(['task', 'merge', '--ready', '--yes'], r);
  assert.equal(shown.code, 0, 'nothing ready is no failure');
});

test('a batch with one breaking task bisects, merges the other two and reports the third with its failing test', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const b = r.task('feat/b', 'b.test.mjs', "test('breaks', () => { throw new Error('boom'); });");
  const c = r.task('feat/c', 'c.test.mjs');
  const res = await cli(['task', 'merge', a, b, c, '--yes'], r);
  assert.equal(res.code, 1, 'one task failed');
  assert.deepEqual(outcomes(res), [[a, 'merged'], [b, 'failed'], [c, 'merged']]);
  const failed = res.env.data.tasks.find((x) => x.task === b);
  assert.ok(failed.tests.some((x) => x.includes('breaks')), JSON.stringify(failed));
  // the full batch, ⌈log2 3⌉ = 2 bisect runs, one confirming run on the set without the culprit
  assert.equal(res.env.data.gateRuns, r.runs());
  assert.ok(r.runs() <= 4, `at most 4 gate runs, got ${r.runs()}`);
  assert.equal(merges(r, a).length, 1);
  assert.equal(merges(r, c).length, 1);
  assert.equal(merges(r, b).length, 0, 'the failing task is not recorded');
  r.git('merge-base', '--is-ancestor', 'feat/a', 'HEAD');
  r.git('merge-base', '--is-ancestor', 'feat/c', 'HEAD');
  assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', 'feat/b', 'HEAD'], { cwd: r.dir, env: r.env }).status, 0, 'the failing branch is not on the target');
  cleaned(r, res);
});

test('a conflicting task is left out; the rest merge', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'same.test.mjs', "test('one', () => {});");
  const b = r.task('feat/b', 'same.test.mjs', "test('two', () => {});");
  const c = r.task('feat/c', 'c.test.mjs');
  const res = await cli(['task', 'merge', a, b, c, '--yes'], r);
  assert.equal(res.code, 1, 'a conflict is reported');
  assert.deepEqual(outcomes(res), [[a, 'merged'], [b, 'conflict'], [c, 'merged']]);
  assert.deepEqual(res.env.data.tasks.find((x) => x.task === b).conflicts, ['same.test.mjs']);
  assert.equal(r.runs(), 1);
  assert.equal(merges(r, b).length, 0);
  assert.equal(merges(r, a).length + merges(r, c).length, 2);
  assert.equal(r.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '', 'no merge is left in progress');
  cleaned(r, res);
});

test('the target moving during the gate changes nothing', async (t) => {
  const r = repo(t, { extra: "git -C \"$TARGET_DIR\" commit -q --allow-empty -m moved;" });
  const a = r.task('feat/a', 'a.test.mjs');
  const b = r.task('feat/b', 'b.test.mjs');
  r.env.TARGET_DIR = r.dir;
  const res = await cli(['task', 'merge', a, b, '--yes'], r);
  assert.equal(res.code, 1);
  assert.ok(res.env.errors.some((e) => e.code === 'target-moved'), JSON.stringify(res.env.errors));
  assert.equal(r.git('log', '-1', '--format=%s'), 'moved', 'the target keeps the commit made meanwhile and nothing else');
  assert.equal(merges(r, a).length + merges(r, b).length, 0, 'nothing is recorded');
  cleaned(r, res);
});

test('--ready picks only done tasks with a branch that are not merged, in task order', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const open = r.task('feat/open', 'open.test.mjs', undefined, { status: 'verified' });
  const done = r.task('feat/done', 'done.test.mjs');
  const first = await cli(['task', 'merge', done, '--yes'], r);
  assert.equal(first.code, 0, JSON.stringify(first.env.errors));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'record');
  const c = r.task('feat/c', 'c.test.mjs');
  const res = await cli(['task', 'merge', '--ready', '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.deepEqual(outcomes(res), [[a, 'merged'], [c, 'merged']]);
  assert.equal(merges(r, open).length, 0);
  assert.equal(merges(r, done).length, 1, 'a merged task is not merged again');
  cleaned(r, res);
  const txt = await text(['task', 'merge', '--ready', '--yes'], r);
  assert.equal(txt.code, 0);
});

test('the text output has one line per task, the gate runs and the batch id', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const b = r.task('feat/b', 'same.test.mjs', "test('one', () => {});");
  const c = r.task('feat/c', 'same.test.mjs', "test('two', () => {});");
  const res = await text(['task', 'merge', a, b, c, '--yes'], r);
  assert.equal(res.code, 1);
  assert.match(res.out, new RegExp(`^${a}  merged$`, 'm'));
  assert.match(res.out, new RegExp(`^${b}  merged$`, 'm'));
  assert.match(res.out, new RegExp(`^${c}  conflict`, 'm'));
  assert.match(res.out, /gate runs: 1 · batch batch-\d{8}T\d{6}/);
});
