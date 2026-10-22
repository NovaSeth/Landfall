// Task commands (spec §5.1, §8.2, SD-8, SD-9, GC3, SC18): `task new|list|show|set`, the successor of the 1.x
// task.sh. Every 1.x task.sh case has an English equivalent here; the test names say which (`1.x: …`):
//   task.sh <id> dispatched --exec <e> --base <sha> [--pas <p>]  → task set <id> dispatched --executor <e> --base <sha> [--lane <l>]
//   task.sh <id> blocked "<what unblocks>"                        → task set <id> blocked --reason <t>
//   task.sh <id> cancelled "<reason>"                             → task set <id> cancelled --reason <t>
//   task.sh <id> self-verified [--round k | r<k>] [text]          → task set <id> self-verified [--round <k>] [--note <t>]
//   task.sh <id> status-request [text]                            → task set <id> status-request [--note <t>]
//   task.sh <id> implementer DONE|…|BLOCKED [text]                → task set <id> implementer --report done|…|blocked [--note <t>]
//   task.sh <id> fix-round --round k --addressed a --open o       → task set <id> fix-round --round <k> --addressed <n> --open <n>
//   task.sh <id> complete "<text>"                                → refused here: done only after a passing verify (GC3)
//   task.sh gate <area> · task.sh release                         → task new <title> --kind gate [--lane <area>]
// An entry's author and time are the event's `by` (the developer's handle) and `at`.
// Commands run through the real command table (lib/cli/main.mjs) in a throwaway repository and HOME; the
// concurrency cases through the launcher in child processes.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');

const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const identity = (name, email) => `[user]\n\tname = ${name}\n\temail = ${email}\n`;
const ME = 'TU'; // handle of Test User

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

// An active repository (init done by Test User, handle TU); `as(name, email)` is another developer on the machine.
async function active(t) {
  const iso = isolatedEnv({ gitConfig: identity('Test User', 'test@example.com'), prefix: 'task-commands-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  const r = { base: iso.base, dir, cwd: dir, env: iso.env, store: join(dir, names.stateDir) };
  const init = await cli(['init', '--yes'], r);
  assert.equal(init.code, 0, show(init));
  assert.equal(init.out.data.handle, ME);
  r.as = (name, email) => {
    const file = join(iso.base, `${email}.gitconfig`);
    writeFileSync(file, identity(name, email));
    return { cwd: dir, env: { ...iso.env, GIT_CONFIG_GLOBAL: file } };
  };
  r.run = (args) => cli([...args, '--yes'], r);
  r.task = (id) => JSON.parse(readFileSync(join(r.store, 'tasks', id, 'task.json'), 'utf8'));
  r.raw = (id) => readFileSync(join(r.store, 'tasks', id, 'task.json'), 'utf8');
  return r;
}
const lastEvent = (doc) => doc.events[doc.events.length - 1];

// ---- task new / list / show ----

test('task new: the next T-<H>-<n> of the developer, owner, status new and a created event with author and time', async (t) => {
  const r = await active(t);
  const a = await r.run(['task', 'new', 'Cart checkout', '--lane', 'cart']);
  assert.deepEqual([a.code, a.out.data.id], [0, `T-${ME}-1`], show(a));
  const doc = r.task(`T-${ME}-1`);
  assert.match(doc.events[0].at, ISO_TIME);
  assert.deepEqual({ ...doc, events: [{ ...doc.events[0], at: 'x' }] }, {
    schema: state.KINDS.task.version, id: `T-${ME}-1`, kind: 'task', title: 'Cart checkout', lane: 'cart', owner: ME, class: null,
    classHistory: [], status: 'new', round: 0, events: [{ at: 'x', by: ME, event: 'created', data: {} }], base: null, branch: null,
  });
  assert.deepEqual(a.out.data.task, doc, 'the envelope carries the stored document');
  assert.equal((await cli(['task', 'new', 'Consent'], r)).code, 7, 'changes files: needs a terminal or --yes');
  // Another developer gets their own series.
  const other = r.as('Ann Brown', 'ann@example.com');
  assert.equal((await cli(['init', '--yes'], other)).out.data.handle, 'AB');
  const b = await cli(['task', 'new', 'Payments retry', '--yes'], other);
  assert.deepEqual([b.code, b.out.data.id, b.out.data.task.owner], [0, 'T-AB-1', 'AB'], show(b));
  assert.equal((await r.run(['task', 'new', 'Second'])).out.data.id, `T-${ME}-2`);
});

test('1.x: gate <area> and release become gate tasks (task new --kind gate [--lane <area>])', async (t) => {
  const r = await active(t);
  const gate = await r.run(['task', 'new', 'Gate cart', '--kind', 'gate', '--lane', 'cart']);
  assert.equal(gate.code, 0, show(gate));
  assert.deepEqual([gate.out.data.task.kind, gate.out.data.task.lane], ['gate', 'cart']);
  const release = await r.run(['task', 'new', 'Release 2.0.0', '--kind', 'gate']);
  assert.deepEqual([release.out.data.task.kind, release.out.data.task.lane], ['gate', null]);
  const incident = await r.run(['task', 'new', 'Revert the cache change', '--kind', 'incident']);
  assert.equal(incident.out.data.task.kind, 'incident');
});

test('task new refuses invalid values with exit 2 and writes nothing', async (t) => {
  const r = await active(t);
  const before = readdirSync(r.store).sort();
  for (const [args, code] of [
    [['task', 'new', 'x', '--kind', 'epic'], 'invalid-value'],
    [['task', 'new', 'x', '--lane', 'Cart Lane'], 'invalid-value'],
    [['task', 'new', 'x'.repeat(121)], 'limit-exceeded'],
    [['task', 'new', ''], 'invalid-value'],
    [['task', 'new', 'two\nlines'], 'invalid-value'],
    [['task', 'new', 'bidi \u202e text'], 'invalid-value'],
  ]) {
    const res = await r.run(args);
    assert.deepEqual([res.code, res.out.errors[0].code], [2, code], `${JSON.stringify(args)}: ${show(res)}`);
  }
  assert.deepEqual(readdirSync(r.store).sort(), before, 'no tasks/ directory, no counter');
  assert.equal((await r.run(['task', 'new', 'x'.repeat(120)])).out.data.id, `T-${ME}-1`, 'the limit itself is allowed; no number was used up');
});

test('task list and task show: natural order, the stored document, events with author and time', async (t) => {
  const r = await active(t);
  for (let i = 1; i <= 11; i++) await r.run(['task', 'new', `Task ${i}`]);
  const list = await cli(['task', 'list'], r);
  assert.equal(list.code, 0, show(list));
  assert.equal(list.out.data.active, true);
  assert.deepEqual(list.out.data.tasks.map((x) => x.id), Array.from({ length: 11 }, (_, i) => `T-${ME}-${i + 1}`));
  assert.deepEqual(list.out.data.tasks[0], { id: `T-${ME}-1`, kind: 'task', status: 'new', owner: ME, lane: null, round: 0, title: 'Task 1' });
  const text = await cli(['task', 'list'], { ...r, json: false });
  assert.equal(text.out.trim().split('\n').length, 11);
  assert.match(text.out, new RegExp(`^T-${ME}-10 +new +task +- +Task 10$`, 'm'), 'columns: ID, status, kind, lane (- for none), title');
  await r.run(['task', 'set', `T-${ME}-2`, 'dispatched', '--executor', 'claude:implementer', '--base', 'abc1234']);
  const one = await cli(['task', 'show', `T-${ME}-2`], r);
  assert.equal(one.code, 0, show(one));
  assert.deepEqual(one.out.data.task, r.task(`T-${ME}-2`));
  const human = await cli(['task', 'show', `T-${ME}-2`], { ...r, json: false });
  assert.match(human.out, /dispatched/);
  assert.match(human.out, new RegExp(`${ME} +dispatched +executor=claude:implementer base=abc1234`));
  for (const [id, code] of [[`T-${ME}-99`, 'task-unknown'], ['../x', 'invalid-key'], ['T-tu-1', 'invalid-key']]) {
    const res = await cli(['task', 'show', id], r);
    assert.deepEqual([res.code, res.out.errors[0].code], [2, code], `${id}: ${show(res)}`);
  }
});

// ---- task set: the 1.x task.sh states ----

test('1.x: every state is recorded with author and time in the grammar of the successor; validation writes nothing', async (t) => {
  const r = await active(t);
  const id = `T-${ME}-1`;
  await r.run(['task', 'new', 'Cart checkout']);
  const set = (...args) => r.run(['task', 'set', ...args]);
  const refused = async (args, code, why) => {
    const before = existsSync(join(r.store, 'tasks', args[0], 'task.json')) ? r.raw(args[0]) : null;
    const res = await set(...args);
    assert.deepEqual([res.code, res.out.errors[0]?.code], [2, code], `${why}: ${show(res)}`);
    if (before !== null) assert.equal(r.raw(args[0]), before, `${why}: nothing written`);
    return res;
  };

  // 1.x: dispatched needs --exec and --base
  await refused([id, 'dispatched', '--executor', 'claude:implementer'], 'missing-flag', 'dispatched without --base');
  await refused([id, 'dispatched', '--base', 'abc1234'], 'missing-flag', 'dispatched without --executor');
  await refused([id, 'dispatched', '--executor', 'x', '--base', 'not-a-sha'], 'invalid-value', 'base is a commit SHA');
  let res = await set(id, 'dispatched', '--executor', 'claude:implementer', '--base', 'abc1234', '--lane', 'cart');
  assert.equal(res.code, 0, show(res));
  let doc = r.task(id);
  assert.deepEqual([doc.status, doc.base, doc.lane], ['dispatched', 'abc1234', 'cart']);
  assert.deepEqual({ ...lastEvent(doc), at: 'x' }, { at: 'x', by: ME, event: 'dispatched', data: { executor: 'claude:implementer', base: 'abc1234', lane: 'cart' } });
  assert.deepEqual(res.out.data.event, lastEvent(doc));

  // 1.x: blocked needs a description of what unblocks it
  await refused([id, 'blocked'], 'missing-flag', 'blocked without --reason');
  res = await set(id, 'blocked', '--reason', 'waiting for S-AB-1');
  assert.deepEqual([res.code, r.task(id).status, lastEvent(r.task(id)).data], [0, 'blocked', { reason: 'waiting for S-AB-1' }], show(res));

  // 1.x: self-verified --round 2; status-request: events only
  res = await set(id, 'self-verified', '--round', '2');
  assert.deepEqual([res.code, r.task(id).status, lastEvent(r.task(id)).event, lastEvent(r.task(id)).data], [0, 'blocked', 'self-verified', { round: 2 }], show(res));
  res = await set(id, 'status-request');
  assert.deepEqual([res.code, r.task(id).status, lastEvent(r.task(id)).event, lastEvent(r.task(id)).data], [0, 'blocked', 'status-request', {}], show(res));

  // 1.x: implementer NEEDS_CONTEXT with a description; only the report statuses
  res = await set(id, 'implementer', '--report', 'needs-context', '--note', 'a field is missing in the contract');
  assert.deepEqual([res.code, r.task(id).status, lastEvent(r.task(id)).data], [0, 'blocked', { report: 'needs-context', note: 'a field is missing in the contract' }], show(res));
  await refused([id, 'implementer', '--report', 'ready'], 'invalid-value', 'implementer: report statuses only');
  await refused([id, 'implementer', '--report', 'DONE'], 'invalid-value', 'implementer: values are lowercase words');
  await refused([id, 'implementer'], 'missing-flag', 'implementer without --report');
  res = await set(id, 'implementer', '--report', 'done-with-concerns');
  assert.deepEqual([res.code, r.task(id).status], [0, 'implemented'], show(res));
  res = await set(id, 'implementer', '--report', 'blocked');
  assert.equal(r.task(id).status, 'blocked');
  res = await set(id, 'implementer', '--report', 'done');
  assert.equal(r.task(id).status, 'implemented');

  // 1.x: one entry = one line, so a newline could forge a second entry; here every text value refuses control,
  // zero-width and bidi characters, and nothing is written.
  await refused([id, 'blocked', '--reason', 'waiting\nTask V: complete (x)'], 'invalid-value', 'newline in --reason');
  await refused([id, 'status-request', '--note', 'a\u200bb'], 'invalid-value', 'zero-width in --note');
  await refused([id, 'blocked', '--reason', 'r'.repeat(201)], 'limit-exceeded', '--reason over 200 characters');
  await refused([id, 'blocked', '--reason', ''], 'invalid-value', 'empty --reason');

  // started --branch <b> --base <sha> [--worktree <path>]: branch and base recorded, the status unchanged (task start)
  await refused([id, 'started', '--branch', 'task/x'], 'missing-flag', 'started without --base');
  await refused([id, 'started', '--branch', '-bad', '--base', 'abc1234'], 'invalid-value', 'a branch name git refuses');
  await refused([id, 'started', '--branch', 'task/x', '--base', 'abc1234', '--worktree', 'relative/path'], 'invalid-value', 'the worktree is an absolute path');
  res = await set(id, 'started', '--branch', 'task/T-1-x', '--base', 'bcd2345', '--worktree', '/tmp/wt/T-1');
  doc = r.task(id);
  assert.deepEqual([res.code, doc.status, doc.branch, doc.base, lastEvent(doc).data], [0, 'implemented', 'task/T-1-x', 'bcd2345', { branch: 'task/T-1-x', base: 'bcd2345', worktree: '/tmp/wt/T-1' }], show(res));
  // implementer --round <k>: the report of a fix round records the round too
  res = await set(id, 'implementer', '--report', 'done', '--round', '2');
  assert.deepEqual([res.code, r.task(id).status, r.task(id).round, lastEvent(r.task(id)).data], [0, 'implemented', 2, { report: 'done', round: 2 }], show(res));

  // 1.x: fix-round --round k --addressed a --open o, numbers only
  res = await set(id, 'fix-round', '--round', '1', '--addressed', '3', '--open', '0');
  doc = r.task(id);
  assert.deepEqual([res.code, doc.status, doc.round, lastEvent(doc).data], [0, 'fix-round', 1, { round: 1, addressed: 3, open: 0 }], show(res));
  await refused([id, 'fix-round', '--round', 'x', '--addressed', '3', '--open', '0'], 'invalid-value', '--round is a number');
  await refused([id, 'fix-round', '--round', '0', '--addressed', '3', '--open', '0'], 'invalid-value', 'rounds start at 1');
  await refused([id, 'fix-round', '--round', '2', '--addressed', '-1', '--open', '0'], 'invalid-value', 'counts are not negative');
  await refused([id, 'fix-round', '--round', '2', '--addressed', '3'], 'missing-flag', 'fix-round without --open');

  // A flag that does not belong to the state is an error, not ignored.
  await refused([id, 'blocked', '--reason', 'x', '--base', 'abc1234'], 'unexpected-flag', '--base on blocked');

  // 1.x: complete "<text>" → done only through a passing verify (GC3); the 1.x word is not a state.
  const done = await refused([id, 'done', '--note', 'commits a..b, PR #4'], 'done-needs-verify', 'task set never closes a task');
  assert.match(done.out.errors[0].hint, /verify/);
  await refused([id, 'complete', '--note', 'commits a..b'], 'unknown-state', '1.x word');

  // 1.x: cancelled "<reason>" on another task
  await r.run(['task', 'new', 'Out of scope']);
  res = await set(`T-${ME}-2`, 'cancelled', '--reason', 'out of scope');
  assert.deepEqual([res.code, r.task(`T-${ME}-2`).status, lastEvent(r.task(`T-${ME}-2`)).data], [0, 'cancelled', { reason: 'out of scope' }], show(res));
  await refused([`T-${ME}-2`, 'cancelled'], 'missing-flag', 'cancelled without --reason');

  // 1.x: task.sh without arguments, or with an ID only, is a usage error (64) → exit 2 with the synopsis
  for (const args of [[], [id]]) {
    const res = await r.run(['task', 'set', ...args]);
    assert.deepEqual([res.code, res.out.errors[0].code], [2, 'missing-argument'], `task set ${args.join(' ')}: ${show(res)}`);
  }
  const usageText = await cli(['task', 'set', id], { ...r, json: false });
  assert.match(usageText.stderr, /usage: .* task set <id> <state>/);

  // 1.x: an ID with .. and an unknown state are usage errors
  await refused(['../x', 'status-request'], 'invalid-key', 'ID with ..');
  await refused([id, 'whatever'], 'unknown-state', 'unknown state');
  res = await set(`T-${ME}-9`, 'status-request');
  assert.deepEqual([res.code, res.out.errors[0].code], [2, 'task-unknown'], show(res));

  // Author and time on every entry.
  for (const e of r.task(id).events) {
    assert.equal(e.by, ME);
    assert.match(e.at, ISO_TIME);
  }
  assert.deepEqual(r.task(id).events.map((e) => e.event), ['created', 'dispatched', 'blocked', 'self-verified', 'status-request',
    'implementer', 'implementer', 'implementer', 'implementer', 'started', 'implementer', 'fix-round']);
});

test('task texts: brief, report and the review brief of a round are written whole by the owner; a round outside 1..999 is refused', async (t) => {
  const r = await active(t);
  const id = `T-${ME}-1`;
  await r.run(['task', 'new', 'Texts']);
  const ctx = { cwd: r.cwd, env: r.env, names };
  assert.equal(state.taskTextFile('report'), 'report.md');
  assert.equal(state.taskTextFile('review-brief', { round: 2 }), 'review-r2-brief.md');
  assert.throws(() => state.taskTextFile('review-brief', { round: 0 }), /round from 1 to 999/);
  assert.throws(() => state.taskTextFile('diff'), TypeError);
  const report = state.writeTaskText({ ...ctx, id, name: 'report', text: '---\nred: {}\n---\n# Report\n' });
  assert.deepEqual([report.outcome, report.file], ['created', join(r.store, 'tasks', id, 'report.md')]);
  assert.equal(readFileSync(report.file, 'utf8'), '---\nred: {}\n---\n# Report\n');
  const rb = state.writeTaskText({ ...ctx, id, name: 'review-brief', round: 3, text: '# Review brief\n' });
  assert.deepEqual([rb.outcome, rb.file], ['created', join(r.store, 'tasks', id, 'review-r3-brief.md')]);
  assert.equal(state.writeTaskText({ ...ctx, id, name: 'review-brief', round: 3, text: '# Edited\n' }).outcome, 'kept', 'an existing text is kept unless replace allows');
  assert.equal(state.writeTaskText({ ...ctx, id, name: 'review-brief', round: 3, text: '# Edited\n', replace: () => true }).outcome, 'replaced');
});

test('1.x: self-verified accepts --round k (r<k> was the ledger spelling and is refused); the default is the current round', async (t) => {
  const r = await active(t);
  await r.run(['task', 'new', 'UI change']);
  await r.run(['task', 'new', 'Other']);
  const set = (...args) => r.run(['task', 'set', ...args]);
  let res = await set(`T-${ME}-1`, 'self-verified', 'r2', '--note', 'UI only');
  assert.deepEqual([res.code, res.out.errors[0].code], [2, 'unexpected-argument'], show(res));
  res = await set(`T-${ME}-1`, 'self-verified', '--round', '2', '--note', 'UI only');
  assert.deepEqual(lastEvent(r.task(`T-${ME}-1`)).data, { round: 2, note: 'UI only' }, show(res));
  res = await set(`T-${ME}-2`, 'self-verified');
  assert.deepEqual(lastEvent(r.task(`T-${ME}-2`)).data, { round: 1 }, 'no round yet: 1');
  await set(`T-${ME}-2`, 'fix-round', '--round', '3', '--addressed', '2', '--open', '0');
  await set(`T-${ME}-2`, 'self-verified');
  assert.deepEqual(lastEvent(r.task(`T-${ME}-2`)).data, { round: 3 }, 'the task\'s current round');
});

test('1.x: team mode needs --pas → with the lanes capability on, a task is dispatched only with a lane', async (t) => {
  const r = await active(t);
  const store = state.open(r.store, { names });
  await r.run(['task', 'new', 'No lane']);
  await r.run(['task', 'new', 'Lane from new', '--lane', 'cart']);
  const dispatch = (id, ...extra) => r.run(['task', 'set', id, 'dispatched', '--executor', 'claude:implementer', '--base', 'abc1234', ...extra]);
  store.update('config', null, (doc) => ({ ...doc, flags: { lanes: 'shadow' } }));
  assert.equal((await dispatch(`T-${ME}-1`)).code, 0, 'shadow: not enforced');
  store.update('config', null, (doc) => ({ ...doc, flags: { lanes: 'on' } }));
  await r.run(['task', 'new', 'Another without lane']);
  const before = r.raw(`T-${ME}-3`);
  const res = await dispatch(`T-${ME}-3`);
  assert.deepEqual([res.code, res.out.errors[0].code], [2, 'lane-required'], show(res));
  assert.equal(r.raw(`T-${ME}-3`), before);
  assert.equal((await dispatch(`T-${ME}-3`, '--lane', 'payments')).code, 0);
  assert.equal(r.task(`T-${ME}-3`).lane, 'payments');
  assert.equal((await dispatch(`T-${ME}-2`)).code, 0, 'the lane given at task new counts');
});

test('1.x: team mode without an author → an unregistered developer is refused; only the owner changes a task', async (t) => {
  const r = await active(t);
  await r.run(['task', 'new', 'Mine']);
  const stranger = r.as('Sam Stone', 'sam@example.com');
  for (const args of [['task', 'new', 'x', '--yes'], ['task', 'set', `T-${ME}-1`, 'status-request', '--yes']]) {
    const res = await cli(args, stranger);
    assert.deepEqual([res.code, res.out.errors[0].code], [2, 'handle-unknown'], show(res));
    assert.match(res.out.errors[0].hint, new RegExp(`${names.bin} init`));
  }
  const noEmail = r.as('No Email', 'none');
  writeFileSync(noEmail.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = No Email\n');
  const res = await cli(['task', 'new', 'x', '--yes'], noEmail);
  assert.deepEqual([res.code, res.out.errors[0].code], [2, 'email-required'], show(res));
  assert.equal((await cli(['init', '--yes'], stranger)).code, 0);
  const before = r.raw(`T-${ME}-1`);
  const foreign = await cli(['task', 'set', `T-${ME}-1`, 'blocked', '--reason', 'mine now', '--yes'], stranger);
  assert.deepEqual([foreign.code, foreign.out.errors[0].code], [1, 'not-owner'], show(foreign));
  assert.match(foreign.out.errors[0].message, new RegExp(ME));
  assert.equal(r.raw(`T-${ME}-1`), before);
  assert.deepEqual((await cli(['task', 'list'], stranger)).out.data.tasks.map((x) => x.id), [`T-${ME}-1`], 'reading is open to everyone');
});

test('a cancelled task is closed: no further state is recorded', async (t) => {
  const r = await active(t);
  await r.run(['task', 'new', 'Dropped']);
  await r.run(['task', 'set', `T-${ME}-1`, 'cancelled', '--reason', 'superseded']);
  const before = r.raw(`T-${ME}-1`);
  for (const args of [['dispatched', '--executor', 'x', '--base', 'abc1234'], ['status-request'], ['cancelled', '--reason', 'again']]) {
    const res = await r.run(['task', 'set', `T-${ME}-1`, ...args]);
    assert.deepEqual([res.code, res.out.errors[0].code], [1, 'task-closed'], show(res));
  }
  assert.equal(r.raw(`T-${ME}-1`), before);
});

test('1.x: a ledger write error exits 2 → a state write error exits 8 (ENV) naming the path; nothing changes', { skip: process.getuid?.() === 0 }, async (t) => {
  const r = await active(t);
  await r.run(['task', 'new', 'Read-only']);
  const dir = join(r.store, 'tasks', `T-${ME}-1`);
  const before = r.raw(`T-${ME}-1`);
  chmodSync(dir, 0o555);
  let res;
  try {
    res = await r.run(['task', 'set', `T-${ME}-1`, 'status-request']);
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.deepEqual([res.code, res.out.exit, res.out.errors[0].code], [8, 'ENV', 'write-failed'], show(res));
  assert.ok(res.out.errors[0].message.includes(dir), res.out.errors[0].message);
  assert.equal(r.raw(`T-${ME}-1`), before);
  assert.deepEqual(readdirSync(dir), ['task.json'], 'no temporary file left');
});

test('a newer task schema refuses set with exit 7 and changes no byte (SC10)', async (t) => {
  const r = await active(t);
  await r.run(['task', 'new', 'Future']);
  const file = join(r.store, 'tasks', `T-${ME}-1`, 'task.json');
  const newer = `${JSON.stringify({ ...r.task(`T-${ME}-1`), schema: state.KINDS.task.version + 1 })}\n`;
  writeFileSync(file, newer);
  const res = await r.run(['task', 'set', `T-${ME}-1`, 'status-request']);
  assert.deepEqual([res.code, res.out.errors[0].code], [7, 'schema-newer'], show(res));
  assert.equal(readFileSync(file, 'utf8'), newer);
});

test('help: task set lists every state and flag; --help lists the new commands', async (t) => {
  const r = await active(t);
  const res = await cli(['task', 'set', '--help'], { ...r, json: false });
  assert.equal(res.code, 0);
  for (const word of ['dispatched', 'implementer', 'blocked', 'cancelled', 'fix-round', 'self-verified', 'status-request', 'verify',
    '--executor', '--base', '--lane', '--reason', '--note', '--report', '--round', '--addressed', '--open', '--yes']) assert.ok(res.out.includes(word), word);
  const help = await cli(['--help'], { ...r, json: false });
  for (const name of ['init', 'decline', 'deactivate', 'task new', 'task list', 'task show', 'task set']) assert.match(help.out, new RegExp(`^  ${name} `, 'm'), name);
});

// ---- concurrency: one store lock, no lost update, no duplicate ID ----

const launch = (env, cwd, args) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`deadline: ${args.join(' ')}\n${stderr}`)); }, 60000);
  child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
});

test('concurrent processes: task new gives distinct consecutive IDs; task set loses no event', async (t) => {
  const r = await active(t);
  const N = 8;
  const created = await Promise.all(Array.from({ length: N }, (_, i) => launch(r.env, r.cwd, ['task', 'new', `Parallel ${i}`, '--yes', '--json'])));
  for (const c of created) assert.equal(c.code, 0, c.stdout + c.stderr);
  const ids = created.map((c) => JSON.parse(c.stdout).data.id).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  assert.deepEqual(ids, Array.from({ length: N }, (_, i) => `T-${ME}-${i + 1}`));
  const id = `T-${ME}-1`;
  const notes = await Promise.all(Array.from({ length: N }, (_, i) => launch(r.env, r.cwd, ['task', 'set', id, 'status-request', '--note', `n${i}`, '--yes', '--json'])));
  for (const c of notes) assert.equal(c.code, 0, c.stdout + c.stderr);
  const events = r.task(id).events.filter((e) => e.event === 'status-request').map((e) => e.data.note).sort();
  assert.deepEqual(events, Array.from({ length: N }, (_, i) => `n${i}`).sort(), 'every concurrent event kept exactly once');
});
