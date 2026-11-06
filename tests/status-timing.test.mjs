// `status --json` gives each open task its timing: startedAt, lastEventAt, expectedMs, expectedFrom (T-MG-103).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const pluginDir = join(plugins, readdirSync(plugins).find((d) => existsSync(join(plugins, d, 'lib', 'name.json'))));
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const { open } = await lib('state/index.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const MIN = 60000;

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
async function cli(args, { cwd, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(args, { io });
  return { code, out: out.join('') };
}

async function repository(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'timing-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { cwd: repo, env };
  const run = async (args) => assert.equal((await cli([...args, '--yes'], p)).code, 0, args.join(' '));
  await run(['init']);
  const dir = join(realpathSync(repo), names.stateDir);
  const store = open(dir, { names });
  // A task with the class, status and events given; ids come from `task new`.
  const make = async (title, { cls = null, status = 'new', events = null, brief = null } = {}) => {
    await run(['task', 'new', title]);
    const id = store.list('task').sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop())).at(-1);
    const doc = store.read('task', id);
    store.write('task', id, { ...doc, class: cls, status, events: events ?? doc.events });
    if (brief !== null) {
      mkdirSync(join(dir, 'tasks', id), { recursive: true });
      writeFileSync(join(dir, 'tasks', id, 'brief.md'), brief);
    }
    return id;
  };
  const tasks = async () => JSON.parse((await cli(['status', '--json'], p)).out).data.tasks;
  return { make, tasks };
}

const ev = (event, at) => ({ at: new Date(at).toISOString(), by: 'TU', event, data: {} });
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

test('an open task that started has startedAt and lastEventAt; a task without events has nulls', async (t) => {
  const r = await repository(t);
  const a = await r.make('Started', { cls: 'standard', status: 'dispatched', events: [ev('created', T0), ev('dispatched', T0 + MIN), ev('dispatched', T0 + 2 * MIN), ev('started', T0 + 3 * MIN), ev('note', T0 + 5 * MIN)] });
  const b = await r.make('Fresh', { events: [] });
  const by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.equal(by[a].startedAt, new Date(T0 + 2 * MIN).toISOString());
  assert.equal(by[a].lastEventAt, new Date(T0 + 5 * MIN).toISOString());
  assert.deepEqual([by[b].startedAt, by[b].lastEventAt], [null, null]);
});

test('with 3 or more done tasks of the class the median is expectedMs (history); fewer: the class default', async (t) => {
  // Keep the original test name while asserting T-MG-202: history never replaces the brief budget.
  const r = await repository(t);
  const done = (minutes) => ({ cls: 'standard', status: 'done', events: [ev('created', T0), ev('dispatched', T0 + MIN), ev('done', T0 + MIN + minutes * MIN)] });
  const open = await r.make('Open', { cls: 'standard', status: 'dispatched', events: [ev('started', T0)] });
  const crit = await r.make('Crit', { cls: 'critical', status: 'dispatched', events: [] });
  const none = await r.make('NoClass', { events: [] });
  let by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.deepEqual([by[open].expectedMs, by[open].expectedFrom], [15 * MIN, 'default']);
  assert.deepEqual([by[crit].expectedMs, by[crit].expectedFrom], [15 * MIN, 'default']);
  assert.deepEqual([by[none].expectedMs, by[none].expectedFrom], [null, 'default']);
  await r.make('D1', done(10));
  await r.make('D2', done(30));
  by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.deepEqual([by[open].expectedMs, by[open].expectedFrom], [15 * MIN, 'default'], 'two done tasks do not affect the budget');
  await r.make('D3', done(20));
  by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.deepEqual([by[open].expectedMs, by[open].expectedFrom], [15 * MIN, 'default'], 'three done tasks do not affect the budget');
  assert.deepEqual([by[crit].expectedMs, by[crit].expectedFrom], [15 * MIN, 'default'], 'all classes use the same default budget');
});

test('a fix-round restarts the current stage, including while in review', async (t) => {
  const r = await repository(t);
  for (const status of ['fix-round', 'in-review']) {
    await r.make(status, { status, events: [ev('dispatched', T0), ev('fix-round', T0 + 10 * MIN), ev('fix-round', T0 + 20 * MIN), ev('started', T0 + 21 * MIN)] });
  }
  for (const task of await r.tasks()) {
    assert.equal(task.startedAt, new Date(T0 + 20 * MIN).toISOString());
    assert.deepEqual([task.expectedMs, task.expectedFrom], [15 * MIN, 'default']);
  }
});

test('a started event alone does not start a stage', async (t) => {
  const r = await repository(t);
  await r.make('Started only', { status: 'dispatched', events: [ev('started', T0)] });
  assert.equal((await r.tasks())[0].startedAt, null);
});

test('a brief Budget: 25 minutes gives 1 500 000 ms for each covered status', async (t) => {
  const r = await repository(t);
  for (const status of ['dispatched', 'in-review', 'fix-round']) {
    await r.make(status, { status, events: [ev('dispatched', T0)], brief: '# Task\n\nBudget: 25 minutes\n' });
  }
  for (const task of await r.tasks()) {
    assert.deepEqual([task.expectedMs, task.expectedFrom], [1500000, 'default']);
  }
});

test('a blocked task and other inactive statuses have expectedMs null even with a brief and prior stage', async (t) => {
  const r = await repository(t);
  for (const status of ['new', 'planned', 'blocked', 'verified', 'implemented']) {
    await r.make(status, { status, events: [ev('dispatched', T0)], brief: 'Budget: 25 minutes\n' });
  }
  for (const task of await r.tasks()) {
    assert.equal(task.startedAt, new Date(T0).toISOString());
    assert.deepEqual([task.expectedMs, task.expectedFrom], [null, 'default'], task.status);
  }
});
