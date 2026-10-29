// ORC-24 orchestrator watchdog (T-MG-81): the rule, the skills that cite it, and the watch rows of status and tick
// (a heavy-queue entry waiting over 10 minutes; load at or over the calibrated max). Readings are injected (io.readings),
// the heavy ticket is planted with an old `at`: no real load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
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
const table = await lib('loop/table.mjs');
const sched = await lib('sched/index.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const CALM = Object.freeze({ cores: 10, load1: 1, loadMeasurable: true, totalBytes: 32 * 2 ** 30, availBytes: 20 * 2 ** 30, memMethod: 'vm_stat' });
const BUSY = Object.freeze({ ...CALM, load1: 14.2 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const git = (cwd, env, args) => { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

test('ORC-24 resolves with rule, in the method after ORC-23, within the rule caps', () => {
  const r = spawnSync(process.execPath, [join(pluginDir, 'bin', names.bin), 'rule', 'ORC-24'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ORC-24\. Be proactive and keep the work flowing: while agents, external runs or gates work in the background/);
  assert.match(r.stdout, /an executor past its budget gets a status request \(ORC-9\)/);
  const text = readFileSync(join(pluginDir, 'method', 'orchestration.md'), 'utf8');
  assert.ok(text.indexOf('**ORC-23.**') < text.indexOf('**ORC-24.**'));
  assert.ok(text.indexOf('**ORC-24.**') < text.indexOf('**ORC-25.**') && !text.includes('**ORC-26.**')); // T-MG-80: ORC-25 follows the watchdog rule
});

test('the dispatch and loop skills name ORC-24', () => {
  const d = readFileSync(join(pluginDir, 'templates', 'skills', 'dispatch.md'), 'utf8');
  const l = readFileSync(join(pluginDir, 'templates', 'skills', 'loop.md'), 'utf8');
  assert.match(d.split('\n').find((x) => x.startsWith('Rules:')), /ORC-24/);
  assert.ok(d.includes('While 2+ agents or a gate run in the background, schedule a check every ~10 min (Claude Code: a recurring cron prompt; elsewhere the loop\'s tick) and unblock what it finds (ORC-24).'));
  assert.match(l, /ORC-24/);
});

test('watchRows: a heavy ticket queued 12 minutes ago, load over the max, a calm state', () => {
  const now = Date.now();
  const queue = [{ status: 'live', at: iso(12 * 60e3) }, { status: 'live', at: iso(2 * 60e3) }];
  const heavy = table.watchRows({ queue, readings: CALM, loadMax: '8.0', now });
  assert.deepEqual(heavy, [{ code: 'heavy-queue', message: 'heavy queue: 2 waiting, oldest 12 min → hold new dispatches until the gate is through (ORC-24)' }]);
  const load = table.watchRows({ queue: [], readings: BUSY, loadMax: '8.0', now });
  assert.deepEqual(load, [{ code: 'load', message: 'load 14.2 ≥ 8.0 → start no new agents until it falls (ORC-24)' }]);
  assert.deepEqual(table.watchRows({ queue: [{ status: 'live', at: iso(9 * 60e3) }, { status: 'stale', at: iso(60 * 60e3) }], readings: CALM, loadMax: '8.0', now }), []);
  assert.deepEqual(table.watchRows({ queue: [], readings: BUSY, loadMax: 'off', now }), []);
});

function repository(t, readings) {
  const iso2 = isolatedEnv({ gitConfig: identity, prefix: 'watch-' });
  t.after(iso2.cleanup);
  const repo = join(iso2.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso2.env, CLAUDE_PLUGIN_DATA: join(iso2.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const cwd = realpathSync(repo);
  const run = async (args, json = false) => {
    const out = [];
    const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null, readings };
    const code = await main(json ? [...args, '--json'] : args, { io });
    const s = out.join('');
    return { code, out: json ? JSON.parse(s) : s };
  };
  return { env, cwd, base: iso2.base, run };
}

async function plantHeavy(p, minutesAgo) {
  sched.calibrate({ names, env: p.env, readings: CALM, loadMax: '8.0' });
  const { start, method } = sched.identify([process.pid]).get(process.pid);
  const wt = join(p.base, 'queued-wt');
  mkdirSync(wt);
  const worktree = realpathSync(wt);
  const dir = join(p.base, 'data', 'heavy-queue');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(worktree).digest('hex').slice(0, 16);
  writeFileSync(join(dir, `${key}.json`), `${JSON.stringify({ schema: 1, kind: 'heavy', seq: 1, worktree, owner: { pid: process.pid, start: start ?? null, method: method ?? null }, task: null, at: iso(minutesAgo * 60e3), deadline: iso(-3600e3) }, null, 2)}\n`);
}

test('status and tick: the heavy row, the load row, and no row when calm; tick keeps its exit code', async (t) => {
  const calm = repository(t, CALM);
  await calm.run(['init', '--yes']);
  const quiet = await calm.run(['status'], true);
  assert.deepEqual(quiet.out.data.watch, []);
  assert.doesNotMatch((await calm.run(['status'])).out, /ORC-24/);
  const tickCalm = await calm.run(['tick']);

  await plantHeavy(calm, 12);
  const s = await calm.run(['status'], true);
  assert.deepEqual(s.out.data.watch, [{ code: 'heavy-queue', message: 'heavy queue: 1 waiting, oldest 12 min → hold new dispatches until the gate is through (ORC-24)' }]);
  assert.match((await calm.run(['status'])).out, /^heavy queue: 1 waiting, oldest 12 min → hold new dispatches/m);
  const tick = await calm.run(['tick']);
  assert.equal(tick.code, tickCalm.code, 'exit code unchanged');
  assert.match(tick.out, /heavy queue: 1 waiting, oldest 12 min/);

  const busy = repository(t, BUSY);
  await busy.run(['init', '--yes']);
  sched.calibrate({ names, env: busy.env, readings: CALM, loadMax: '8.0' });
  const b = await busy.run(['status'], true);
  assert.deepEqual(b.out.data.watch.map((x) => x.code), ['load']);
  assert.match(b.out.data.watch[0].message, /^load 14\.2 ≥ 8\.0 → start no new agents until it falls \(ORC-24\)$/);
  const bt = await busy.run(['tick']);
  assert.match(bt.out, /load 14\.2 ≥ 8\.0/);
  assert.ok(![...bt.out.matchAll(/ORC-24/g)].length === false);
});
