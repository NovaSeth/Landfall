// `status --json` gives each open task its timing: startedAt, lastEventAt, expectedMs, expectedFrom (T-MG-103).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
  const make = async (title, { cls = null, status = 'new', events = null } = {}) => {
    await run(['task', 'new', title]);
    const id = store.list('task').sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop())).at(-1);
    const doc = store.read('task', id);
    store.write('task', id, { ...doc, class: cls, status, events: events ?? doc.events });
    return id;
  };
  const tasks = async () => JSON.parse((await cli(['status', '--json'], p)).out).data.tasks;
  return { make, tasks };
}

const ev = (event, at) => ({ at: new Date(at).toISOString(), by: 'TU', event, data: {} });
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

test('an open task that started has startedAt and lastEventAt; a task without events has nulls', async (t) => {
  const r = await repository(t);
  const a = await r.make('Started', { cls: 'standard', status: 'dispatched', events: [ev('created', T0), ev('dispatched', T0 + MIN), ev('started', T0 + 2 * MIN), ev('note', T0 + 5 * MIN)] });
  const b = await r.make('Fresh', { events: [] });
  const by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.equal(by[a].startedAt, new Date(T0 + MIN).toISOString());
  assert.equal(by[a].lastEventAt, new Date(T0 + 5 * MIN).toISOString());
  assert.deepEqual([by[b].startedAt, by[b].lastEventAt], [null, null]);
});

test('with 3 or more done tasks of the class the median is expectedMs (history); fewer: the class default', async (t) => {
  const r = await repository(t);
  const done = (minutes) => ({ cls: 'standard', status: 'done', events: [ev('created', T0), ev('dispatched', T0 + MIN), ev('done', T0 + MIN + minutes * MIN)] });
  const open = await r.make('Open', { cls: 'standard', status: 'dispatched', events: [ev('started', T0)] });
  const crit = await r.make('Crit', { cls: 'critical', status: 'dispatched', events: [] });
  const none = await r.make('NoClass', { events: [] });
  let by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.deepEqual([by[open].expectedMs, by[open].expectedFrom], [45 * MIN, 'default']);
  assert.deepEqual([by[crit].expectedMs, by[crit].expectedFrom], [120 * MIN, 'default']);
  assert.deepEqual([by[none].expectedMs, by[none].expectedFrom], [45 * MIN, 'default']);
  await r.make('D1', done(10));
  await r.make('D2', done(30));
  by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.equal(by[open].expectedFrom, 'default', 'two done tasks are not enough');
  await r.make('D3', done(20));
  by = Object.fromEntries((await r.tasks()).map((x) => [x.id, x]));
  assert.deepEqual([by[open].expectedMs, by[open].expectedFrom], [20 * MIN, 'history']);
  assert.deepEqual([by[crit].expectedMs, by[crit].expectedFrom], [120 * MIN, 'default'], 'another class keeps its default');
});
