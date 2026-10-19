// Interleaving and crash harness (review rounds 1-2, findings-r2 point 7, findings S3): per seed, processes run
// seeded random operations on one store at once in two rounds. Round A: workers, a no-link worker and crashers
// (killed at a random file system call). Then, in a quiescent window (every process has exited), the explicit
// unlock a person runs after a crash (`state unlock --stale`; it is never raced against live writers, which is
// outside its contract). Round B: workers while a newer plugin upgrades the store schema. Guarantees checked:
//   1. no partial file: every state file (local/ids counters included) parses and validates, none is empty;
//   2. no duplicate or reused ID; every returned ID's object or tombstone exists; tombstones are honoured (no
//      object exists next to its tombstone); each series' high-water mark is at least its highest returned ID;
//   3. no write under a newer schema: an operation that starts after the upgrade refuses with schema-newer and
//      its net file system effect, outside the lock directory, is empty (recorded per call, not inferred);
//   4. without hard links an exclusive create refuses with fs-unsupported and leaves nothing;
//   5. no lost update: per item and per task, the stored count equals the updates that returned success;
//   6. every crasher was killed, or stopped at a dead process's lock; a process that exits cleanly leaves no
//      temporary file and no lock (attributed by the pid in the artifact's name or owner record, after the round,
//      when every process has exited); a crash leaves at most a lock whose owner is dead, which no writer takes
//      over (stale-lock) until the explicit unlock; afterwards local/ holds only ids/ and backup/;
//   7. no failure other than the expected refusals of the round; every refusal had no effect (deletions of
//      existing paths count as effects).
// No assertion depends on wall-clock speed or on how the system interleaves the processes: coverage comes from
// forced first operations and progress conditions (the crashers start after them, the upgrade after some round B
// work, a write is the first operation after the upgrade), and a lock wait that times out (locked) is retried.
// Every wait is bounded by a process deadline and a round deadline, which end with diagnostics.
// FIRST seed: STATE_HARNESS_SEED (default 0x5EED); STATE_HARNESS_SEEDS seeds (default 30).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const STATE = pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href;
const state = await import(STATE);
const { KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const ITEMS = ['i0', 'i1', 'i2', 'i3'];

// This plugin knows item schema 2; the newer plugin also knows store schema KINDS.state.version + 1.
const KINDS_MODULE = `const state = await import(${JSON.stringify(STATE)});
const item = state.defineKind('item', 2, { dir: 'items', keyPattern: /^i\\d$/, file: (k) => 'items/' + k + '.json', match: /^items\\/(i\\d)\\.json$/, key: 'id',
  fields: { id: { t: 'str', max: 9 }, n: { t: 'int', min: 0, max: 100000 }, m: { t: 'int', min: 0, max: 9 } } });
const itemStep = { id: '001-item-m', kind: 'item', from: 1, to: 2, up: (d) => ({ ...d, m: 1 }) };
const newerState = state.defineKind('state', state.KINDS.state.version + 1, { dir: '', file: () => 'state.json', match: /^state\\.json$/, fields: (({ schema, ...f }) => f)(state.KINDS.state.spec.f) });
const stateStep = { id: '002-state-newer', kind: 'state', from: state.KINDS.state.version, to: state.KINDS.state.version + 1, up: (d) => d };
const names = ${JSON.stringify(names)};
export const current = (dir, opts = {}) => state.open(dir, { names, kinds: { ...state.KINDS, item }, migrations: [itemStep], ...opts });
export const newer = (dir, opts = {}) => state.open(dir, { names, kinds: { ...state.KINDS, item, state: newerState }, migrations: [itemStep, stateStep], ...opts });
export { state };
`;

// The recorder of every harness process (child code; uses dir, LOGS, role and rand of the child): it counts the
// mutating calls for the crasher's kill point and records each operation's net effect on the store.
const RECORDER = `// Record the net effect of each operation on the store: paths created, changed or deleted (a path created and
// removed again within the operation is no effect; removing a path that existed before is).
const real = {};
let effect = null; // path → 'new' | 'changed' | 'deleted'
const inStore = (p) => typeof p === 'string' && p.startsWith(dir + '/');
const exists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const touch = (p, isNew) => { if (!effect || !inStore(p)) return; const was = effect.get(p); effect.set(p, was === 'new' || (was === undefined && isNew) ? 'new' : 'changed'); };
const gone = (p) => {
  if (!effect || !inStore(p)) return;
  for (const q of [...effect.keys()]) if (q.startsWith(p + '/')) effect.delete(q);
  if (effect.get(p) === 'new') effect.delete(p); else effect.set(p, 'deleted');
};
for (const fn of ['openSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'linkSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'copyFileSync', 'symlinkSync']) real[fn] = fs[fn];
let calls = 0;
const killAt = role === 'crasher' ? 3 + Math.floor(rand() * 40) : Infinity;
const counted = (p) => !String(p).startsWith(LOGS);
fs.openSync = (p, f, ...x) => { if (counted(p) && /[wax+]/.test(String(f)) && ++calls === killAt) process.kill(process.pid, 'SIGKILL'); const had = typeof p === 'string' && exists(p); const fd = real.openSync(p, f, ...x); if (/[wax+]/.test(String(f))) touch(String(p), !had); return fd; };
fs.writeFileSync = (p, ...x) => { if (counted(p) && ++calls === killAt) process.kill(process.pid, 'SIGKILL'); const had = typeof p === 'string' && exists(p); real.writeFileSync(p, ...x); if (typeof p === 'string') touch(p, !had); };
fs.mkdirSync = (p, ...x) => { if (counted(p) && ++calls === killAt) process.kill(process.pid, 'SIGKILL'); const had = exists(p); const out = real.mkdirSync(p, ...x); if (!had) touch(String(p), true); return out; };
fs.renameSync = (s, d) => { if (++calls === killAt) process.kill(process.pid, 'SIGKILL'); const had = exists(d); real.renameSync(s, d); gone(String(s)); touch(String(d), !had); };
fs.linkSync = (s, d) => { if (role === 'nolink') throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); if (++calls === killAt) process.kill(process.pid, 'SIGKILL'); real.linkSync(s, d); touch(String(d), true); };
for (const fn of ['rmSync', 'unlinkSync', 'rmdirSync']) fs[fn] = (p, ...x) => { if (counted(p) && ++calls === killAt) process.kill(process.pid, 'SIGKILL'); const had = exists(p); real[fn](p, ...x); if (had) gone(String(p)); };
const beginEffect = () => { effect = new Map(); };
const endEffect = () => { const out = [...effect].map(([p, k]) => (k === 'deleted' ? '-' : '') + p.slice(dir.length + 1)); effect = null; return out; };
`;

// Deadlines are fail-safes, not part of any assertion: a process gives up after PROCESS_DEADLINE_MS with
// diagnostics (exit 3); a round after ROUND_DEADLINE_MS kills its processes and fails with diagnostics.
// STATE_HARNESS_DEADLINE_MS overrides the process deadline (the round's is one minute longer).
const PROCESS_DEADLINE_MS = Number(process.env.STATE_HARNESS_DEADLINE_MS ?? 240000);
const ROUND_DEADLINE_MS = PROCESS_DEADLINE_MS + 60000;
// Operations per worker: round A; round B before the upgrade (then 3 more after it).
const OPS_A = 12;
const OPS_B = 6;

// One process of a round. Roles: worker (counted updates), nolink (link(2) unsupported), crasher (killed at a
// random mutating call; stops with exit 4 at a dead process's lock, which only the unlock after the round
// removes), bumper (the newer plugin: upgrades the store after some round B work).
const PROCESS = (kindsUrl, dir, logs, seed, role, me, round) => `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { current, newer, state } = await import(${JSON.stringify(kindsUrl)});
let a = ${seed} >>> 0;
const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const sleep = new Int32Array(new SharedArrayBuffer(4));
const LOGS = ${JSON.stringify(logs)};
const round = ${JSON.stringify(round)};
const log = (rec) => fs.appendFileSync(LOGS + '/${me}.jsonl', JSON.stringify({ ...rec, round }) + '\\n');
const dir = ${JSON.stringify(dir)};
const bumped = LOGS + '/bumped';
const role = ${JSON.stringify(role)};
// Every wait of this process is bounded: past its deadline it prints what it was doing, the store lock's owner
// and that owner's process state (ps), and exits 3, which fails the seed with these diagnostics. The deadline is
// on the monotonic clock (wall-clock adjustments do not move it; a system sleep still counts, as for every timer).
const DEADLINE = performance.now() + ${PROCESS_DEADLINE_MS};
const { spawnSync } = await import('node:child_process');
const expired = (what) => {
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(dir + '/local/lock/owner.json', 'utf8')); } catch {}
  const ps = owner ? spawnSync('ps', ['-o', 'pid=,stat=,lstart=,command=', '-p', String(owner.pid)], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } }).stdout.trim() : '';
  process.stderr.write(JSON.stringify({ deadline: role, me: ${JSON.stringify(me)}, round, pid: process.pid, what, lockOwner: owner, ownerProcess: ps || 'not running' }) + '\\n');
  process.exit(3);
};
const waitUntil = (what, cond) => { while (!cond()) { if (performance.now() > DEADLINE) expired(what); Atomics.wait(sleep, 0, 0, 5); } };
// Progress of this round: the operations a process logged in it.
const lines = (who) => { try { return fs.readFileSync(LOGS + '/' + who + '.jsonl', 'utf8').split('\\n').filter((l) => l.endsWith('"round":"' + round + '"}')).length; } catch { return 0; } };
waitUntil('waiting for go', () => fs.existsSync(LOGS + '/go-' + round));
${RECORDER}syncBuiltinESMExports();
if (role === 'bumper') {
  // Upgrade after progress, not after time: every round B process has logged an operation and \`target\` are logged.
  const others = ['w0', 'w1', 'w2', 'w3', 'n1'];
  const target = 5 + Math.floor(rand() * 16);
  waitUntil('waiting for progress before the upgrade', () => others.every((w) => lines(w) >= 1) && others.reduce((n, w) => n + lines(w), 0) >= target);
  let r;
  for (;;) {
    try { r = state.migrate(newer(dir, { lockTimeoutMs: 20000 })); break; } catch (e) {
      if (e.code !== 'locked') throw e;
      if (performance.now() > DEADLINE) expired('upgrading: locked');
    }
  }
  fs.writeFileSync(bumped, '');
  log({ op: 'bump', ok: true, steps: r.steps.length });
  process.exit(0);
}
// The crashers start after the forced first operations of round A (below), so a crash never hides them.
if (role === 'crasher') waitUntil('waiting for the forced first operations', () => ['w0', 'w1', 'w2', 'w3'].every((w) => lines(w) >= 3) && lines('n1') >= 1);
const handle = ${JSON.stringify(me)}.endsWith('0') || ${JSON.stringify(me)}.endsWith('2') ? 'AB' : 'CD';
const myTask = 'T-' + handle + '-1000';
const task = (id, title) => ({ id, kind: 'task', title, lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null });
const ops = role === 'worker' ? ['item', 'item', 'event', 'allocate', 'allocate', 'retire', 'migrate', 'read', 'create']
  : role === 'nolink' ? ['allocate', 'create', 'retire', 'read'] : ['allocate', 'allocate', 'migrate', 'read', 'create', 'item-ro'];
const mine = [];
let afterOps = 0;
// Round A: OPS_A operations (a crasher: until it is killed). Round B: OPS_B operations, then a wait for the
// upgrade, then 3 more: how many operations run, and that some meet the upgraded store, does not depend on speed.
const OPS = round === 'A' ? ${OPS_A} : ${OPS_B};
for (let i = 0; role === 'crasher' ? i < 400 : (i < OPS || (round === 'B' && afterOps < 3)); i++) {
  if (performance.now() > DEADLINE) expired('operation ' + i + ' not started');
  if (round === 'B' && i >= OPS) waitUntil('waiting for the upgrade after ' + OPS + ' operations', () => fs.existsSync(bumped));
  const s = current(dir, { lockTimeoutMs: 20000 });
  const after = round === 'B' && fs.existsSync(bumped);
  // Coverage that does not depend on chance: in round A a worker starts with a migration, an item update and an
  // allocation, the no-link worker with an allocation; the first operation after the upgrade is a write.
  const first = round === 'A' ? ({ worker: ['migrate', 'item', 'allocate'], nolink: ['allocate'] }[role] ?? []) : [];
  const op = i < first.length ? first[i] : after && afterOps === 0 ? (role === 'nolink' ? 'allocate' : 'item') : pick(ops);
  if (after) afterOps++;
  const rec = { op, after, i };
  const arg = op === 'item' || op === 'item-ro' ? pick(${JSON.stringify(ITEMS)}) : op === 'retire' ? (role === 'nolink' ? 'T-' + handle + '-999000' : mine.shift()) : op === 'create' ? pick(['EF', 'GH', 'IJ']) : null;
  const attempt = () => {
    if (op === 'item') { s.update('item', arg, (d) => ({ ...d, n: d.n + 1 })); rec.id = arg; }
    else if (op === 'item-ro') s.update('item', arg, () => undefined);
    else if (op === 'event') { s.update('task', myTask, (d) => ({ ...d, events: [...d.events, { at: '${AT}', by: handle, event: 'tick', data: { i } }] })); rec.id = myTask; }
    else if (op === 'allocate') { rec.id = state.allocateId(s, { prefix: 'T', handle, build: (id) => task(id, ${JSON.stringify(me)}) }); mine.push(rec.id); }
    else if (op === 'retire') {
      if (arg) { rec.created = state.retireId(s, arg, { by: handle, reason: 'harness', at: '${AT}' }); if (role !== 'nolink') real.rmSync(dir + '/tasks/' + arg, { recursive: true, force: true }); rec.id = arg; } else rec.skip = true;
    } else if (op === 'migrate') rec.steps = state.migrate(s).steps.length;
    else if (op === 'create') { rec.id = arg; rec.created = s.create('team', arg, { handle: arg, emailSha256: '${'e'.repeat(64)}', addedAt: '${AT}' }); }
    else { s.list('task').slice(0, 5).forEach((id) => s.read('task', id)); s.read('item', pick(${JSON.stringify(ITEMS)})); }
  };
  // A lock wait that times out (locked: a slow holder under load) is tried again, bounded by the deadline. The
  // net effect excludes the lock directory and its copies; every refusal must have had none.
  for (let tries = 0; ; tries++) {
    beginEffect();
    try { attempt(); rec.ok = true; delete rec.code; } catch (e) { rec.ok = false; rec.code = e.code; rec.message = String(e.message).slice(0, 200); }
    const eff = endEffect().filter((p) => !/^-?local(\\/lock([./].*)?)?$/.test(p) && !(op === 'retire' && /^-?tasks\\//.test(p)));
    if (!rec.ok && rec.code === 'locked') {
      if (eff.length) rec.lockedEffect = [...(rec.lockedEffect ?? []), ...eff];
      if (performance.now() > DEADLINE) expired('operation ' + i + ' ' + op + ': still locked');
      Atomics.wait(sleep, 0, 0, 10);
      continue;
    }
    rec.effect = eff;
    if (tries) rec.retries = tries;
    break;
  }
  log(rec);
  // A dead process's lock refuses every write (stale-lock) until the unlock after the round: a crasher stops.
  if (role === 'crasher' && rec.code === 'stale-lock') process.exit(4);
}
`;

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const TEMP = /^\.(.+)\.(\d+)\.[0-9a-f]{8}\.tmp$/;
// Every directory and file under dir, relative.
// Entries can vanish while other processes run: a vanished one is skipped.
const entriesOf = (d, rel = '') => {
  let names;
  try { names = readdirSync(d); } catch { return []; }
  return names.flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(join(d, n), { throwIfNoEntry: false });
    if (!st) return [];
    return st.isDirectory() ? [r, ...entriesOf(join(d, n), r)] : [r];
  });
};
// What a process with this pid left in the store: temporary files, the lock it held, its prepared, released or
// set-aside lock directories. Checked after its round, when every process has exited: a clean exit leaves none.
function cleanExitLeftovers(dir, pid) {
  return entriesOf(dir).filter((rel) => {
    const name = rel.split('/').at(-1);
    const temp = TEMP.exec(name);
    if (temp) return Number(temp[2]) === pid;
    const lockCopy = /^lock\.(?:new|unlock|released)-(\d+)[-.]/.exec(name);
    if (lockCopy) return Number(lockCopy[1]) === pid;
    if (rel === 'local/lock') { try { return JSON.parse(readFileSync(join(dir, rel, 'owner.json'), 'utf8')).pid === pid; } catch { return false; } }
    return false;
  });
}

async function runSeed(t, seed) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-harness-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo', names.stateDir);
  const logs = join(base, 'logs');
  mkdirSync(logs);
  mkdirSync(join(base, 'home'));
  const put = (rel, v) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), typeof v === 'string' ? v : json(v)); };
  put('state.json', { schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  for (const h of ['AB', 'CD']) put(`team/${h}.json`, { schema: KINDS.team.version, handle: h, emailSha256: state.emailHash(`${h}@example.com`), addedAt: AT });
  for (const id of ITEMS) put(`items/${id}.json`, { schema: 1, id, n: 0 });
  for (const id of ['T-AB-1000', 'T-CD-1000']) put(`tasks/${id}/task.json`, { schema: KINDS.task.version, id, kind: 'task', title: 'counter', lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null });
  const kindsFile = join(base, 'kinds.mjs');
  writeFileSync(kindsFile, KINDS_MODULE);
  const kindsUrl = pathToFileURL(kindsFile).href;
  const { current, newer } = await import(kindsUrl);
  const label = `seed ${seed}`;
  const LABELS = ['w0', 'w1', 'w2', 'w3', 'n1', 'c0', 'c1', 'b'];

  const children = new Set();
  t.after(() => { for (const c of children) c.kill('SIGKILL'); });
  // One round: its processes start together; a crasher slot runs 2 incarnations one after the other. Returns
  // every process's exit once all have exited (the round's deadline fails with diagnostics instead).
  const runRound = async (round, roles) => {
    const run = (me, role, k) => new Promise((res) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', PROCESS(kindsUrl, dir, logs, seed + k * 7919 + (round === 'B' ? 104729 : 0), role, me, round)], { env: { ...ISO.env, PATH: process.env.PATH, HOME: join(base, 'home'), LANG: 'C' }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      children.add(c);
      c.on('exit', (status, signal) => { children.delete(c); res({ me, role, round, status, signal, err, pid: c.pid }); });
    });
    const slot = async (me, role, k) => {
      const out = [];
      for (let n = 0; n < (role === 'crasher' ? 2 : 1); n++) out.push(await run(me, role, k + n * 101));
      return out;
    };
    const exits = Promise.all(roles.map(([me, role], k) => slot(me, role, k)));
    writeFileSync(join(logs, `go-${round}`), '');
    let timer;
    const timedOut = new Promise((res) => { timer = setTimeout(() => res('timeout'), ROUND_DEADLINE_MS); });
    const finished = await Promise.race([exits, timedOut]);
    clearTimeout(timer);
    if (finished === 'timeout') {
      const tails = Object.fromEntries(LABELS.map((me) => [me, readLog(join(logs, `${me}.jsonl`)).slice(-2)]));
      let owner = null;
      try { owner = JSON.parse(readFileSync(join(dir, 'local', 'lock', 'owner.json'), 'utf8')); } catch {}
      const ps = spawnSync('ps', ['-o', 'pid=,stat=,etime=,lstart=', '-p', [...children].map((c) => c.pid).concat(owner ? [owner.pid] : []).join(',') || '1'], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } }).stdout;
      for (const c of children) c.kill('SIGKILL');
      assert.fail(`${label}: round ${round}: no result after ${ROUND_DEADLINE_MS} ms\nlock owner: ${JSON.stringify(owner)}\nprocesses:\n${ps}\nlast log lines: ${JSON.stringify(tails)}`);
    }
    // After the round every process has exited: what is in the store now is final, and each artifact is
    // attributed by the pid in its name or owner record. A clean exit (a stopped crasher's too) leaves nothing.
    const results = finished.flat();
    for (const r of results) {
      if (r.role === 'crasher') assert.ok(r.signal === 'SIGKILL' || r.status === 4, `${label}: ${r.me} was neither killed nor stopped at a dead process's lock (${r.status}) ${r.err}`);
      else assert.equal(r.status, 0, `${label}: ${r.me}: ${r.err}`);
      if (r.signal === null) assert.deepEqual(cleanExitLeftovers(dir, r.pid), [], `${label}: round ${round}: ${r.me} (pid ${r.pid}) exited cleanly but left temporary files or locks`);
    }
    return results;
  };

  // Round A: concurrent writers and crashers.
  const resultsA = await runRound('A', [['w0', 'worker'], ['w1', 'worker'], ['w2', 'worker'], ['w3', 'worker'], ['n1', 'nolink'], ['c0', 'crasher'], ['c1', 'crasher']]);
  const killed = new Set(resultsA.filter((r) => r.signal === 'SIGKILL').map((r) => r.pid));
  assert.ok(killed.size > 0, `${label}: no crasher was killed`);
  // 6. The quiescent window: a crash leaves at most a lock whose owner is dead; no writer takes it over; the
  // explicit unlock removes it and what killed processes left next to it; then nothing of the lock is left.
  const lockDir = join(dir, 'local', 'lock');
  const stale = existsSync(lockDir);
  if (stale) {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.ok(killed.has(owner.pid), `${label}: the lock left after round A belongs to pid ${owner.pid}, which was not killed`);
    assert.throws(() => current(dir).write('team', 'ZY', { handle: 'ZY', emailSha256: 'f'.repeat(64), addedAt: AT }), (e) => e.code === 'stale-lock', `${label}: a dead owner's lock is not taken over`);
  }
  assert.equal(state.unlockStale(current(dir), { quietMs: 50 }).removed, stale, `${label}: the explicit unlock removes the dead owner's lock`);
  current(dir).write('team', 'ZZ', { handle: 'ZZ', emailSha256: 'f'.repeat(64), addedAt: AT });
  const localNow = () => readdirSync(join(dir, 'local')).filter((n) => !['ids', 'backup'].includes(n));
  assert.deepEqual(localNow(), [], `${label}: local/ holds only ids/ and backup/ after the explicit unlock`);
  const walkAll = (d, rel = '') => readdirSync(d).flatMap((n) => { const r = rel ? `${rel}/${n}` : n; return lstatSync(join(d, n)).isDirectory() ? walkAll(join(d, n), r) : [r]; });
  for (const rel of walkAll(dir)) {
    const m = TEMP.exec(rel.split('/').at(-1));
    if (m) assert.ok(killed.has(Number(m[2])), `${label}: temporary file of a process that was not killed: ${rel}`);
  }

  // Round B: writers while the newer plugin upgrades the store; nothing is killed, so nothing is left locked.
  const resultsB = await runRound('B', [['w0', 'worker'], ['w1', 'worker'], ['w2', 'worker'], ['w3', 'worker'], ['n1', 'nolink'], ['b', 'bumper']]);
  assert.ok(!existsSync(lockDir), `${label}: a lock is left after round B`);
  assert.deepEqual(localNow(), [], `${label}: local/ holds only ids/ and backup/ after round B`);

  const logOf = Object.fromEntries(LABELS.map((me) => [me, readLog(join(logs, `${me}.jsonl`))]));
  const all = Object.values(logOf).flat();

  // 1. Every state file parses and validates (counters included); none is empty.
  const s = newer(dir);
  let files = 0;
  for (const rel of walkAll(dir)) {
    if (rel.split('/').at(-1).startsWith('.') || /^local\/(backup|lock)/.test(rel)) continue;
    assert.ok(statSync(join(dir, rel)).size > 0, `${label}: ${rel} is empty`);
    const kind = Object.values(s.kinds).find((k) => k.match.test(rel));
    assert.ok(kind, `${label}: unexpected file ${rel}`);
    assert.doesNotThrow(() => s.read(kind.name, kind.match.exec(rel)[1] ?? null), `${label}: ${rel} unreadable`);
    files++;
  }
  assert.ok(files > 10, `${label}: files checked (${files})`);

  // 2. IDs, tombstones, high-water marks.
  const allocated = all.filter((r) => r.op === 'allocate' && r.ok).map((r) => r.id);
  assert.equal(new Set(allocated).size, allocated.length, `${label}: duplicate IDs ${allocated}`);
  const retired = new Set(all.filter((r) => r.op === 'retire' && r.ok && r.id && !r.id.endsWith('-999000')).map((r) => r.id));
  for (const id of allocated) assert.ok(existsSync(join(dir, 'tasks', id, 'task.json')) || retired.has(id), `${label}: ${id} was returned but is missing`);
  for (const id of retired) assert.ok(existsSync(join(dir, 'tombstones', `${id}.json`)), `${label}: ${id} retired without tombstone`);
  for (const tomb of s.list('tombstone')) assert.ok(!existsSync(join(dir, 'tasks', tomb, 'task.json')), `${label}: object ${tomb} exists next to its tombstone`);
  for (const h of ['AB', 'CD']) {
    const top = Math.max(0, ...allocated.filter((id) => id.startsWith(`T-${h}-`)).map((id) => Number(id.split('-')[2])));
    if (top) assert.ok((s.read('counter', `T-${h}`)?.high ?? 0) >= top, `${label}: the T-${h} high-water mark is below ${top}`);
  }

  // 3. Nothing written by an operation that started after the upgrade.
  assert.ok(logOf.b.some((r) => r.op === 'bump'), `${label}: the newer plugin upgraded the store`);
  const writes = ['item', 'item-ro', 'event', 'allocate', 'retire', 'create', 'migrate'];
  for (const [me, recs] of Object.entries(logOf)) {
    for (const r of recs.filter((x) => x.after && writes.includes(x.op) && !x.skip)) {
      assert.equal(r.ok, false, `${label}: ${me} op ${r.i} ${r.op} wrote after the upgrade`);
      assert.equal(r.code, 'schema-newer', `${label}: ${me} op ${r.i} ${r.op} after the upgrade: ${r.code} ${r.message}`);
    }
    for (const r of recs.filter((x) => x.ok === false)) assert.deepEqual(r.effect, [], `${label}: ${me} round ${r.round} op ${r.i} ${r.op} refused (${r.code}) but left ${r.effect}`);
    for (const r of recs.filter((x) => x.lockedEffect)) assert.fail(`${label}: ${me} op ${r.i} ${r.op}: a lock timeout left ${r.lockedEffect}`);
  }

  // 4. Without hard links nothing is created: a creation refuses (an existing target is simply not created).
  for (const r of logOf.n1.filter((x) => ['allocate', 'create', 'retire'].includes(x.op))) {
    if (r.ok) assert.ok(r.op !== 'allocate' && r.created === false, `${label}: n1 ${r.op} created ${r.id} without hard links`);
    else assert.ok(['fs-unsupported', 'schema-newer', 'stale-lock'].includes(r.code), `${label}: n1 ${r.op}: ${r.code} ${r.message}`);
  }
  assert.ok(logOf.n1.some((r) => r.code === 'fs-unsupported'), `${label}: the no-link path was exercised`);

  // 5. No lost update.
  const workers = ['w0', 'w1', 'w2', 'w3'].flatMap((w) => logOf[w]);
  for (const id of ITEMS) assert.equal(current(dir).read('item', id).n, workers.filter((r) => r.op === 'item' && r.ok && r.id === id).length, `${label}: item ${id}`);
  for (const id of ['T-AB-1000', 'T-CD-1000']) assert.equal(s.read('task', id).events.length, workers.filter((r) => r.op === 'event' && r.ok && r.id === id).length, `${label}: task ${id}`);

  // 7. Only the refusals expected in each round; the run exercised what it claims.
  const expected = { A: ['stale-lock'], B: ['schema-newer'] };
  assert.deepEqual(all.filter((r) => r.ok === false && !(expected[r.round].includes(r.code) || r.code === 'fs-unsupported')).map((r) => `${r.round} ${r.op}: ${r.code} ${r.message}`), [], `${label}: unexpected failures`);
  for (const op of ['item', 'allocate', 'migrate']) assert.ok(all.some((r) => r.op === op && r.ok), `${label}: some ${op} succeeded`);
  assert.ok(all.some((r) => r.after && r.code === 'schema-newer'), `${label}: some operation met the upgraded store`);
  const count = (f) => all.filter(f).length;
  t.diagnostic(`${label}: ${all.length} operations, ${count((r) => r.ok)} succeeded, ${count((r) => r.after)} after the upgrade, ${allocated.length} IDs, ${retired.size} retired, ${killed.size} kills, ${stale ? 1 : 0} explicit unlocks, ${count((r) => r.code === 'stale-lock')} stale-lock refusals, ${resultsA.length + resultsB.length} processes`);
}

const FIRST = Number(process.env.STATE_HARNESS_SEED ?? 0x5EED);
const SEEDS = Number(process.env.STATE_HARNESS_SEEDS ?? 30);
// A ceiling only (a hang fails with the round's diagnostics long before): one minute per seed, at least 15.
test(`harness: ${SEEDS} seeds of concurrent operations, crashes and a schema upgrade keep every guarantee`, { timeout: Math.max(900000, SEEDS * 60000) }, async (t) => {
  for (let k = 0; k < SEEDS; k++) await t.test(`seed ${FIRST + k}`, (st) => runSeed(st, FIRST + k));
});

// ---- Self-checks of the harness (review round 3, item 3) ----
const selfCheck = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-harness-self-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'store');
  mkdirSync(join(dir, 'local'), { recursive: true });
  return { base, dir, run: (code) => spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const dir = ${JSON.stringify(dir)}; const LOGS = ${JSON.stringify(join(base, 'logs'))}; const role = 'worker'; const rand = Math.random;
${RECORDER}
syncBuiltinESMExports();
${code}`], { encoding: 'utf8', env: { ...ISO.env, HOME: join(base, 'home') } }) };
};

test('harness recorder: a deletion of an existing file is an effect, like a write', (t) => {
  const { dir, run } = selfCheck(t);
  writeFileSync(join(dir, 'kept.json'), '{}');
  mkdirSync(join(dir, 'local', 'backup', 'b1'), { recursive: true });
  writeFileSync(join(dir, 'local', 'backup', 'b1', 'x.json'), '{}');
  const r = run(`beginEffect(); fs.rmSync(dir + '/kept.json'); fs.rmSync(dir + '/local/backup', { recursive: true }); fs.writeFileSync(dir + '/new.json', '{}'); fs.writeFileSync(dir + '/tmp.json', '{}'); fs.rmSync(dir + '/tmp.json');
process.stdout.write(JSON.stringify(endEffect().sort()));`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['-kept.json', '-local/backup', 'new.json'], 'deletions of existing paths are recorded; a file written and removed again is not');
});

test('harness: a temporary file or lock artifact left by a cleanly exited process is reported', (t) => {
  const { dir, run } = selfCheck(t);
  const r = run(`fs.writeFileSync(dir + '/.t.json.' + process.pid + '.abcdef12.tmp', 'x'); fs.mkdirSync(dir + '/local/lock.new-' + process.pid + '-' + process.pid + '.0123456789abcdef'); process.stdout.write(String(process.pid));`);
  assert.equal(r.status, 0, r.stderr);
  const pid = Number(r.stdout);
  assert.deepEqual(cleanExitLeftovers(dir, pid).sort(), [`.t.json.${pid}.abcdef12.tmp`, `local/lock.new-${pid}-${pid}.0123456789abcdef`]);
  assert.deepEqual(cleanExitLeftovers(dir, pid + 1), [], 'another process left nothing');
});
