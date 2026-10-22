// Task dependencies (retro 2026-10 §4.13): `task new --after <ids>` records the tasks a new one waits for; the loop's
// step table and `status` hold it back (a wait row, no route and no dispatch) until each predecessor is closed; `task
// show` lists them with their status. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const loop = await lib('loop/index.mjs');
const state = await lib('state/index.mjs');

const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  return { code, out: json ? JSON.parse(out.join('')) : out.join(''), stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

async function active(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'task-after-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir, env: iso.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const ctx = { cwd: dir, env: iso.env, run: (args) => cli([...args, '--yes'], { cwd: dir, env: iso.env }) };
  assert.equal((await ctx.run(['init'])).code, 0);
  ctx.store = state.open(join(dir, names.stateDir), { names });
  return ctx;
}

const task = (id, status, after = []) => ({ id, kind: 'task', title: id, lane: null, owner: 'TU', class: null, classHistory: [], status, round: 0, events: [{ at: '2026-10-22T10:00:00.000Z', by: 'TU', event: 'created', data: after.length ? { after } : {} }], base: null, branch: null });
const steps = (tasks) => loop.nextSteps({ tasks, runs: [], handles: ['TU'], me: 'TU', caps: loop.DEFAULT_CAPS, now: Date.parse('2026-10-22T10:05:00.000Z'), bin: names.bin });

test('task new --after records the predecessors in the created event; unknown or malformed IDs are refused, nothing written', async (t) => {
  const r = await active(t);
  assert.equal((await r.run(['task', 'new', 'Contracts'])).out.data.id, 'T-TU-1');
  const b = await r.run(['task', 'new', 'Screens', '--after', 'T-TU-1']);
  assert.equal(b.code, 0, show(b));
  assert.deepEqual([b.out.data.id, b.out.data.task.events[0].data], ['T-TU-2', { after: ['T-TU-1'] }]);
  assert.deepEqual(state.afterOf(r.store.read('task', 'T-TU-2')), ['T-TU-1']);
  assert.deepEqual(state.afterOf(r.store.read('task', 'T-TU-1')), []);
  const text = await cli(['task', 'new', 'Docs', '--after', 'T-TU-1,T-TU-2', '--yes'], { cwd: r.cwd, env: r.env, json: false });
  assert.equal(text.out, 'T-TU-3 (after T-TU-1, T-TU-2)\n');
  for (const [after, code] of [['T-TU-9', 'task-unknown'], ['nope', 'invalid-value'], ['T-TU-1,'.repeat(21).slice(0, -1), 'invalid-value']]) {
    const bad = await r.run(['task', 'new', 'Bad', '--after', after]);
    assert.deepEqual([bad.code, bad.out.errors[0].code], [2, code], `${after}: ${show(bad)}`);
  }
  assert.deepEqual(r.store.list('task'), ['T-TU-1', 'T-TU-2', 'T-TU-3'], 'nothing written for the refused ones');
  const card = await cli(['task', 'show', 'T-TU-3'], { cwd: r.cwd, env: r.env, json: false });
  assert.match(card.out, /^after: T-TU-1 \(new\), T-TU-2 \(new\)$/m);
  assert.match(card.out, /^next: waits for T-TU-1, T-TU-2 → dispatch nothing/m);
  const json = await cli(['task', 'show', 'T-TU-3'], { cwd: r.cwd, env: r.env });
  assert.deepEqual(json.out.data.card.after, [{ id: 'T-TU-1', status: 'new' }, { id: 'T-TU-2', status: 'new' }]);
});

test('the step table holds a task back while a predecessor is open, releases it when every predecessor is closed, and leaves a dispatched task alone', () => {
  const held = steps([task('T-TU-1', 'dispatched'), task('T-TU-2', 'new', ['T-TU-1'])]);
  const row = held.steps.find((s) => s.task === 'T-TU-2');
  assert.deepEqual([row.kind, row.state, row.rules], ['wait', 'waits for T-TU-1', ['FLW-9']], JSON.stringify(held.steps));
  assert.equal(held.outcome, 'wait', 'nothing to act on: the loop waits for the executor of T-TU-1');
  const released = steps([task('T-TU-1', 'done'), task('T-TU-2', 'new', ['T-TU-1'])]);
  assert.deepEqual(released.steps.map((s) => [s.task, s.kind, s.state]), [['T-TU-2', 'action', 'new, not routed']]);
  const cancelled = steps([task('T-TU-1', 'cancelled'), task('T-TU-2', 'new', ['T-TU-1'])]);
  assert.equal(cancelled.steps[0].kind, 'action', 'a cancelled predecessor releases the task');
  const unknown = steps([task('T-TU-2', 'new', ['T-TU-7'])]);
  assert.deepEqual([unknown.steps[0].kind, unknown.steps[0].state], ['wait', 'waits for T-TU-7'], 'an unknown predecessor keeps the task waiting');
  const dispatched = steps([task('T-TU-1', 'new'), task('T-TU-2', 'dispatched', ['T-TU-1'])]);
  assert.ok(dispatched.steps.find((s) => s.task === 'T-TU-2').state.startsWith('executor working'), 'a task already dispatched follows its own row');
  const two = steps([task('T-TU-1', 'done'), task('T-TU-2', 'new'), task('T-TU-3', 'new', ['T-TU-1', 'T-TU-2'])]);
  assert.deepEqual(two.steps.map((s) => [s.task, s.kind]), [['T-TU-2', 'action'], ['T-TU-3', 'wait']]);
  assert.equal(two.outcome, 'action', 'the free task is acted on while the dependent one waits');
});
