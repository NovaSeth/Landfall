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
  // onBranch: called on the branch before its commit (it may change the state directory there, such as the profile).
  const task = (name, file, body = "test('ok', () => {});", { status = 'done', onBranch = null } = {}) => {
    git('checkout', '-q', '-b', name, 'main');
    write(file, `import { test } from 'node:test';\n${body}\n`);
    if (onBranch) onBranch();
    git('add', '-A', '--', '.', ...(onBranch ? [] : [`:(exclude)${names.stateDir}`]));
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

// ---- fix round 1 (review r1 F1 F3 F5, automated review AR-1 AR-2 AR-3) ----
const IN_BATCH = (cmd) => `case "$PWD" in *-batch-*) ${cmd};; esac;`;
const nothingMoved = (r, tip, ids) => {
  assert.equal(r.git('rev-parse', 'main'), tip, 'the target did not move');
  for (const id of ids) assert.equal(merges(r, id).length, 0, `${id}: nothing is recorded`);
};

test('F1: a gate that changes tracked code in the integration worktree merges nothing (merge-tree-changed)', async (t) => {
  const r = repo(t, { extra: IN_BATCH("echo '// changed' >> calc.test.mjs") });
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.ok(res.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(res.env.errors));
  nothingMoved(r, tip, ids);
  cleaned(r, res);
});

test('F1: a gate that commits in the integration worktree merges nothing; the target never gets the unverified commit', async (t) => {
  const r = repo(t, { extra: IN_BATCH('git commit -q --allow-empty -m sneaky') });
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.ok(res.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(res.env.errors));
  assert.notEqual(r.git('log', '-1', '--format=%s', 'main'), 'sneaky');
  nothingMoved(r, tip, ids);
  cleaned(r, res);
});

test('F3: each task of the batch is checked against its own artifacts: a task whose report has no evidence is not merged', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const b = r.task('feat/b', 'b.test.mjs');
  writeFileSync(join(r.stateDir, 'tasks', b, 'report.md'), '# Report\n\nno evidence\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'report without evidence');
  const res = await cli(['task', 'merge', a, b, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  const out = Object.fromEntries(outcomes(res));
  assert.equal(out[a], 'merged');
  assert.ok(['failed', 'skipped'].includes(out[b]), JSON.stringify(res.env.data.tasks));
  assert.match(res.env.data.tasks.find((x) => x.task === b).why, /report/);
  assert.equal(merges(r, b).length, 0);
  assert.equal(merges(r, a).length, 1);
  cleaned(r, res);
});

test('F5: the checkout switched to another branch at the same tip during the gate is target-moved; no branch moves', async (t) => {
  const r = repo(t, { extra: IN_BATCH('git -C "$TARGET_DIR" checkout -q -b other') });
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  r.env.TARGET_DIR = r.dir;
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.ok(res.env.errors.some((e) => e.code === 'target-moved'), JSON.stringify(res.env.errors));
  assert.equal(r.git('rev-parse', 'other'), tip, 'the branch checked out meanwhile is not fast-forwarded');
  nothingMoved(r, tip, ids);
  cleaned(r, res);
});

test('AR-2: a done head that is no object id is skipped before any git call (a branch starting with "-" is refused by the task schema)', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const b = r.task('feat/b', 'b.test.mjs');
  const c = r.task('feat/c', 'c.test.mjs');
  r.store.update('task', a, (cur) => ({ ...cur, events: cur.events.map((e) => (e.event === 'done' ? { ...e, data: { head: '--output=x' } } : e)) }));
  assert.throws(() => r.store.update('task', b, (cur) => ({ ...cur, branch: '--orphan' })), /does not match/);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'odd records');
  const res = await cli(['task', 'merge', a, b, c, '--yes'], r);
  assert.equal(res.code, 1);
  const by = Object.fromEntries(res.env.data.tasks.map((x) => [x.task, x]));
  assert.equal(by[a].outcome, 'skipped');
  assert.match(by[a].why, /done record/);
  assert.equal(by[b].outcome, 'merged');
  assert.equal(by[c].outcome, 'merged');
  assert.ok(!existsSync(join(r.dir, 'x')), 'no file was written by an option');
  cleaned(r, res);
});

test('a branch that changes the gates is skipped from the batch (merge it alone)', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const g = r.task('feat/g', 'g.test.mjs', undefined, {
    onBranch: () => {
      const st = profile.openStore(r.stateDir, names);
      const cur = st.read('profile', null);
      st.write('profile', null, { ...cur, gates: cur.gates.map((x) => ({ ...x, timeoutS: 31 })) });
    },
  });
  const res = await cli(['task', 'merge', a, g, '--yes'], r);
  assert.equal(res.code, 1);
  assert.deepEqual(outcomes(res), [[a, 'merged'], [g, 'skipped']]);
  assert.match(res.env.data.tasks.find((x) => x.task === g).why, /changes the gates/);
  assert.equal(merges(r, g).length, 0);
  cleaned(r, res);
});

test('a second failure after the culprit: only the prefix before the culprit merges, the rest are skipped', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', 'a.test.mjs');
  const b = r.task('feat/b', 'b.test.mjs', "test('breaks', () => { throw new Error('boom'); });");
  const c = r.task('feat/c', 'c.test.mjs', "test('breaks too', () => { throw new Error('boom'); });");
  const res = await cli(['task', 'merge', a, b, c, '--yes'], r);
  assert.equal(res.code, 1);
  assert.deepEqual(outcomes(res), [[a, 'merged'], [b, 'failed'], [c, 'skipped']]);
  assert.match(res.env.data.tasks.find((x) => x.task === c).why, /not verified/);
  assert.equal(merges(r, a).length, 1);
  assert.equal(merges(r, b).length + merges(r, c).length, 0);
  r.git('merge-base', '--is-ancestor', 'feat/a', 'HEAD');
  cleaned(r, res);
});

// ---- fix round 2 (review r2 F1 F5) ----
const cacheEntries = (r) => {
  const d = join(r.stateDir, 'local', 'gate-cache');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0;
};

test('fix round 2 (F1): a batch rejected by merge-tree-changed stores no gate-cache entry; the retry runs the gates and merges nothing', async (t) => {
  const r = repo(t, { extra: IN_BATCH("echo '// changed' >> calc.test.mjs") });
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  const first = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.ok(first.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(first.env.errors));
  assert.equal(cacheEntries(r), 0, 'a rejected run publishes no gate-cache entry');
  const before = r.runs();
  const retry = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.ok(r.runs() > before, 'the retry ran the gates');
  assert.equal(retry.code, 1, JSON.stringify(retry.env.errors));
  assert.ok(retry.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(retry.env.errors));
  nothingMoved(r, tip, ids);
  cleaned(r, retry);
});

test('fix round 2 (F1): a passing batch still publishes its gate-cache entry', async (t) => {
  const r = repo(t);
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.equal(cacheEntries(r), 1);
});

// The checkout switched to `other` at the same tip after the last check, right before the target is updated: a git
// wrapper on PATH switches once, on the first command that would move a ref of the main checkout.
function switchBeforeUpdate(t, r) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { env: r.env, encoding: 'utf8' }).stdout.trim();
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'batch-git-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const mark = join(bin, 'switched');
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    'case " $* " in',
    `  *" update-ref "*|*" --ff-only "*|*" reset "*) if [ "$PWD" = '${r.dir}' ] && [ ! -e '${mark}' ]; then : > '${mark}'; '${real}' checkout -q -b other; fi;;`,
    'esac',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  r.env.PATH = `${bin}:${r.env.PATH}`;
  return mark;
}

test('fix round 2 (F5): the checkout switched to another branch after the final read: no branch other than the target moves', async (t) => {
  const r = repo(t);
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  const mark = switchBeforeUpdate(t, r);
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.ok(existsSync(mark), 'the probe switched the checkout');
  assert.equal(r.git('rev-parse', 'other'), tip, 'the branch checked out meanwhile does not move');
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.ok(res.env.errors.some((e) => e.code === 'target-moved'), JSON.stringify(res.env.errors));
  nothingMoved(r, tip, ids);
  cleaned(r, res);
});

test('fix round 2 (F5): a batch updates the target ref and its checkout and keeps uncommitted state writes', async (t) => {
  const r = repo(t);
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  writeFileSync(join(r.stateDir, 'note.txt'), 'kept\n');
  r.git('add', '--', join(r.stateDir, 'note.txt'));
  r.git('commit', '-q', '-m', 'note');
  writeFileSync(join(r.stateDir, 'note.txt'), 'kept, edited\n'); // an uncommitted write in the state directory
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.equal(r.git('rev-parse', 'main'), res.env.data.commit);
  assert.equal(r.git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.ok(existsSync(join(r.dir, 'a.test.mjs')) && existsSync(join(r.dir, 'b.test.mjs')), 'the checkout holds the merged files');
  assert.equal(readFileSync(join(r.stateDir, 'note.txt'), 'utf8'), 'kept, edited\n', 'the uncommitted state write is kept');
  assert.equal(r.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '', 'the code is clean');
  cleaned(r, res);
});

test('T-MG-83: a batch whose gate set is not trusted on this machine is refused before any merge or gate run (gates-untrusted)', async (t) => {
  const r = repo(t);
  // The gate set changed by hand (a clone, a pull): no store write trusted it.
  const file = join(r.stateDir, 'profile.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.gates[0].timeoutS = 32;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'gates changed by hand');
  const ids = [r.task('feat/a', 'a.test.mjs'), r.task('feat/b', 'b.test.mjs')];
  const tip = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.deepEqual([res.code, res.env.errors.map((e) => e.code)], [7, ['gates-untrusted']], JSON.stringify(res.env.errors));
  assert.equal(r.runs(), 0, 'no gate ran');
  assert.equal(r.git('rev-parse', 'HEAD'), tip, 'the target did not move');
  for (const id of ids) assert.equal(merges(r, id).length, 0, id);
  assert.equal(r.git('branch', '--list', `${names.codename}/batch-*`), '', 'no integration branch was created');
  assert.equal(r.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no integration worktree was created');
});
