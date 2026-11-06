// `close <id…>` (T-MG-178): one call runs the steps still due for the task's state, in order — verify, task done,
// task merge, commit — and stops at the first failing step with its exit code. Driven through the launcher in a
// throwaway repository as the orchestrator runs it: the task is started in its own worktree (task start), the agent
// stores its own report and review from that worktree (report --from, review record --from), the orchestrator closes
// the task from the main checkout.
// Children get a throwaway HOME, git config and environment (tests/helpers/isolated-env.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const BIN = join(pluginDir, 'bin', names.bin);

const CALC = 'export const add = (a, b) => a + b;\n';
const CALC2 = `${CALC}export const subtract = (a, b) => a - b;\n`;
const HEAD = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, subtract } from './calc.mjs';\n";
const ADDS = "test('adds', () => assert.equal(add(1, 2), 3));\n";
const SUBTRACTS = "test('subtracts', () => assert.equal(subtract(3, 2), 1));\n";
const REPORT = '---\nred: {"command": "npm test", "exit": 1, "excerpt": "not ok 2 - subtracts"}\ngreen: {"command": "npm test", "exit": 0, "excerpt": "# pass 2"}\n---\n\n# Report\n\nStatus: DONE\n';
const REVIEW = { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] };

function project(t) {
  const iso = isolatedEnv({ gitConfig: '[init]\n\tdefaultBranch = main\n[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'close-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  const { env } = iso;
  const git = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (base, rel, text) => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), text); };
  const cli = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, '--json', '--yes'], { cwd, env, encoding: 'utf8', timeout: 240000 });
    let envelope = null;
    try { envelope = JSON.parse(r.stdout); } catch { /* reported below */ }
    return { code: r.status, env: envelope, out: `step "${args.join(' ')}": exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${String(r.stderr ?? '').slice(-400)}` };
  };
  const ok = (res) => { assert.equal(res.code, 0, res.out); return res.env; };
  const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
  const task = (id) => JSON.parse(readFileSync(join(dir, names.stateDir, 'tasks', id, 'task.json'), 'utf8'));

  git(dir, 'init', '-q');
  write(dir, 'package.json', `${JSON.stringify({ name: 'calc', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  write(dir, 'calc.mjs', CALC);
  write(dir, 'calc.test.mjs', HEAD.replace(', subtract', '') + ADDS);
  commit(dir, 'calc');
  ok(cli(dir, 'init'));
  ok(cli(dir, 'profile', 'observe'));
  const pin = ok(cli(dir, 'decide', '--title', 'Pin the initial test baseline', '--why', 'Verify compares every task with the baseline on main.', '--cost', 'A wrong baseline hides a removed test.', '--kind', 'gate-change'));
  ok(cli(dir, 'baseline', 'pin', '--decision', pin.data.id));
  commit(dir, 'activate, observe, pin the baseline');

  // A task started in its own worktree and implemented there; `good` false leaves its new test failing. The agent
  // stores its report and the reviewer its approved review from the worktree; the state stays uncommitted on main.
  const implement = ({ good = true, file = 'calc' } = {}) => {
    const id = ok(cli(dir, 'task', 'new', `Add subtract in ${file}`)).data.id;
    commit(dir, `${id}: new`);
    const started = ok(cli(dir, 'task', 'start', id));
    const wt = started.data.worktree;
    ok(cli(dir, 'task', 'set', id, 'dispatched', '--executor', 'claude:implementer', '--base', started.data.base));
    ok(cli(dir, 'route', id, '--paths', `${file}.mjs,${file}.test.mjs`, '--loc', '4'));
    write(wt, `${file}.mjs`, good ? CALC2 : CALC);
    write(wt, `${file}.test.mjs`, HEAD.replace('./calc.mjs', `./${file}.mjs`) + ADDS + SUBTRACTS);
    commit(wt, `${id}: subtract`);
    const reportFile = join(iso.base, `${id}-report.md`);
    writeFileSync(reportFile, REPORT);
    ok(cli(wt, 'report', id, '--from', reportFile));
    const reviewFile = join(iso.base, `${id}-review.json`);
    writeFileSync(reviewFile, JSON.stringify({ ...REVIEW, head: git(wt, 'rev-parse', 'HEAD') })); // B-MG-17: a review binds the commit it read
    ok(cli(wt, 'task', 'set', id, 'dispatched', '--executor', 'claude:reviewer', '--base', started.data.base));
    ok(cli(wt, 'review', 'record', id, '--from', reviewFile));
    return { id, wt, branch: started.data.branch };
  };
  return { dir, git, cli, ok, commit, task, implement };
}

const stepsOf = (envelope) => envelope.data.steps.map((s) => s.step);

test('close on an approved task runs verify → done → merge → commit in one call, from the main checkout', { timeout: 600000 }, (t) => {
  const p = project(t);
  const { id, branch } = p.implement();
  const tip = p.git(p.dir, 'rev-parse', 'HEAD');
  const c = p.ok(p.cli(p.dir, 'close', id));
  assert.deepEqual(stepsOf(c), ['verify', 'done', 'merge', 'commit']);
  assert.ok(c.data.steps.every((s) => s.code === 0), JSON.stringify(c.data.steps.map((s) => [s.step, s.code])));
  const doc = p.task(id);
  assert.equal(doc.status, 'done');
  assert.ok(doc.mergedAt, 'the merge is recorded');
  // the merge commit, then the state commit on top of it; nothing left uncommitted
  assert.deepEqual(p.git(p.dir, 'rev-list', '--parents', '-n', '1', 'HEAD~1').split(' ').slice(1), [tip, p.git(p.dir, 'rev-parse', branch)]);
  assert.match(p.git(p.dir, 'log', '-1', '--format=%s'), new RegExp(`^chore\\(${names.bin}\\): .*${id}`));
  assert.equal(p.git(p.dir, 'status', '--porcelain'), '');
  // a second close has nothing due: no verify, no done, no merge
  const again = p.ok(p.cli(p.dir, 'close', id));
  assert.deepEqual(stepsOf(again), ['commit']);
});

test('close stops at a failing verify with exit 1, names the step and the next command, and leaves the task un-done', { timeout: 600000 }, (t) => {
  const p = project(t);
  const { id } = p.implement({ good: false });
  const tip = p.git(p.dir, 'rev-parse', 'HEAD');
  const c = p.cli(p.dir, 'close', id);
  assert.equal(c.code, 1, c.out);
  assert.deepEqual(stepsOf(c.env), ['verify']);
  assert.equal(c.env.data.stoppedAt, 'verify');
  assert.match(c.env.errors[0].message, new RegExp(`${id}: close stopped at verify \\(exit 1\\).*next: ${names.bin} close ${id}`));
  assert.notEqual(p.task(id).status, 'done');
  assert.equal(p.task(id).mergedAt, undefined);
  assert.equal(p.git(p.dir, 'rev-parse', 'HEAD'), tip, 'nothing merged or committed');
});

test('close on a task already done only merges (and commits the merge record)', { timeout: 600000 }, (t) => {
  const p = project(t);
  const { id } = p.implement();
  p.ok(p.cli(p.dir, 'verify', id));
  p.ok(p.cli(p.dir, 'task', 'done', id));
  const c = p.ok(p.cli(p.dir, 'close', id));
  assert.deepEqual(stepsOf(c), ['merge', 'commit']);
  assert.ok(p.task(id).mergedAt);
  assert.equal(p.git(p.dir, 'status', '--porcelain'), '');
});

test('close <id…> closes several tasks as one batch: one merge step with one gate run', { timeout: 600000 }, (t) => {
  const p = project(t);
  const a = p.implement({ file: 'calc' });
  const b = p.implement({ file: 'other' });
  const c = p.ok(p.cli(p.dir, 'close', a.id, b.id));
  assert.deepEqual(stepsOf(c), ['verify', 'done', 'verify', 'done', 'merge', 'commit']);
  const merge = c.data.steps.find((s) => s.step === 'merge');
  assert.deepEqual(merge.tasks, [a.id, b.id]);
  assert.equal(merge.data.gateRuns, 1);
  for (const id of [a.id, b.id]) assert.ok(p.task(id).mergedAt, `${id} merged`);
  assert.equal(p.git(p.dir, 'status', '--porcelain'), '');
});

// Fix round 1 (F2): the envelope clips a message to LIMITS.message; a long step error must not cut off the next command.
test('a stop line keeps the step and the whole next command within the message limit, whatever the step error', async () => {
  const { stopMessage } = await import(join(pluginDir, 'lib', 'cli', 'close.mjs'));
  const { LIMITS, normalizeError } = await import(join(pluginDir, 'lib', 'cli', 'envelope.mjs'));
  const ids = ['T-AB-1', 'T-AB-2'];
  const next = `next: ${names.bin} close T-AB-1 T-AB-2`;
  for (const why of ['x'.repeat(260), 'y'.repeat(5000), 'short cause', undefined]) {
    const message = normalizeError({ code: 'close-stopped', message: stopMessage({ names, ids, tasks: ids, step: 'verify', code: 1, why }) }).message;
    assert.ok(message.length <= LIMITS.message, `${message.length}`);
    assert.ok(message.startsWith('T-AB-1, T-AB-2: close stopped at verify (exit 1)'), message);
    assert.ok(message.endsWith(`; ${next}`), message);
    if (why === 'short cause') assert.ok(message.includes(': short cause;'), message);
  }
});

// Fix round 2 (F2 for batches): with many IDs the task list and the retry command are bounded too; the retry command is
// never cut mid-word, and the full ID list stays in --json data.tasks.
test('a batch stop line with 15 IDs fits the message limit and ends with a whole retry command', async () => {
  const { stopMessage } = await import(join(pluginDir, 'lib', 'cli', 'close.mjs'));
  const { LIMITS, normalizeError } = await import(join(pluginDir, 'lib', 'cli', 'envelope.mjs'));
  const ids = Array.from({ length: 15 }, (_, k) => `T-MG-${178 + k}`);
  for (const why of ['failed', 'z'.repeat(400)]) {
    const raw = stopMessage({ names, ids, tasks: ids, step: 'merge', code: 1, why });
    const message = normalizeError({ code: 'close-stopped', message: raw }).message;
    assert.equal(message, raw, `not clipped by the envelope (${raw.length} chars)`);
    assert.ok(message.length <= LIMITS.message, `${message.length}`);
    assert.ok(message.startsWith('15 tasks: close stopped at merge (exit 1)'), message);
    const next = /; next: (\S+ close(?: T-MG-\d+)+) … \(\+(\d+) more; all \d+ in --json data\.tasks\)$/.exec(message);
    assert.ok(next, message);
    assert.ok(next[1].startsWith(`${names.bin} close T-MG-178 T-MG-179`), next[1]);
    assert.equal(next[1].split(' ').length - 2 + Number(next[2]), 15, 'shown IDs plus the rest are all 15');
    if (why === 'failed') assert.ok(message.includes(': failed;'), message);
  }
});
