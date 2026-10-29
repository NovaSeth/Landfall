// Native task gate (T-MG-16, D-MG-23, FLW-8): TaskCompleted → `task-gate`, capability `task-mirror` (opt-in, default off).
// With the flag on, a native completion whose subject starts with a task ID of the active state is refused (exit 2,
// stderr ≤ 200 characters) until that task is done or cancelled; anything else is allowed. Subjects are data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MALFORMED, hook, lib, names, repo, task } from './helpers/hook-fixture.mjs';

const { rollout } = await lib('config/index.mjs');

const done = (f, subject, extra = {}) => hook('task-gate', { session_id: 's', hook_event_name: 'TaskCompleted', task_id: '1', task_subject: subject, cwd: f.dir, ...extra },
  { env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir } });
const flagOn = (f) => f.store.write('config', null, { flags: { 'task-mirror': 'on' } });

test('task-mirror is an opt-in capability, default off, with the two texts', () => {
  const c = rollout('task-mirror');
  assert.deepEqual([c.default, c.modes], ['off', ['off', 'on']]);
  assert.equal(c.on, "Landfall tasks are mirrored in the native task list and a native completion needs Landfall's done");
  assert.equal(c.off, 'no native task mirror');
});

test('flag off: an open task completes natively', (t) => {
  const f = repo(t); const id = task(f.store, 1);
  assert.equal(done(f, `${id} Title`).decision, 'allow');
});

test('flag on: an open task is refused with exit 2 and a short message naming the next steps', (t) => {
  const f = repo(t); const id = task(f.store, 1, { status: 'implemented' }); flagOn(f);
  const r = done(f, `${id} Title`);
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trim(), `${id} is implemented: run ${names.bin} verify ${id}, then ${names.bin} task done ${id}, before completing it (FLW-8).`);
  assert.ok(r.stderr.length <= 200);
});

test('flag on: done and cancelled tasks, foreign subjects, unknown tasks and an inactive state are allowed', (t) => {
  const f = repo(t); flagOn(f);
  const d = task(f.store, 1, { status: 'done' }); const c = task(f.store, 2, { status: 'cancelled' });
  assert.equal(done(f, `${d} Title`).decision, 'allow');
  assert.equal(done(f, `${c} Title`).decision, 'allow');
  task(f.store, 3);
  for (const s of ['Write the docs', 'fix T-AB-3 now', 'T-AB-99 unknown', undefined, 7]) assert.equal(done(f, s).decision, 'allow', String(s));
  const q = repo(t, { active: false });
  assert.equal(done(q, 'T-AB-3 Title').decision, 'allow');
});

test('flag on: malformed input is allowed', (t) => {
  const f = repo(t); flagOn(f);
  for (const text of MALFORMED) assert.equal(hook('task-gate', text, { env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir } }).decision, 'allow', text);
});

test('flag on: a title with $(…) is data; nothing runs', (t) => {
  const f = repo(t); flagOn(f); const id = task(f.store, 1, { status: 'done' });
  const mark = join(f.base, 'ran');
  assert.equal(done(f, `${id} $(touch ${mark}) \`touch ${mark}\``).decision, 'allow');
  const open = task(f.store, 2);
  const r = done(f, `${open} $(touch ${mark})`);
  assert.equal(r.code, 2);
  assert.ok(!r.stderr.includes('$(') && r.stderr.length <= 200);
  assert.ok(!existsSync(mark));
});

test('flag on: p95 under 50 ms in process', (t) => {
  const f = repo(t); flagOn(f); const id = task(f.store, 1);
  done(f, `${id} x`);
  const xs = [];
  for (let k = 0; k < 40; k++) { const s = performance.now(); done(f, `${id} x`); xs.push(performance.now() - s); }
  xs.sort((a, b) => a - b);
  assert.ok(xs[Math.ceil(xs.length * 0.95) - 1] < 50, `p95 ${xs[37].toFixed(1)} ms`);
});
