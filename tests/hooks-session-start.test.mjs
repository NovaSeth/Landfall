// Session context (spec §7.2, §7.13, §8.3, SC3, GC7): SessionStart → `session-start`. In an active repository it
// injects at most 2,000 characters: the state line, the tier when known, the loop state, the active tasks with their
// next step, "run `<bin> tick`" and the always rules of the method (up to 8); in an inactive, declined or non-git
// directory it injects nothing and writes nothing in the repository. The worst-case fixture (hundreds of tasks with
// long titles, an unreadable loop state) stays within the budget and keeps every always rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { MALFORMED, git, hook, launch, lib, loopDoc, names, repo, task, writeLoop } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const { CONTEXT_MAX, NEXT_STEP, renderContext } = await lib('hooks/session-start.mjs');
const { openMethod } = await lib('method/index.mjs');
const { TASK_STATUSES } = await lib('state/index.mjs');
const ALWAYS = openMethod().index.always;
const start = (f, source = 'startup', extra = {}) => hook('session-start', { session_id: 's', hook_event_name: 'SessionStart', source, cwd: f.dir, model: 'claude-opus', ...extra }, { env: f.env });

test('session context: an active repository gets the state line, the tasks with next steps, the loop, `tick` and the always rules', (t) => {
  const f = repo(t);
  const ids = ['new', 'dispatched', 'fix-round', 'verified', 'blocked', 'done', 'cancelled'].map((status, k) => task(f.store, k + 1, { status, title: `Work on part ${k + 1}`, round: status === 'fix-round' ? 2 : 0 }));
  writeLoop(f.stateDir, loopDoc(null));
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const v = start(f, source);
    assert.equal(v.event, 'SessionStart', source); assert.deepEqual(v.keys, ['hookSpecificOutput']);
    const c = v.context;
    assert.ok(c.length <= CONTEXT_MAX, `${c.length} chars`);
    assert.match(c, new RegExp(`\`${names.bin} tick\``), 'the next action names the tick');
    for (const id of ALWAYS) assert.match(c, new RegExp(`^${id}\\. `, 'm'), `always rule ${id}`);
    for (const id of ids.slice(0, 5)) assert.match(c, new RegExp(`^- ${id} `, 'm'), `active task ${id}`);
    for (const id of ids.slice(5)) assert.doesNotMatch(c, new RegExp(id), `closed task ${id}`);
    assert.match(c, /- T-AB-3 fix-round r2: Work on part 3 → /, 'status, round, title and next step');
    assert.match(c, /Loop: running/);
  }
});

test('session context: every active task status has a next step; a terminal or unreadable loop is said plainly', (t) => {
  for (const s of TASK_STATUSES.filter((x) => !['done', 'cancelled'].includes(x))) assert.equal(typeof NEXT_STEP[s], 'string', s);
  const f = repo(t);
  task(f.store, 1);
  writeLoop(f.stateDir, loopDoc('STALLED'));
  assert.match(start(f).context, /Loop: ended \(STALLED\); schedule no further wakeup/);
  writeLoop(f.stateDir, '{');
  assert.match(start(f).context, /Loop: state cannot be read \(not JSON\)/);
});

test('session context: tier when known (pure renderer); the hook prints the engine tier line within the budget', (t) => {
  const method = openMethod();
  const text = renderContext({ bin: names.bin, where: `state in ${names.stateDir}`, tier: 'L2', tasks: [], loop: { exit: null, doc: null }, rules: [] });
  assert.match(text, /^Tier: L2\.$/m);
  const f = repo(t);
  const c = start(f).context;
  assert.match(c, /^Tier: L\d\.$/m);
  assert.ok(c.length <= CONTEXT_MAX);
  assert.ok(method.index.always.length <= 8);
});

test('SC3: the worst-case state (150 tasks with 120-character titles, unreadable loop) stays within 2,000 characters with every always rule', (t) => {
  const f = repo(t);
  for (let n = 1; n <= 150; n++) task(f.store, n, { status: n % 3 ? 'in-review' : 'fix-round', round: n % 3 ? 0 : 999, title: `${'W'.repeat(100)} ${String(n).padStart(19, '0')}` });
  writeLoop(f.stateDir, '{"exit":');
  const c = start(f).context;
  assert.ok(c.length <= CONTEXT_MAX, `${c.length} chars`);
  for (const id of ALWAYS) assert.match(c, new RegExp(`^${id}\\. `, 'm'), `always rule ${id}`);
  assert.match(c, /^- … \d+ more: `\S+ task list`$/m, 'the rest is counted, not dropped silently');
  assert.match(c, /^- T-AB-1 /m, 'the first tasks are shown');
  // the pure renderer keeps the budget for any input size, even with a smaller limit
  const rules = ALWAYS.map((id) => ({ id, text: 'x'.repeat(300) }));
  for (const max of [CONTEXT_MAX, 1000, 300]) {
    const text = renderContext({ bin: names.bin, where: `state in ${names.stateDir}`, tier: 'L3', tasks: Array.from({ length: 50 }, (_, k) => ({ id: `T-AB-${k + 1}`, status: 'new', round: 0, title: 'y'.repeat(120) })), loop: { error: 'x'.repeat(500) }, rules, max });
    assert.ok(text.length <= max, `${max}: ${text.length}`);
  }
});

test('session context: inactive, declined and non-git directories get nothing and no file is written (SC2)', (t) => {
  const f = repo(t, { active: false });
  for (const source of ['startup', 'resume', 'clear', 'compact']) assert.equal(start(f, source).stdout, '', source);
  assert.equal(git(f.dir, ['status', '--porcelain', '--untracked-files=all'], f.env), '', 'nothing written in the repository');
  const none = { dir: mkdtempSync(join(tmpdir(), 'no-repo-')), env: process.env };
  assert.equal(start(none).stdout, '');
});

test('session context: malformed input → no output (GC8); the launcher prints the same JSON as the registry', (t) => {
  const f = repo(t);
  task(f.store, 1, { title: 'Launch check' });
  for (const text of MALFORMED) assert.equal(hook('session-start', text, { env: f.env }).stdout, '', text);
  assert.equal(start({ ...f, dir: 'relative/path' }).stdout, '', 'a relative cwd is not guessed');
  const r = launch('session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd: f.dir }, { env: f.env, cwd: f.dir });
  assert.equal(r.status, 0); assert.match(r.context, /T-AB-1 dispatched: Launch check/);
});
