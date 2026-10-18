// Linked worktrees share the project state of their main checkout (spec §5.1–§5.3, §7.2, §7.6, §7.12, SD-7, SD-36).
// Two roots: the project (the main checkout) anchors the state — the in-repo state directory, the projects.json key,
// activation and decline — and the worktree (the git top level of the current directory) holds the code — the gates
// run there, its HEAD is verified, its diff against the task base is classified and its files are scanned. From a
// worktree every command and hook sees the project's state; writes land there and the worktree tree stays clean. A
// checked-out copy of a committed in-repo state directory inside a worktree is no state: the edit hook and the Bash
// guard protect it like the state directory itself.
// Commands run through the real command table (lib/cli/main.mjs) and the hooks in process, in a throwaway HOME.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';
import { hook, lib, loopDoc, names, writeLoop } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const { main } = await lib('cli/main.mjs');

const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const ME = 'TU';
const T1 = `T-${ME}-1`;
const T2 = `T-${ME}-2`;
const TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\n";
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "1 passing"}\n---\n\n# Report\n';
const GATES = [{ name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }, { name: 'where', cmd: 'pwd', timeoutS: 30, kind: 'lint' }];

function git(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const head = (cwd, env) => git(cwd, env, ['rev-parse', 'HEAD']).trim();
const porcelain = (cwd, env) => git(cwd, env, ['status', '--porcelain', '--untracked-files=all']);
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

async function cli(args, { cwd, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  const text = out.join('');
  return { code, out: JSON.parse(text), stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r).slice(0, 1500);
const codes = (r) => r.out.errors.map((e) => e.code);

// A main checkout with one commit, optionally activated (in-repo or linked state, the state committed or not), and a
// linked worktree next to it on its own branch. run(args, where) runs a command in the main checkout or the worktree.
async function project(t, { activate = true, linked = false, commitState = false, files = {} } = {}) {
  const iso = isolatedEnv({ gitConfig: IDENTITY, prefix: 'state-worktrees-' });
  t.after(iso.cleanup);
  const env = iso.env;
  const repo = join(iso.base, 'main');
  const wt = join(iso.base, 'wt');
  const external = join(iso.base, 'control', 'state');
  mkdirSync(repo);
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  for (const [rel, text] of Object.entries({ 'README.md': '# x\n', ...files })) put(join(repo, rel), text);
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'base']);
  const p = { env, repo, wt, base: iso.base, dataDir: state.machineDataDir(names, env), stateDir: linked ? external : join(repo, names.stateDir) };
  p.run = (args, where = 'main') => cli(args, { cwd: where === 'wt' ? wt : where === 'main' ? repo : where, env });
  p.task = (id) => JSON.parse(readFileSync(join(p.stateDir, 'tasks', id, 'task.json'), 'utf8'));
  if (activate) {
    const init = await p.run(['init', '--yes', ...(linked ? ['--state-dir', external] : [])]);
    assert.equal(init.code, 0, show(init));
    const first = await p.run(['task', 'new', 'First task', '--yes']);
    assert.equal(first.out.data.id, T1, show(first));
  }
  if (commitState) {
    git(repo, env, ['add', '-A']);
    git(repo, env, ['commit', '-q', '-m', 'state']);
  }
  git(repo, env, ['worktree', 'add', '-q', wt, '-b', 'feature']);
  return p;
}

// ---- 1. in-repo state ----

test('in-repo state: a linked worktree lists and shows the tasks of the main checkout (the repro of T-MG-1)', async (t) => {
  const p = await project(t);
  const list = await p.run(['task', 'list'], 'wt');
  assert.equal(list.code, 0, show(list));
  assert.equal(list.out.data.active, true, show(list));
  assert.deepEqual(list.out.data.tasks.map((x) => x.id), [T1]);
  const one = await p.run(['task', 'show', T1], 'wt');
  assert.equal(one.code, 0, show(one));
  assert.equal(one.out.data.task.title, 'First task');
});

test('in-repo state: task set from a worktree writes the project\'s task file; the worktree tree stays clean', async (t) => {
  const p = await project(t, { commitState: true });
  // a task created in the main checkout after the worktree was added: only the project's state has it
  assert.equal((await p.run(['task', 'new', 'Second task', '--yes'])).code, 0);
  const copy = join(p.wt, names.stateDir, 'tasks', T1, 'task.json');
  const copyBefore = readFileSync(copy, 'utf8');
  const list = await p.run(['task', 'list'], 'wt');
  assert.deepEqual(list.out.data.tasks.map((x) => x.id), [T1, T2], show(list));
  const set = await p.run(['task', 'set', T1, 'status-request', '--note', 'from the worktree', '--yes'], 'wt');
  assert.equal(set.code, 0, show(set));
  assert.deepEqual(p.task(T1).events.at(-1).data, { note: 'from the worktree' }, 'written to the project state');
  assert.equal(readFileSync(copy, 'utf8'), copyBefore, 'the checked-out copy is not state');
  assert.equal(porcelain(p.wt, p.env), '', 'the worktree tree stays clean');
});

// ---- 2. linked state ----

test('linked state: a worktree finds the link of its main checkout; reads leave projects.json as it was', async (t) => {
  const p = await project(t, { linked: true });
  const projects = join(p.dataDir, 'projects.json');
  const before = readFileSync(projects, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(before).projects), [realpathSync(p.repo)]);
  const list = await p.run(['task', 'list'], 'wt');
  assert.equal(list.out.data.active, true, show(list));
  assert.deepEqual(list.out.data.tasks.map((x) => x.id), [T1]);
  assert.equal((await p.run(['task', 'show', T1], 'wt')).code, 0);
  assert.equal(readFileSync(projects, 'utf8'), before, 'reads change nothing in machine data');
  const set = await p.run(['task', 'set', T1, 'blocked', '--reason', 'waits for review', '--yes'], 'wt');
  assert.equal(set.code, 0, show(set));
  assert.equal(p.task(T1).status, 'blocked', 'written to the linked state directory');
  assert.equal(readFileSync(projects, 'utf8'), before);
  assert.equal(porcelain(p.wt, p.env), '');
  assert.equal(porcelain(p.repo, p.env), '', 'a linked state directory keeps the main checkout clean too');
});

// ---- 3, 4. verify, task done and route in a worktree ----

// The project of a verify run: committed in-repo state with the gates, the task dispatched with the worktree's base
// and classified from the worktree, its report in the project's state.
async function verifiable(t) {
  const p = await project(t, { activate: true, files: { 'calc.test.mjs': TESTS } });
  profile.openStore(p.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: GATES });
  git(p.repo, p.env, ['add', '-A']);
  git(p.repo, p.env, ['commit', '-q', '-m', 'state']);
  git(p.wt, p.env, ['merge', '-q', '--ff-only', 'main']);
  p.base = head(p.wt, p.env);
  assert.equal((await p.run(['task', 'set', T1, 'dispatched', '--executor', 'claude', '--base', p.base, '--yes'], 'wt')).code, 0);
  put(join(p.stateDir, 'tasks', T1, 'report.md'), REPORT);
  return p;
}

test('route from a worktree: absolute paths of the worktree are its own; the class is written to the project state', async (t) => {
  const p = await verifiable(t);
  const r = await p.run(['route', T1, '--paths', `${join(p.wt, 'db', 'migrations', '1.sql')},docs/a.md`, '--loc', '4', '--yes'], 'wt');
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.class, 'critical', show(r));
  assert.deepEqual(r.out.data.reasons.filter((x) => x.path).map((x) => x.path), ['db/migrations/1.sql'], 'a worktree path, repository-relative');
  assert.equal(p.task(T1).class, 'critical', 'the project task file holds the class');
  assert.equal(porcelain(p.wt, p.env), '');
});

test('verify from a worktree runs the gates there and records its HEAD; task done accepts it and refuses after a new commit', async (t) => {
  const p = await verifiable(t);
  assert.equal((await p.run(['route', T1, '--paths', 'lib.mjs', '--loc', '1', '--yes'], 'wt')).code, 0);
  put(join(p.wt, 'lib.mjs'), 'export const one = 1;\n');
  git(p.wt, p.env, ['add', '-A']);
  git(p.wt, p.env, ['commit', '-q', '-m', 'work']);
  const work = head(p.wt, p.env);
  const v = await p.run(['verify', T1, '--yes'], 'wt');
  assert.equal(v.code, 0, show(v));
  const where = v.out.data.output.find((o) => o.name === 'where').lines;
  assert.deepEqual(where, [realpathSync(p.wt)], 'the gate ran in the worktree');
  const doc = JSON.parse(readFileSync(join(p.stateDir, 'tasks', T1, 'verify.json'), 'utf8'));
  assert.deepEqual([doc.result, doc.head], ['pass', work], 'the project state records the worktree HEAD');
  assert.notEqual(work, head(p.repo, p.env));
  assert.equal(porcelain(p.wt, p.env), '', 'verify writes nothing into the worktree');

  // a new commit in the worktree makes that verify stale
  put(join(p.wt, 'lib.mjs'), 'export const one = 2;\n');
  git(p.wt, p.env, ['commit', '-q', '-am', 'more work']);
  const stale = await p.run(['task', 'done', T1, '--yes'], 'wt');
  assert.equal(stale.code, 1, show(stale));
  assert.deepEqual(codes(stale), ['verify-stale']);
  assert.equal((await p.run(['verify', T1, '--yes'], 'wt')).code, 0);
  const done = await p.run(['task', 'done', T1, '--yes'], 'wt');
  assert.equal(done.code, 0, show(done));
  assert.equal(done.out.data.head, head(p.wt, p.env));
  assert.equal(p.task(T1).status, 'done');
});

test('verify from a worktree re-classifies the worktree\'s change against the task base', async (t) => {
  const p = await verifiable(t);
  assert.equal((await p.run(['route', T1, '--paths', 'lib.mjs', '--loc', '1', '--yes'], 'wt')).code, 0);
  for (const name of ['a', 'b', 'c']) put(join(p.wt, `${name}.mjs`), `export const ${name} = 1;\n`);
  git(p.wt, p.env, ['add', '-A']);
  git(p.wt, p.env, ['commit', '-q', '-m', 'three files']);
  const v = await p.run(['verify', T1, '--yes'], 'wt');
  assert.equal(v.code, 1, show(v));
  assert.deepEqual([v.out.data.route.declared, v.out.data.route.actual, v.out.data.route.escalated], ['trivial', 'standard', true], show(v));
  assert.equal(p.task(T1).class, 'standard', 'the ratchet writes the project task');
});

// ---- profile, decisions: scans of the worktree ----

test('profile observe and decisions from a worktree scan the worktree\'s files', async (t) => {
  const p = await project(t);
  put(join(p.wt, 'src', 'only-here.mjs'), '// see D-TU-9\nexport const x = 1;\n');
  git(p.wt, p.env, ['add', '-A']);
  git(p.wt, p.env, ['commit', '-q', '-m', 'cites an unknown decision']);
  const o = await p.run(['profile', 'observe', '--yes'], 'wt');
  assert.equal(o.code, 0, show(o));
  assert.equal(o.out.data.head, head(p.wt, p.env), 'observed at the worktree HEAD');
  assert.equal(o.out.data.files, 2, 'README.md and the worktree-only file');
  const c = await p.run(['decisions', 'check'], 'wt');
  assert.ok(c.out.errors.some((e) => e.code === 'unknown-decision' && e.message.startsWith('src/only-here.mjs:1')), show(c));
  const d = await p.run(['decide', '--title', 'Keep x', '--why', 'One reason.', '--cost', 'low', '--scope', 'src/**', '--yes'], 'wt');
  assert.equal(d.code, 0, show(d));
  const record = join(p.stateDir, 'decisions', `D-${ME}-1.md`);
  assert.equal(resolve(p.wt, d.out.data.file), record, 'the record path, as seen from the worktree');
  const f = await p.run(['decisions', 'find', '--path', join(p.wt, 'src', 'only-here.mjs')], 'wt');
  assert.equal(f.code, 0, show(f));
  assert.deepEqual(f.out.data.decisions.map((x) => [x.id, x.file]), [[`D-${ME}-1`, record]], 'scoped to the worktree file; shown by its path');
  const ctx = hook('decisions-context', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: join(p.wt, 'src', 'only-here.mjs'), old_string: 'x = 1', new_string: 'x = 2' }, cwd: p.wt }, { env: p.env });
  assert.ok(ctx.context?.includes(`D-${ME}-1`), `the decision scoped to src/** reaches an edit in the worktree: ${ctx.stdout}`);
});

// ---- 6. activation from a worktree ----

test('init from a worktree activates the project: the state goes under the main checkout', async (t) => {
  const p = await project(t, { activate: false });
  const r = await p.run(['init', '--yes'], 'wt');
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.dir, join(realpathSync(p.repo), names.stateDir));
  assert.ok(existsSync(join(p.repo, names.stateDir, 'state.json')));
  assert.equal(existsSync(join(p.wt, names.stateDir)), false);
  assert.equal(porcelain(p.wt, p.env), '');
  assert.equal((await p.run(['task', 'list'])).out.data.active, true, 'the main checkout is active');
});

test('decline from a worktree declines the project (its main checkout\'s real path in projects.json)', async (t) => {
  const p = await project(t, { activate: false });
  const r = await p.run(['decline', '--yes'], 'wt');
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.repo, realpathSync(p.repo));
  assert.deepEqual(Object.keys(state.readProjects(p.dataDir, names).projects), [realpathSync(p.repo)]);
  assert.equal(state.resolve({ cwd: p.repo, env: p.env, names }).declined, true);
  assert.equal(state.resolve({ cwd: p.wt, env: p.env, names }).declined, true);
});

// ---- 7. hooks in a worktree ----

const toolCall = (p, tool_name, tool_input, extra = {}) => ({ session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: p.wt, ...extra });

test('hooks from a worktree: session-start and subagent-start see the active project', async (t) => {
  const p = await project(t);
  const s = hook('session-start', { session_id: 's', hook_event_name: 'SessionStart', source: 'startup', cwd: p.wt }, { env: p.env });
  assert.ok(s.context, 'the session context is injected');
  assert.match(s.context, new RegExp(`^- ${T1} new: First task`, 'm'));
  assert.ok(s.context.includes(join(realpathSync(p.repo), names.stateDir)), 'the state is named by its path, not by the worktree copy');
  const a = hook('subagent-start', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: `${names.plugin}:implementer`, cwd: p.wt }, { env: p.env });
  assert.notEqual(a.stdout, '', 'the subagent context is injected');
});

test('edit hook from a worktree: the project state file and the worktree copy of the state directory are protected', async (t) => {
  const p = await project(t);
  const write = (file) => hook('decisions-context', toolCall(p, 'Write', { file_path: file, content: '{}\n' }), { env: p.env });
  const own = write(join(p.stateDir, 'tasks', T1, 'task.json'));
  assert.equal(own.decision, 'deny', 'the project state file');
  assert.match(own.reason, /^FLW-7: blocked a direct edit of /);
  for (const rel of [`tasks/${T1}/task.json`, 'state.json']) {
    const copy = write(join(p.wt, names.stateDir, rel));
    assert.equal(copy.decision, 'deny', `the worktree copy: ${rel}`);
    assert.ok(copy.reason.includes(`${names.stateDir}/${rel}`), copy.reason);
  }
  assert.equal(hook('decisions-context', toolCall(p, 'Write', { file_path: join(names.stateDir, 'state.json'), content: '{}' }), { env: p.env }).decision, 'deny', 'relative to the worktree cwd');
  assert.equal(write(join(p.wt, 'src', 'a.mjs')).decision, 'allow', 'code in the worktree');
  assert.equal(write(join(p.stateDir, 'tasks', T1, 'report.md')).decision, 'allow', 'an unowned state file');
  // an executor worktree under local/worktrees/ of the state directory (spec §5.2): its own copy is guarded
  const exec = join(p.stateDir, 'local', 'worktrees', T1);
  git(p.repo, p.env, ['worktree', 'add', '-q', exec, '-b', 'exec']);
  const inExec = hook('decisions-context', toolCall(p, 'Write', { file_path: join(exec, names.stateDir, 'tasks', T1, 'task.json'), content: '{}\n' }, { cwd: exec }), { env: p.env });
  assert.equal(inExec.decision, 'deny', 'the copy of an executor worktree');
  assert.equal(hook('decisions-context', toolCall(p, 'Write', { file_path: join(exec, 'src', 'a.mjs'), content: 'x\n' }, { cwd: exec }), { env: p.env }).decision, 'allow', 'its code');
});

test('Bash guard from a worktree: a write into the worktree copy of the state directory is blocked, a read passes', async (t) => {
  const p = await project(t);
  const bash = (command) => hook('guard-bash', toolCall(p, 'Bash', { command }), { env: p.env });
  const v = bash(`echo '{}' > ${names.stateDir}/tasks/${T1}/task.json`);
  assert.equal(v.decision, 'deny', v.stdout);
  assert.equal(bash(`echo '{}' > ${join(p.stateDir, 'tasks', T1, 'task.json')}`).decision, 'deny', 'the project state file');
  assert.equal(bash(`cat ${names.stateDir}/state.json`).decision, 'allow', 'a read shape');
  assert.equal(bash('ls src').decision, 'allow');
  const exec = join(p.stateDir, 'local', 'worktrees', T1);
  git(p.repo, p.env, ['worktree', 'add', '-q', exec, '-b', 'exec']);
  const inExec = hook('guard-bash', toolCall(p, 'Bash', { command: `echo '{}' > ${names.stateDir}/tasks/${T1}/task.json` }, { cwd: exec }), { env: p.env });
  assert.equal(inExec.decision, 'deny', 'the copy of an executor worktree under local/worktrees/');
  assert.equal(hook('guard-bash', toolCall(p, 'Bash', { command: 'echo x > src/a.mjs' }, { cwd: exec }), { env: p.env }).decision, 'allow', 'its code');
});

test('loop hooks from a worktree: the project loop is seen (an ended loop takes no wakeup); --plan is a plan of the worktree', async (t) => {
  const p = await project(t);
  const wake = (prompt) => hook('guard-wakeup', toolCall(p, 'ScheduleWakeup', { delaySeconds: 1200, prompt }), { env: p.env });
  const tick = `Run \`${names.bin} tick\` and do the listed steps.`;
  put(join(p.wt, 'docs', 'plans', 'wt.md'), '# plan\n');
  const ticked = await p.run(['tick', '--plan', 'docs/plans/wt.md'], 'wt');
  assert.ok(ticked.code !== 2 && !codes(ticked).includes('plan-missing'), `tick reads the plan of the worktree: ${show(ticked)}`);
  writeLoop(p.stateDir, loopDoc(null));
  assert.equal(wake(`Run \`${names.bin} tick --plan docs/plans/wt.md\` and do the listed steps.`).decision, 'allow', 'a plan of the worktree');
  writeLoop(p.stateDir, loopDoc('DONE'));
  const v = wake(tick);
  assert.equal(v.decision, 'deny', 'the loop of the project ended');
  assert.match(v.reason, /^FLW-5: blocked the wakeup: the .* loop ended \(DONE\)/);
});
