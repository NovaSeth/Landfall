// A passing gate set is run once per tree (T-MG-46): verify of a clean commit whose gates passed before reuses the
// stored runs under local/gate-cache and says so; any change of the tree, an untracked file, another gate command or
// --no-cache runs the gates again; a failing gate set is never stored; task merge stores the merged tree's runs, so
// the verify of the merge commit reuses them. The gate appends to a counter file outside the repository, which
// proves whether it ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolatedEnv } from './helpers/isolated-env.mjs';
import { lib, names } from './helpers/hook-fixture.mjs';

const profile = await lib('profile/index.mjs');
const { main } = await lib('cli/main.mjs');

const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "1 passing"}\n---\n\n# Report\n';
const CALC = "import { test } from 'node:test';\ntest('adds', () => {});\n";

function git(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const show = (r) => JSON.stringify(r.out ?? r).slice(0, 1500);

async function cli(args, { cwd, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, out: JSON.parse(out.join('')) };
}

// A fresh repository with linked state (the tree stays clean), a test gate that counts its runs in a file outside the
// repository, a task based on the first commit, and a linked worktree `wt` on branch feature.
async function fresh(t, { fail = false } = {}) {
  const iso = isolatedEnv({ gitConfig: IDENTITY, prefix: 'gate-cache-' });
  t.after(iso.cleanup);
  const env = iso.env;
  const repo = join(iso.base, 'main');
  const wt = join(iso.base, 'wt');
  const counter = join(iso.base, 'counter');
  mkdirSync(repo);
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  put(join(repo, 'README.md'), '# x\n');
  put(join(repo, 'calc.test.mjs'), CALC);
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'base']);
  const stateDir = join(iso.base, 'control', 'state');
  const p = { env, repo, wt, stateDir, counter };
  p.run = (args, where = 'main') => cli(args, { cwd: where === 'wt' ? wt : repo, env });
  assert.equal((await p.run(['init', '--yes', '--state-dir', stateDir])).code, 0);
  p.gate = (cmd) => profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd, timeoutS: 120, kind: 'test' }] });
  p.gate(`echo run >> ${counter} && node --test${fail ? ' && exit 1' : ''}`);
  p.base = git(repo, env, ['rev-parse', 'HEAD']).trim();
  git(repo, env, ['worktree', 'add', '-q', wt, '-b', 'feature']);
  p.task = async (where = 'main') => {
    const id = (await p.run(['task', 'new', 'Cache', '--yes'], where)).out.data.id;
    assert.equal((await p.run(['task', 'set', id, 'dispatched', '--executor', 'claude', '--base', p.base, '--yes'], where)).code, 0);
    assert.equal((await p.run(['route', id, '--paths', 'README.md', '--loc', '1', '--yes'], where)).code, 0);
    put(join(stateDir, 'tasks', id, 'report.md'), REPORT);
    return id;
  };
  p.commit = (where, rel, text) => {
    const dir = where === 'wt' ? wt : repo;
    put(join(dir, rel), text);
    git(dir, env, ['add', rel]);
    git(dir, env, ['commit', '-q', '-m', `change ${rel}`]);
  };
  p.runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
  return p;
}

const reused = (v) => v.out.data.reusedFrom ?? null;

test('verify twice on the same clean commit: the second reuses the gate runs, reports it and gives the same result', async (t) => {
  const p = await fresh(t);
  const id = await p.task();
  p.commit('main', 'README.md', '# y\n');
  const first = await p.run(['verify', id, '--yes']);
  assert.equal(first.code, 0, show(first));
  assert.equal(reused(first), null, 'the first run runs the gates');
  const n = p.runs();
  assert.ok(n >= 1, 'the gate ran');
  const second = await p.run(['verify', id, '--yes']);
  assert.equal(second.code, 0, show(second));
  assert.equal(p.runs(), n, 'the gate did not run again');
  assert.match(String(reused(second)), /^\d{4}-\d{2}-\d{2}T/, show(second));
  assert.deepEqual(second.out.data.gates, first.out.data.gates, 'the stored gate runs');
  assert.deepEqual(second.out.data.inventory.tests, first.out.data.inventory.tests);
  const text = [];
  await main(['verify', id, '--yes'], { io: { out: (s) => text.push(s), err: () => {}, stdinIsTTY: false, env: p.env, cwd: p.repo, stdin: null } });
  assert.match(text.join(''), /gates: reused from \d{4}-/);
});

test('a tracked change, an untracked file, another gate command or --no-cache runs the gates again', async (t) => {
  const p = await fresh(t);
  const id = await p.task();
  p.commit('main', 'README.md', '# y\n');
  assert.equal((await p.run(['verify', id, '--yes'])).code, 0);
  let n = p.runs();
  const again = async (what) => {
    const v = await p.run(['verify', id, '--yes', ...(what === '--no-cache' ? ['--no-cache'] : [])]);
    assert.equal(v.code, 0, `${what}: ${show(v)}`);
    assert.ok(p.runs() > n, `${what}: the gate ran again`);
    assert.equal(reused(v), null, `${what}: not reused`);
    n = p.runs();
  };
  await again('--no-cache');
  put(join(p.repo, 'README.md'), '# z\n');
  await again('a tracked change');
  git(p.repo, p.env, ['checkout', '--', 'README.md']);
  put(join(p.repo, 'notes.txt'), 'x\n');
  await again('an untracked file');
  // the same tracked content is clean again: reused from the run before the untracked file
  assert.equal(existsSync(join(p.repo, 'notes.txt')), true);
  spawnSync('rm', [join(p.repo, 'notes.txt')]);
  const back = await p.run(['verify', id, '--yes']);
  assert.equal(back.code, 0, show(back));
  assert.equal(p.runs(), n, 'the clean tree reuses');
  p.gate(`echo run >> ${p.counter} && node --test --test-reporter=tap`);
  await again('another gate command');
});

test('a failing gate set is never reused', async (t) => {
  const p = await fresh(t, { fail: true });
  const id = await p.task();
  p.commit('main', 'README.md', '# y\n');
  const first = await p.run(['verify', id, '--yes']);
  assert.equal(first.code, 1, show(first));
  const n = p.runs();
  const second = await p.run(['verify', id, '--yes']);
  assert.equal(second.code, 1, show(second));
  assert.ok(p.runs() > n, 'the failing gate ran again');
  assert.equal(reused(second), null);
  assert.equal(existsSync(join(p.stateDir, 'local', 'gate-cache')), false, 'nothing stored');
});

test('task merge stores the merged tree, so verify of the merge commit reuses it', async (t) => {
  const p = await fresh(t);
  const id = await p.task('wt');
  p.commit('wt', 'README.md', '# y\n');
  const v = await p.run(['verify', id, '--yes'], 'wt');
  assert.equal(v.code, 0, show(v));
  assert.equal((await p.run(['task', 'done', id, '--yes'], 'wt')).code, 0);
  p.commit('main', 'other.md', 'o\n');
  const m = await p.run(['task', 'merge', id, '--branch', 'feature', '--yes']);
  assert.equal(m.code, 0, show(m));
  const n = p.runs();
  const after = await p.run(['verify', id, '--yes']);
  assert.equal(after.code, 0, show(after));
  assert.equal(p.runs(), n, 'verify of the merge commit reuses the merge\'s runs');
  assert.ok(reused(after), show(after));
});
