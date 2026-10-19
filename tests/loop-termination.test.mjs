// Loop termination (spec §7.7, SC6, SC7, GC4, RF3): every loop ends with a typed exit, and after DONE, STALLED or
// BUDGET no wakeup is permitted. 1,000 randomized tick sequences run against the lib/state store with a fake probe
// (git heads, identity, cost) and a simulated agent that acts, ignores steps, lets time pass, starts and ends runs and,
// after the exit, keeps trying to schedule wakeups. The sequences are single-threaded: the 1,000 use the store with
// every document check of lib/state but plain paths and writes (no fsync, no lock: ~40,000 fsyncs take minutes);
// 3 more use the real store. A wakeup is permitted exactly when the hooks' reader of local/loop.json sees no exit
// (lib/hooks/loop-state.mjs readLoop/loopExit: an object whose `exit` is null or absent). Concurrent ticks from separate
// processes share one lock section per tick: the tick cap is never passed. Problems name their seed; LOOP_SEED=<n>
// replays one sequence.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const loop = await lib('loop/index.mjs');
const state = await lib('state/index.mjs');
const { Store } = await lib('state/store.mjs');

// lib/state's store with plain paths and writes: every read, parse, schema and field check is the real one; the path
// safety checks (links, case aliases: tests/state-paths.test.mjs) and durability are left out.
class PlainStore extends Store {
  abs(rel) { return rel === '' ? this.dir : join(this.dir, rel); }
  locked(fn) { return fn(); }
  writeText(rel, text) {
    const file = this.abs(rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
const { main } = await lib('cli/main.mjs');
const LAUNCHER = join(pluginDir, 'bin', names.bin);

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const MIN = 60000;
const TERMINAL = ['DONE', 'STALLED', 'BUDGET'];
const LIVE = ['queued', 'starting', 'running'];

// Deterministic generator (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

// The hooks' reading of the loop document: a wakeup is permitted only while no exit is recorded (missing file: no loop).
function wakeupPermitted(file) {
  let st;
  try { st = lstatSync(file); } catch { return true; }
  if (!st.isFile() || st.size > 65536) return false;
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  return doc.exit === null || doc.exit === undefined;
}

const iso = (ms) => new Date(ms).toISOString();
const ev = (event, ms, data = {}) => ({ at: iso(ms), by: 'TU', event, data });

// The next status an agent's work moves an open task to (the task commands of lib/state, verify and task done).
function advance(r, doc, now) {
  const add = (status, event, data = {}, round = doc.round) => ({ ...doc, status, round, events: [...doc.events, ev(event, now, data)] });
  switch (doc.status) {
    case 'new': return r.chance(0.5) ? { ...doc, class: 'standard' } : add('dispatched', 'dispatched', { executor: 'claude:implementer', base: 'abc1234' });
    case 'planned': return add('dispatched', 'dispatched', { executor: 'claude:implementer', base: 'abc1234' });
    case 'dispatched': return r.chance(0.8) ? add('implemented', 'implementer', { report: 'done' }) : add('blocked', 'implementer', { report: 'needs-context' });
    case 'implemented': return add('in-review', 'status-request');
    case 'in-review': return r.chance(0.5) ? add('verified', 'status-request') : add('fix-round', 'fix-round', { round: doc.round + 1, addressed: 0, open: 2 }, doc.round + 1);
    case 'fix-round': return r.chance(0.5) ? add('fix-round', 'fix-round', { round: doc.round, addressed: 2, open: 0 }) : add('fix-round', 'self-verified', { round: doc.round });
    case 'verified': return add('done', 'done', { head: 'abc1234' });
    case 'blocked': return add('dispatched', 'dispatched', { executor: 'claude:implementer', base: 'abc1234' });
    default: return doc;
  }
}

function sequence(seed, base, { real = false } = {}) {
  const r = rng(seed);
  const dir = join(base, `s${seed}`);
  const where = { repo: base, dir, local: join(dir, 'local'), active: true, linked: false };
  const store = real ? state.open(dir, { names, kinds: loop.STORE_KINDS })
    : new PlainStore(dir, { names, kinds: loop.STORE_KINDS, migrations: state.MIGRATIONS, lockTimeoutMs: 10000 });
  const file = join(dir, 'local', 'loop.json');
  store.write('state', null, { codename: names.codename, createdWith: '1.5.2', activatedAt: iso(T0) });
  store.write('team', 'TU', { handle: 'TU', emailSha256: state.emailHash('test@example.com'), addedAt: iso(T0) });
  const statuses = ['new', 'planned', 'dispatched', 'implemented', 'in-review', 'fix-round', 'verified', 'blocked', 'done', 'cancelled'];
  const n = r.int(0, 4);
  for (let i = 1; i <= n; i++) {
    const status = r.pick(statuses);
    const events = [ev('created', T0)];
    if (status === 'blocked') events.push(r.chance(0.5) ? ev('blocked', T0, { reason: 'waiting' }) : ev('implementer', T0, { report: 'blocked' }));
    if (status === 'fix-round') events.push(ev('fix-round', T0, { round: 1, addressed: 0, open: r.int(0, 2) }));
    store.write('task', `T-TU-${i}`, { id: `T-TU-${i}`, kind: r.chance(0.2) ? 'gate' : 'task', title: `Task ${i}`, lane: null, owner: 'TU', class: r.chance(0.7) ? 'standard' : null, classHistory: [], status, round: status === 'fix-round' ? 1 : 0, events, base: null, branch: null });
  }
  let caps = null;
  if (r.chance(0.85)) {
    caps = { wallMin: r.int(30, 600), ticks: r.int(2, 20), costMicroUsd: r.int(1000, 60000), rounds: r.int(1, 3) };
    store.write('loop', null, loop.newLoop({ now: T0, caps }));
  }
  let now = T0;
  let cost = 0;
  let heads = 0;
  let runN = 0;
  const live = new Map();
  const probe = { heads: () => `main ${heads}`, email: () => 'test@example.com', cost: () => ({ costMicroUsd: cost, partial: false }), dirty: () => (r.chance(0.1) ? ['x/task.json'] : []) };
  const writeRun = (id, task, status) => {
    mkdirSync(join(dir, 'local', 'runs'), { recursive: true });
    writeFileSync(join(dir, 'local', 'runs', `${id}.json`), JSON.stringify({ schema: 1, runId: id, task, role: 'reviewer', provider: 'fake', model: null, status, startedAt: iso(now), endedAt: LIVE.includes(status) ? null : iso(now), tokens: null, costMicroUsd: 10, exit: LIVE.includes(status) ? null : 0 }));
  };
  const out = { seed, exit: null, ticks: 0, permittedAfterExit: 0, problems: [] };
  const fail = (msg) => { out.problems.push(`seed ${seed}: ${msg}`); };
  let extra = -1;
  for (let i = 0; i < 400; i++) {
    const res = loop.tickStore(store, { where, names, now, plan: null, probe });
    out.ticks++;
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    if (TERMINAL.includes(res.result)) {
      if (onDisk.exit !== res.result) fail(`exit ${res.result} returned but ${onDisk.exit} on disk`);
      if (res.nextTickS !== null) fail(`a terminal exit carries NEXT_TICK ${res.nextTickS}`);
      if (out.exit === null) {
        out.exit = res.result;
        extra = r.int(1, 3);
        if (res.result === 'STALLED' && live.size > 0) fail('STALLED while a run is live');
        if (res.result === 'STALLED' && (onDisk.sameCount < 3 || now - Date.parse(onDisk.sameSince) < 30 * MIN)) fail('STALLED before 3 unchanged ticks spanning 30 min');
      } else if (res.result !== out.exit || !res.repeated) fail(`after ${out.exit} a tick returned ${res.result} (repeated ${res.repeated})`);
      // the misbehaving agent keeps trying to schedule wakeups
      for (let k = r.int(1, 3); k > 0; k--) if (wakeupPermitted(file)) out.permittedAfterExit++;
      if (extra-- <= 0) break;
    } else {
      if (out.exit !== null) fail(`after ${out.exit} a tick returned ${res.result}`);
      if (onDisk.exit !== null) fail('a running tick left an exit on disk');
      if (res.result === 'WAIT') {
        if (!wakeupPermitted(file)) fail('a running loop could not schedule its wakeup');
        if (!(res.nextTickS >= 60 && res.nextTickS <= 3600)) fail(`NEXT_TICK ${res.nextTickS} outside 60..3600`);
      }
    }
    if (caps && onDisk.ticks > caps.ticks) fail(`ticks ${onDisk.ticks} passed the cap ${caps.ticks}`);
    // the world moves: the agent acts or ignores the steps, others work, money is spent, time passes
    if (r.chance(0.6)) {
      const open = store.list('task').map((id) => store.read('task', id)).filter((d) => !['done', 'cancelled'].includes(d.status));
      if (open.length) {
        const pick = r.pick(open);
        const next = r.chance(0.08) ? { ...pick, status: 'cancelled', events: [...pick.events, ev('cancelled', now, { reason: 'x' })] } : advance(r, pick, now);
        store.update('task', pick.id, () => next);
      }
    }
    if (r.chance(0.15)) heads++;
    if (r.chance(0.15)) {
      const ids = store.list('task');
      if (ids.length) { const id = `fake-${r.pick(ids)}-reviewer-${++runN}`; live.set(id, true); writeRun(id, id.split('-').slice(1, 4).join('-'), 'running'); }
    }
    for (const id of [...live.keys()]) if (r.chance(0.3)) { live.delete(id); writeRun(id, id.split('-').slice(1, 4).join('-'), r.pick(['done', 'failed', 'timeout'])); }
    cost += r.chance(0.5) ? r.int(0, 5000) : 0;
    now += res.result === 'WAIT' ? res.nextTickS * 1000 + r.int(0, 120) * 1000 : r.int(0, 20) * MIN;
  }
  if (out.exit === null) fail(`no exit after ${out.ticks} ticks`);
  return out;
}

test('SC6: 1,000 randomized tick sequences end with a typed exit; 0 wakeups permitted after DONE, STALLED or BUDGET', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'loop-term-')));
  try {
    const first = Number(process.env.LOOP_SEED ?? 1);
    const count = process.env.LOOP_SEED ? 1 : 1000;
    const exits = { DONE: 0, STALLED: 0, BUDGET: 0 };
    let permitted = 0;
    const problems = [];
    const real = new Set(Array.from({ length: count > 1 ? 3 : 0 }, (_, k) => first + count + k));
    for (let seed = first; seed < first + count + real.size; seed++) {
      const o = sequence(seed, base, { real: real.has(seed) });
      permitted += o.permittedAfterExit;
      problems.push(...o.problems);
      if (o.exit) exits[o.exit]++;
      rmSync(join(base, `s${seed}`), { recursive: true, force: true });
    }
    assert.deepEqual(problems.slice(0, 10), [], `${problems.length} problems`);
    assert.equal(permitted, 0, 'wakeups permitted after a terminal exit');
    if (count > 1) for (const e of TERMINAL) assert.ok(exits[e] > 20, `exit ${e} reached in enough sequences (${JSON.stringify(exits)})`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('concurrent ticks from separate processes: one lock section per tick; the tick cap is never passed', async (t) => {
  const env = isolatedEnv({ gitConfig: '[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'loop-conc-' });
  t.after(env.cleanup);
  const cwd = join(env.base, 'repo');
  mkdirSync(cwd);
  const g = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd, env: env.env, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  // as in a Claude Code session: the repository has a transcript directory, so its cost is measurable (zero here)
  mkdirSync(join(env.env.CLAUDE_CONFIG_DIR, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  const io = { out: () => {}, err: () => {}, stdinIsTTY: false, env: env.env, cwd, stdin: null };
  assert.equal(await main(['init', '--yes'], { io }), 0);
  assert.equal(await main(['loop', 'start', '--caps', 'ticks=5', '--yes'], { io }), 0);
  const tickOnce = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [LAUNCHER, 'tick', '--json'], { cwd, env: env.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  const results = await Promise.all(Array.from({ length: 8 }, tickOnce));
  const codes = results.map((x) => x.code).sort((a, b) => a - b);
  assert.deepEqual(codes, [0, 0, 0, 0, 6, 6, 6, 6], results.map((x) => x.out).join('\n'));
  const doc = JSON.parse(readFileSync(join(cwd, names.stateDir, 'local', 'loop.json'), 'utf8'));
  assert.deepEqual([doc.ticks, doc.exit], [5, 'BUDGET']);
  assert.equal(results.filter((x) => JSON.parse(x.out).data.repeated === true).length, 3, 'one BUDGET tick, three repeats');
});
