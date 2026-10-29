// T-MG-80 slice D: a task merged by hand (done, a recorded branch, no `merged` event, its tip an ancestor of the target
// in the main checkout) is reported by status, tick and doctor; the guard blocks a plain `git merge task/T-…` on the target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const state = await lib('state/index.mjs');
const loop = await lib('loop/index.mjs');
const BIN = names.bin;
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
async function cli(args, { cwd, env, json = false }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout };
}

// Tasks T-TU-1 (merged by hand), T-TU-2 (merged by hand, with a merged event), T-TU-3 (done, branch not merged).
async function fixture(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'mdetect-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env };
  const run = async (args) => { const r = await cli([...args, '--yes'], p); assert.equal(r.code, 0, args.join(' ')); };
  await run(['init']);
  for (const title of ['one', 'two', 'three']) await run(['task', 'new', title]);
  const branch = (n, merge) => {
    git(repo, env, ['switch', '-q', '-c', `task/T-TU-${n}`, 'main']);
    git(repo, env, ['commit', '-q', '--allow-empty', '-m', `work ${n}`]);
    git(repo, env, ['switch', '-q', 'main']);
    if (merge) git(repo, env, ['merge', '-q', '--no-ff', '-m', `merge ${n}`, `task/T-TU-${n}`]);
  };
  branch(1, true); branch(2, true); branch(3, false);
  const store = state.open(join(repo, names.stateDir), { names, kinds: state.KINDS });
  for (const n of [1, 2, 3]) {
    store.update('task', `T-TU-${n}`, (cur) => ({ ...cur, status: 'done', branch: `task/T-TU-${n}` }));
  }
  store.update('task', 'T-TU-2', (cur) => ({ ...cur, events: [...cur.events, { at: new Date().toISOString(), by: 'x', event: 'merged', data: { commit: 'c', target: 'main', batch: null, adopted: false, verify: null } }] }));
  return { ...p, env, git: (args, cwd = repo) => git(cwd, env, args) };
}

const STEP = (id) => `${id}  done  merged outside landfall → ${BIN} task merge --adopt ${id}`;

test('status lists a done task merged by hand with the adopt command, and counts it in --json; a merged event or an unmerged branch does not', async (t) => {
  const p = await fixture(t);
  const r = await cli([], p);
  assert.match(r.out, new RegExp(`^  ${STEP('T-TU-1').replace(/[→`]/g, '.')}`, 'm'), r.out);
  assert.doesNotMatch(r.out, /T-TU-2 .*merged outside landfall/);
  assert.doesNotMatch(r.out, /T-TU-3 .*merged outside landfall/);
  const j = await cli([], { ...p, json: true });
  assert.deepEqual(j.out.data.outsideMerges, ['T-TU-1']);
});

test('run from inside a task worktree nothing is falsely flagged', async (t) => {
  const p = await fixture(t);
  const wt = join(p.base, 'wt3');
  p.git(['worktree', 'add', '-q', wt, 'task/T-TU-3']);
  const j = await cli([], { cwd: wt, env: p.env, json: true });
  assert.deepEqual(j.out.data.outsideMerges, ['T-TU-1'], 'T-TU-3 is its own HEAD there, but not merged into the target');
});

test('tick has an ACTION step per outside merge', async (t) => {
  const p = await fixture(t);
  const where = state.resolve({ cwd: p.cwd, env: p.env, names });
  const store = state.open(where.dir, { names, kinds: state.KINDS });
  const tasks = store.list('task').map((id) => store.read('task', id));
  assert.deepEqual(loop.outsideMerges({ where, env: p.env, tasks }), ['T-TU-1']);
  const table = loop.nextSteps({ tasks: tasks.filter((x) => x.id === 'T-TU-1'),caps: loop.DEFAULT_CAPS, now: Date.now(), bin: BIN, outside: ['T-TU-1'] });
  const s = table.steps.find((x) => x.task === 'T-TU-1');
  assert.equal(s.kind, 'action');
  assert.match(s.step, new RegExp(`${BIN} task merge --adopt T-TU-1`));
  assert.equal(table.outcome, 'action');
});

test('doctor has one row with the count', async (t) => {
  const p = await fixture(t);
  const j = await cli(['doctor'], { ...p, json: true });
  const row = j.out.data.rows.find((x) => x.id === 'outside-merges');
  assert.ok(row, 'a row');
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /^1 /);
  assert.match(row.hint, /task merge --adopt/);
});

// ---- the guard: a plain `git merge task/T-…` on the target (T-MG-80 A5) ----
const { runHook } = await lib('hooks/registry.mjs');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
function repoOn(branch) {
  const d = mkdtempSync(join(tmpdir(), `mg-${branch.replace('/', '-')}-`));
  spawnSync('git', ['init', '-q', '-b', branch, d]);
  spawnSync('git', ['-C', d, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']);
  return d;
}
const verdict = (dir, command) => {
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const r = runHook('guard-bash', input, { deadline: Infinity, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, shadowLog: () => {}, readProjectMode: () => 'solo' });
  if (r?.code === 2 || r?.status === 2) return { deny: true, reason: String(r.stderr ?? '') };
  const o = r?.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { deny: o?.permissionDecision === 'deny', reason: o?.permissionDecisionReason ?? '' };
};

test('guard: git merge or pull of a task branch on the target is blocked with the batch advice', () => {
  const main = repoOn('main');
  for (const c of ['git merge task/T-MG-80-x', 'git merge --no-ff -m "m" task/T-AB-3', 'git merge origin/task/T-AB-3', 'git pull origin task/T-AB-3', 'git merge refs/heads/task/T-AB-3']) {
    const v = verdict(main, c);
    assert.ok(v.deny, c);
    assert.match(v.reason, /merge task branches with `landfall task merge <ids…>` \(one gate for the batch, recorded in the state\)/, c);
    assert.ok(v.reason.length <= 300, 'reason within 300 characters');
  }
});

test('guard: abort, updating from main, other merges and merges on a task branch stay allowed', () => {
  const main = repoOn('main'); const task = repoOn('task/T-AB-3'); const other = repoOn('feat');
  for (const c of ['git merge --abort', 'git merge origin/main', 'git merge main', 'git merge --no-ff feat/x', 'git pull origin main']) assert.ok(!verdict(main, c).deny, c);
  for (const c of ['git merge origin/main', 'git merge main', 'git merge task/T-AB-4']) assert.ok(!verdict(task, c).deny, `on a task branch: ${c}`);
  assert.ok(verdict(other, 'git merge task/T-AB-3').deny, 'a branch that is not a task branch counts as the target');
});

test('guard: with the current branch undeterminable, a merge of a task branch is blocked', () => {
  const none = mkdtempSync(join(tmpdir(), 'mg-none-'));
  assert.ok(verdict(none, 'git merge task/T-AB-3').deny);
  const detached = repoOn('main');
  spawnSync('git', ['-C', detached, 'checkout', '-q', '--detach']);
  assert.ok(verdict(detached, 'git merge task/T-AB-3').deny);
});
