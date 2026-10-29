// `task start <id> [--slug] [--from] [--path]`: creates the task's worktree and branch with `git worktree add` and
// records them on the task as the state `started` (the status does not move); `brief` then carries both.
// Commands run through the real command table in a throwaway repository and HOME. No plugin name or path here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const { main } = await lib('cli/main.mjs');

const identity = (name, email) => `[user]\n\tname = ${name}\n\temail = ${email}\n`;
const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

// An active repository with one commit and the task T-TU-1 "Cart checkout".
async function active(t) {
  const iso = isolatedEnv({ gitConfig: identity('Test User', 'test@example.com'), prefix: 'task-start-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(dir, 'a.js'), 'export {};\n');
  git(dir, iso.env, ['add', 'a.js']);
  git(dir, iso.env, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  const r = { base: iso.base, dir, cwd: dir, env: iso.env, store: join(dir, names.stateDir) };
  assert.equal((await cli(['init', '--yes'], r)).code, 0);
  r.run = (args) => cli([...args, '--yes'], r);
  r.raw = (id) => readFileSync(join(r.store, 'tasks', id, 'task.json'), 'utf8');
  r.task = (id) => JSON.parse(r.raw(id));
  r.head = () => git(dir, iso.env, ['rev-parse', 'HEAD']).trim();
  const created = await r.run(['task', 'new', 'Cart checkout']);
  assert.equal(created.code, 0, show(created));
  assert.equal(created.out.data.id, 'T-TU-1');
  // task start refuses while the in-repo state is uncommitted (T-MG-95): the first run commits it
  assert.equal((await r.run(['commit'])).code, 0);
  return r;
}

const errCode = (r) => r.out.errors[0].code;

test('task start creates the worktree and branch and records them; the status stays', async (t) => {
  const r = await active(t);
  const res = await r.run(['task', 'start', 'T-TU-1']);
  assert.equal(res.code, 0, show(res));
  const wt = join(r.base, 'repo-wt', 'T-TU-1');
  const branch = 'task/T-TU-1-cart-checkout';
  const list = git(r.dir, r.env, ['worktree', 'list', '--porcelain']);
  assert.ok(list.includes(wt), list);
  assert.ok(list.includes(`branch refs/heads/${branch}`), list);
  const task = r.task('T-TU-1');
  assert.equal(task.branch, branch);
  assert.equal(task.base, r.head());
  assert.equal(task.base.length, 40);
  assert.equal(task.status, 'new');
  const last = task.events[task.events.length - 1];
  assert.equal(last.event, 'started');
  assert.equal(last.data.branch, branch);
  assert.equal(last.data.base, r.head());
  assert.ok(last.data.worktree.endsWith(join('repo-wt', 'T-TU-1')), last.data.worktree);
  assert.equal(git(wt, r.env, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), branch);
  assert.equal(res.out.data.branch, branch);
});

test('the brief carries the base and the branch after task start', async (t) => {
  const r = await active(t);
  assert.equal((await r.run(['task', 'start', 'T-TU-1'])).code, 0);
  const routed = await r.run(['route', 'T-TU-1', '--paths', 'a.js', '--loc', '10']);
  assert.equal(routed.code, 0, show(routed));
  const b = await cli(['brief', 'T-TU-1'], { ...r, json: false });
  assert.equal(b.code, 0, b.out);
  assert.ok(b.out.includes(r.head()), 'base sha');
  assert.ok(b.out.includes('task/T-TU-1-cart-checkout'), 'branch');
  assert.ok(!b.out.includes('<base SHA>'));
  assert.ok(!b.out.includes('<branch>'));
});

test('a second start is refused: worktree-exists, then branch-exists; the task is unchanged', async (t) => {
  const r = await active(t);
  assert.equal((await r.run(['task', 'start', 'T-TU-1'])).code, 0);
  const before = r.raw('T-TU-1');
  const again = await r.run(['task', 'start', 'T-TU-1']);
  assert.equal(again.code, 1, show(again));
  assert.equal(errCode(again), 'worktree-exists');
  const other = await r.run(['task', 'start', 'T-TU-1', '--path', join(r.base, 'elsewhere')]);
  assert.equal(other.code, 1, show(other));
  assert.equal(errCode(other), 'branch-exists');
  assert.equal(existsSync(join(r.base, 'elsewhere')), false);
  assert.equal(r.raw('T-TU-1'), before);
});

test('refusals: unknown ref, bad slug, closed task, no consent; help lists the command', async (t) => {
  const r = await active(t);
  const bad = await r.run(['task', 'start', 'T-TU-1', '--from', 'nonexistent']);
  assert.equal(bad.code, 1, show(bad));
  assert.equal(errCode(bad), 'unknown-ref');
  assert.equal(existsSync(join(r.base, 'repo-wt')), false);
  const slug = await r.run(['task', 'start', 'T-TU-1', '--slug', 'Bad Slug']);
  assert.equal(slug.code, 2, show(slug));
  assert.equal(errCode(slug), 'invalid-value');
  const noConsent = await cli(['task', 'start', 'T-TU-1'], r);
  assert.equal(noConsent.code, 7, show(noConsent));
  assert.equal(errCode(noConsent), 'consent-required');
  assert.equal((await r.run(['task', 'set', 'T-TU-1', 'cancelled', '--reason', 'no need'])).code, 0);
  const closed = await r.run(['task', 'start', 'T-TU-1']);
  assert.equal(closed.code, 1, show(closed));
  assert.equal(errCode(closed), 'task-closed');
  const help = await cli(['--help'], { ...r, json: false });
  assert.ok(help.out.includes('task start'), 'help lists task start');
});

test('--path and --slug place the worktree and name the branch', async (t) => {
  const r = await active(t);
  const wt = join(r.base, 'custom', 'here');
  const res = await r.run(['task', 'start', 'T-TU-1', '--path', wt, '--slug', 'fix']);
  assert.equal(res.code, 0, show(res));
  assert.equal(git(wt, r.env, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'task/T-TU-1-fix');
  assert.equal(r.task('T-TU-1').branch, 'task/T-TU-1-fix');
});
