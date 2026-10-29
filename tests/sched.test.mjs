// Resource scheduler (spec §7.8, addendum §7.8a, U12, U13, SC16 slot part, N7): calibration, leases with port
// blocks and test-DB names, FIFO tickets for the exclusive kinds (heavy, e2e), admission in shadow mode, the
// orphan reaper and the supervised run with a hard time limit and a no-output limit.
// Liveness of a lease holder is its identity: pid, start time and the method that read it, never the pid alone
// (lesson I2.1); an unknown identity is never dead (findings r1 3, 4).
// Races run in separate processes against one machine data directory; every wait has a deadline. Interleavings are
// set up deterministically (signal files between processes, injected process tables and readings), never by loading
// the machine (addendum 12): no busy loop, and pollers wait between attempts. Readings (load, memory) are injected
// wherever a test runs admission. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// No test here touches the real HOME; git and every child get a throwaway environment (S1).
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const SCHED_URL = pathToFileURL(join(pluginDir, 'lib', 'sched', 'index.mjs')).href;
const sched = await import(SCHED_URL);
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);
const { EXIT } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
// A process identity { pid, start, method } as the scheduler records it (findings r1 3, 4); OLD is a start no running
// process has, read by the same method as this machine's.
const idOf = (pid) => { const { start, method } = sched.identify([pid]).get(pid); return { pid, start: start ?? null, method: method ?? null }; };
const ME = idOf(process.pid);
const OLD = '978307200';
const oldId = (pid) => ({ pid, start: OLD, method: ME.method });
// Calm readings: admission passes; tests that assert admission inject their own.
const CALM = Object.freeze({ cores: 10, load1: 1, loadMeasurable: true, totalBytes: 32 * 2 ** 30, availBytes: 20 * 2 ** 30, memMethod: 'vm_stat' });

function sandbox(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sched-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const data = join(base, 'data');
  const env = { ...ISO.env, CLAUDE_PLUGIN_DATA: data };
  const dir = (name) => { const d = join(base, name); mkdirSync(d, { recursive: true }); return d; };
  const ctx = (extra = {}) => ({ names, env, cwd: dir('wt-a'), readings: CALM, ...extra });
  return { base, data, env, dir, ctx };
}
const leaseFiles = (data) => (existsSync(join(data, 'leases')) ? readdirSync(join(data, 'leases')).filter((f) => f.endsWith('.json')).sort() : []);
const leaseDoc = (data, key) => JSON.parse(readFileSync(join(data, 'leases', `${key}.json`), 'utf8'));
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const hash = (s, n) => createHash('sha256').update(s).digest('hex').slice(0, n);
function plantLease(data, key, fields = {}) {
  const [kind, slot] = key.split('-');
  mkdirSync(join(data, 'leases'), { recursive: true });
  const doc = {
    schema: 1, id: '0123456789abcdef', kind, slot: Number(slot), owner: ME,
    project: '/tmp', task: null, ports: [41000, 41009], db: 'x_000000_1', at: iso(), heartbeatAt: iso(), ttlS: 3600, child: null, ...fields,
  };
  writeFileSync(join(data, 'leases', `${key}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

// ---- calibration (spec §7.8, U12, §7.8a) ----

test('calibration on this machine: cores, RAM, platform memory method; LOAD_MAX 1.7 × cores, FREE_MIN 30%, per-kind max', (t) => {
  const s = sandbox(t);
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const cal = sched.calibrate({ names, env: s.env });
  assert.equal(cal.cores, cores);
  assert.equal(cal.totalMemBytes, os.totalmem());
  assert.equal(cal.loadMax, (Math.round(17 * cores) / 10).toFixed(1));
  assert.equal(cal.freeMinPct, 30);
  assert.deepEqual(cal.max, { agent: 3, external: 2, e2e: 1, heavy: 1 });
  assert.equal(cal.memMethod, { darwin: 'vm_stat', linux: 'meminfo' }[process.platform] ?? 'freemem');
  assert.equal(cal.loadMeasurable, process.platform !== 'win32');
  const saved = JSON.parse(readFileSync(join(s.data, 'calibration.json'), 'utf8'));
  assert.equal(saved.schema, 1);
  assert.equal(saved.loadMax, cal.loadMax);
  const r = sched.readings();
  assert.ok(r.availBytes > 0 && r.availBytes <= r.totalBytes, 'available memory within RAM');
  assert.ok(r.freePct >= 0 && r.freePct <= 100);
  t.diagnostic(`this machine: ${cal.cores} cores, ${(cal.totalMemBytes / 2 ** 30).toFixed(0)} GB, memory via ${cal.memMethod}, load max ${cal.loadMax}, now load ${r.load1}, free ${r.freePct}%`);
});

test('U12: available memory is the larger of os.freemem() and the platform reading (vm_stat, /proc/meminfo)', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\n'
    + 'Pages inactive:                           2000.\nPages speculative:                         500.\nPages wired down:                         100.\n';
  assert.equal(sched.parseVmStat(vm), (1000 + 2000 + 500) * 16384);
  assert.equal(sched.parseVmStat('Pages free: 12.\n'), null, 'no page size: unreadable');
  assert.equal(sched.parseMeminfo('MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   20000000 kB\n'), 20000000 * 1024);
  assert.equal(sched.parseMeminfo('MemTotal: 1 kB\n'), null);
  assert.equal(sched.availableBytes(100, 300, 1000), 300, 'platform reading larger');
  assert.equal(sched.availableBytes(500, 300, 1000), 500, 'freemem larger');
  assert.equal(sched.availableBytes(500, null, 1000), 500, 'no platform reading');
  assert.equal(sched.availableBytes(500, 5000, 1000), 1000, 'never above RAM');
});

test('§7.8a: calibration refuses FREE_MIN=0 always and LOAD_MAX=off unless load is unmeasurable; a refusal writes nothing', (t) => {
  const s = sandbox(t);
  const refused = (opts, code) => assert.throws(() => sched.calibrate({ names, env: s.env, ...opts }), (e) => e.code === code && e.exit === 'USAGE', JSON.stringify(opts));
  refused({ freeMin: 0 }, 'memory-check-required');
  refused({ freeMin: 0, readings: { ...CALM, loadMeasurable: false, load1: null } }, 'memory-check-required');
  refused({ loadMax: 'off' }, 'load-check-required');
  refused({ loadMax: '0' }, 'invalid-value');
  refused({ freeMin: 96 }, 'invalid-value');
  refused({ max: { heavy: 0 } }, 'invalid-value');
  refused({ max: { gpu: 1 } }, 'invalid-value');
  assert.equal(existsSync(s.data), false, 'nothing written by a refusal');
  const off = sched.calibrate({ names, env: s.env, loadMax: 'off', readings: { ...CALM, loadMeasurable: false, load1: null } });
  assert.equal(off.loadMax, 'off');
  const unmeasured = sched.calibrate({ names, env: s.env, readings: { ...CALM, loadMeasurable: false, load1: null } });
  assert.equal(unmeasured.loadMax, 'off', 'unmeasurable load: the load check is off by itself');
  const set = sched.calibrate({ names, env: s.env, loadMax: '12.5', freeMin: 25, max: { heavy: 2 } });
  assert.equal(set.loadMax, '12.5');
  assert.equal(set.freeMinPct, 25);
  assert.equal(set.max.heavy, 2);
  assert.deepEqual(set.overrides, { loadMax: '12.5', freeMinPct: 25, max: { heavy: 2 } });
});

test('calibration on first use and monthly: an acquire writes it when missing or older than 30 days, keeping overrides', (t) => {
  const s = sandbox(t);
  const first = sched.acquire('heavy', s.ctx());
  assert.equal(first.ok, true);
  const cal = JSON.parse(readFileSync(join(s.data, 'calibration.json'), 'utf8'));
  assert.equal(cal.cores, CALM.cores, 'first use calibrates from the readings');
  sched.release(first.lease, s.ctx());
  // A month-old calibration with an override: recalibrated, override kept.
  writeFileSync(join(s.data, 'calibration.json'), `${JSON.stringify({ ...cal, at: iso(31 * 86400e3), cores: 4, max: { ...cal.max, heavy: 2 }, overrides: { max: { heavy: 2 } } }, null, 2)}\n`);
  const again = sched.acquire('heavy', s.ctx());
  sched.release(again.lease, s.ctx());
  const fresh = JSON.parse(readFileSync(join(s.data, 'calibration.json'), 'utf8'));
  assert.equal(fresh.cores, CALM.cores);
  assert.equal(fresh.max.heavy, 2);
  assert.ok(Date.now() - Date.parse(fresh.at) < 60e3);
  // A recent one is left as it is.
  const text = readFileSync(join(s.data, 'calibration.json'), 'utf8');
  sched.release(sched.acquire('heavy', s.ctx()).lease, s.ctx());
  assert.equal(readFileSync(join(s.data, 'calibration.json'), 'utf8'), text);
});

// ---- leases (spec §7.8, §5.3) ----

test('a lease carries a port block [41000 + 10·k, +9] and a test-DB name; blocks of all kinds are disjoint; env is injected', (t) => {
  const s = sandbox(t);
  const got = {};
  for (const kind of ['agent', 'external', 'e2e', 'heavy']) {
    const r = sched.acquire(kind, s.ctx({ cwd: s.dir(`wt-${kind}`), task: 'T-AB-1' }));
    assert.equal(r.ok, true, kind);
    got[kind] = r;
  }
  const blocks = Object.values(got).map((r) => r.lease.ports);
  for (const [lo, hi] of blocks) {
    assert.equal(hi, lo + 9);
    assert.equal((lo - 41000) % 10, 0);
  }
  assert.equal(new Set(blocks.map(([lo]) => lo)).size, 4, 'disjoint port blocks');
  const second = sched.acquire('agent', s.ctx({ cwd: s.dir('wt-agent-2') }));
  assert.notDeepEqual(second.lease.ports, got.agent.lease.ports);
  const db = new RegExp(`^${names.codename.replace(/-/g, '_')}_[0-9a-f]{6}_\\d+$`);
  for (const r of Object.values(got)) assert.match(r.lease.db, db);
  const project = realpathSync(s.dir('wt-heavy'));
  assert.ok(got.heavy.lease.db.includes(`_${hash(project, 6)}_`), 'DB name keyed by the project hash');
  const env = got.heavy.env;
  assert.equal(env[`${names.envPrefix}PORT_BASE`], String(got.heavy.lease.ports[0]));
  assert.equal(env[`${names.envPrefix}PORT_MAX`], String(got.heavy.lease.ports[1]));
  assert.equal(env[`${names.envPrefix}DB_NAME`], got.heavy.lease.db);
  assert.equal(env[`${names.envPrefix}SLOT`], 'heavy-1');
  assert.deepEqual(leaseFiles(s.data), ['agent-1.json', 'agent-2.json', 'e2e-1.json', 'external-1.json', 'heavy-1.json']);
  const doc = leaseDoc(s.data, 'heavy-1');
  assert.equal(doc.task, 'T-AB-1');
  assert.equal(doc.owner.pid, process.pid);
  assert.deepEqual(doc.owner, ME, 'the holder is recorded with its identity');
  assert.equal(doc.project, project);
});

test('per-kind max: the 4th agent and (SC16, external max 1) the second external run wait with reasons; release frees the slot', (t) => {
  const s = sandbox(t);
  const leases = [1, 2, 3].map((n) => sched.acquire('agent', s.ctx({ cwd: s.dir(`a${n}`) })));
  assert.ok(leases.every((r) => r.ok));
  const fourth = sched.acquire('agent', s.ctx());
  assert.equal(fourth.ok, false);
  assert.deepEqual(fourth.reasons.map((r) => r.code), ['capacity']);
  assert.match(fourth.reasons[0].message, /agent 3\/3/);
  sched.release(leases[1].lease, s.ctx());
  const now = sched.acquire('agent', s.ctx());
  assert.equal(now.ok, true);
  assert.equal(now.lease.slot, 2, 'the freed slot');
  sched.calibrate({ names, env: s.env, readings: CALM, max: { external: 1 } });
  assert.equal(sched.acquire('external', s.ctx({ task: 'T-AB-2' })).ok, true);
  const queued = sched.acquire('external', s.ctx({ task: 'T-AB-3' }));
  assert.equal(queued.ok, false);
  assert.match(queued.reasons[0].message, /external 1\/1/);
});

test('release removes only its own lease: a lease replaced meanwhile (another id) stays', (t) => {
  const s = sandbox(t);
  const r = sched.acquire('heavy', s.ctx());
  assert.equal(sched.release(r.lease, s.ctx()), true);
  assert.equal(sched.release(r.lease, s.ctx()), false, 'twice: nothing to do');
  const other = sched.acquire('heavy', s.ctx());
  assert.equal(sched.release({ ...r.lease }, s.ctx()), false, 'stale handle of the same slot');
  assert.deepEqual(leaseFiles(s.data), ['heavy-1.json']);
  assert.equal(sched.release(other.lease, s.ctx()), true);
});

test('liveness is pid + start time: a live pid with another start time (reused pid) is a gone holder; pid alone would keep it', (t) => {
  const s = sandbox(t);
  assert.equal(typeof ME.start, 'string');
  assert.ok(['ps', 'proc'].includes(ME.method));
  assert.deepEqual(idOf(process.pid), ME, 'stable');
  assert.equal(sched.identify([deadPid()]).values().next().value.state, 'gone');
  plantLease(s.data, 'heavy-1', { owner: oldId(process.pid) });
  const r = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-b') }));
  assert.equal(r.ok, true, 'reused pid: the planted lease is reaped');
  assert.notEqual(r.lease.id, '0123456789abcdef');
});

// An injected process table (rows [pid, start, pgid = pid, zombie = false]) and system { table, alive, kill }.
const tableOf = (method, rows) => ({ method, rows: new Map(rows.map(([pid, start, pgid = pid, zombie = false]) => [pid, { pgid, zombie, start }])) });
const realAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function fakeSystem(table, { alive = realAlive, onKill = () => {} } = {}) {
  const calls = [];
  return { calls, system: { table, alive, kill: (pid, sig) => { calls.push([pid, sig]); onKill(sig); } } };
}
const FAKE = 4000000; // a pid no test process has; only injected tables and alive() know it

test('review r1 3, 4: one identity function; a failed inspection, a pid missing from the table or a method switch is unknown, never dead', () => {
  const sys = (table, alive = true) => ({ table: () => table, alive: () => alive, kill: () => { throw new Error('identify never signals'); } });
  const id = (system) => sched.identify([FAKE], system).get(FAKE);
  assert.equal(id(sys(null)).state, 'unknown', 'ps failed or missing, and no /proc');
  assert.equal(id(sys(tableOf('ps', []))).state, 'unknown', 'kill(0) succeeds but the table lacks the pid');
  assert.equal(id(sys(tableOf('ps', [[FAKE, null]]))).state, 'unknown', 'start unreadable');
  assert.equal(id(sys(tableOf('ps', [[FAKE, '1000']]), false)).state, 'gone', 'kill(0) fails');
  assert.equal(id(sys(tableOf('ps', [[FAKE, '1000', FAKE, true]]))).state, 'gone', 'a zombie');
  assert.deepEqual(id(sys(tableOf('proc', [[FAKE, '1000', 77]]))), { pid: FAKE, state: 'running', start: '1000', method: 'proc', pgid: 77 });
  const rec = { pid: FAKE, start: '1000', method: 'ps' };
  assert.equal(sched.judge(rec, id(sys(tableOf('ps', [[FAKE, '1000']])))), 'same');
  assert.equal(sched.judge(rec, id(sys(tableOf('ps', [[FAKE, '2000']])))), 'other', 'the pid was reused');
  assert.equal(sched.judge(rec, id(sys(tableOf('proc', [[FAKE, '1000']])))), 'unknown', 'another method: not comparable');
  assert.equal(sched.judge(rec, id(sys(null))), 'unknown');
  assert.equal(sched.judge({ ...rec, start: null, method: null }, id(sys(tableOf('ps', [[FAKE, '1000']])))), 'unknown', 'recorded without an identity');
  assert.equal(sched.judge(rec, id(sys(null, false))), 'gone');
});

test('review r1 4: a failed or switched process inspection never reaps a live holder: its slot is not granted', (t) => {
  const s = sandbox(t);
  const recorded = { pid: process.pid, start: OLD, method: 'ps' }; // what an earlier reading of this live process gave
  plantLease(s.data, 'heavy-1', { owner: recorded });
  const before = readFileSync(join(s.data, 'leases', 'heavy-1.json'), 'utf8');
  for (const [why, table] of [['ps failed', () => null], ['ps lacks the pid', () => tableOf('ps', [])], ['method switch', () => tableOf('proc', [[process.pid, '12345']])]]) {
    const fake = fakeSystem(table);
    const r = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-b'), system: fake.system }));
    assert.equal(r.ok, false, `${why}: the live holder keeps its slot`);
    assert.deepEqual(fake.calls, [], `${why}: no signal`);
    assert.equal(readFileSync(join(s.data, 'leases', 'heavy-1.json'), 'utf8'), before, `${why}: the lease is untouched`);
    sched.dequeue('heavy', s.ctx({ cwd: s.dir('wt-b'), system: fake.system }));
  }
  // An identity that stays unknown past the TTL frees the lease, without a signal.
  plantLease(s.data, 'heavy-1', { owner: recorded, at: iso(2 * 3600e3), heartbeatAt: iso(2 * 3600e3), ttlS: 3600 });
  const blind = fakeSystem(() => null);
  assert.equal(sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-b'), system: blind.system })).ok, true);
  assert.deepEqual(blind.calls, []);
});

test('review r1 3: an unknown identity never authorizes a signal; the group is checked again right before SIGKILL', { timeout: 20000 }, (t) => {
  const s = sandbox(t);
  const child = { pid: FAKE, start: '1000', method: 'ps' };
  const alive = (pid) => pid === FAKE || realAlive(pid);
  // (a) The holder is dead and its child cannot be identified (no ps, no /proc): no signal; the slot stays held until
  // the TTL, then it is freed, still without a signal.
  plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child });
  const blind = fakeSystem(() => null, { alive });
  assert.equal(sched.acquire('heavy', s.ctx({ system: blind.system })).ok, false, 'kept while the child is unknown');
  sched.dequeue('heavy', s.ctx({ system: blind.system }));
  plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child, heartbeatAt: iso(2 * 3600e3), at: iso(2 * 3600e3), ttlS: 3600 });
  const late = sched.acquire('heavy', s.ctx({ system: blind.system }));
  assert.equal(late.ok, true, 'past its TTL the lease is freed');
  assert.deepEqual(blind.calls, [], 'never a signal for an unknown identity');
  sched.release(late.lease, s.ctx());
  // (b) The pid names another process after SIGTERM: no SIGKILL.
  plantLease(s.data, 'e2e-1', { owner: oldId(deadPid()), child, id: 'eeeeeeeeeeeeeeee' });
  let replaced = false;
  const reuse = fakeSystem(() => tableOf('ps', [[FAKE, replaced ? '2000' : '1000']]), { alive, onKill: (sig) => { if (sig === 'SIGTERM') replaced = true; } });
  assert.equal(sched.acquire('e2e', s.ctx({ system: reuse.system })).ok, true);
  assert.deepEqual(reuse.calls, [[-FAKE, 'SIGTERM']], 'SIGTERM to the verified group, no SIGKILL to the replacement');
  // (c) Still the same group after the grace period: SIGKILL.
  plantLease(s.data, 'external-1', { owner: oldId(deadPid()), child, id: 'ffffffffffffffff' });
  const stubborn = fakeSystem(() => tableOf('ps', [[FAKE, '1000']]), { alive });
  assert.equal(sched.acquire('external', s.ctx({ system: stubborn.system })).ok, true);
  assert.deepEqual(stubborn.calls, [[-FAKE, 'SIGTERM'], [-FAKE, 'SIGKILL']]);
});

test('crash recovery: a holder killed with SIGKILL leaves a lease that the next acquire reaps', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const sched = await import(${JSON.stringify(SCHED_URL)});
    const r = sched.acquire('heavy', { names: ${JSON.stringify(names)}, env: process.env, cwd: process.env.WT, readings: ${JSON.stringify(CALM)} });
    process.stdout.write(JSON.stringify(r.ok) + '\\n');
    setInterval(() => {}, 1000);
  `], { env: { ...s.env, WT: s.dir('wt-holder') }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } });
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not report within 10 s')), 10000);
    holder.stdout.once('data', (d) => { clearTimeout(timer); resolve(String(d).trim()); });
  });
  assert.equal(line, 'true');
  assert.equal(sched.acquire('heavy', s.ctx()).ok, false, 'held by a live process');
  holder.kill('SIGKILL');
  await new Promise((r) => { holder.once('exit', r); });
  const after = sched.acquire('heavy', s.ctx());
  assert.equal(after.ok, true, 'reaped after the holder died');
});

test('TTL: an agent lease without a heartbeat for longer than its TTL is reaped; a heartbeat keeps it', (t) => {
  const s = sandbox(t);
  const live = sched.acquire('agent', s.ctx({ owner: { sessionId: 's-1', key: 'toolu_1' } }));
  assert.equal(live.ok, true);
  assert.equal(live.lease.ttlS, 600, 'agent TTL 10 min');
  assert.equal(sched.bindAgent({ key: 'toolu_1', agentId: 'agent-x' }, s.ctx()), true);
  plantLease(s.data, 'agent-2', { owner: { sessionId: 's-2', key: 'toolu_2', agentId: 'agent-y' }, heartbeatAt: iso(11 * 60e3), ttlS: 600, id: 'aaaaaaaaaaaaaaaa' });
  plantLease(s.data, 'agent-3', { owner: { sessionId: 's-3', key: 'toolu_3', agentId: 'agent-z' }, heartbeatAt: iso(9 * 60e3), ttlS: 600, id: 'bbbbbbbbbbbbbbbb' });
  assert.equal(sched.heartbeatAgent('agent-z', s.ctx()), true);
  assert.ok(Date.now() - Date.parse(leaseDoc(s.data, 'agent-3').heartbeatAt) < 60e3, 'heartbeat refreshed');
  const next = sched.acquire('agent', s.ctx({ owner: { sessionId: 's-4', key: 'toolu_4' } }));
  assert.equal(next.ok, true);
  assert.equal(next.lease.slot, 2, 'the expired lease was reaped');
  assert.equal(sched.releaseAgent('agent-x', s.ctx()), true);
  assert.deepEqual(leaseFiles(s.data), ['agent-2.json', 'agent-3.json']);
});

test('review r1 5: a forward clock jump past the TTL never frees the lease of a process holder whose identity is known and matches', (t) => {
  const s = sandbox(t);
  const childPid = sleeper(t);
  const twoHoursAgo = iso(2 * 3600e3);
  plantLease(s.data, 'heavy-1', { owner: ME, child: idOf(childPid), at: twoHoursAgo, heartbeatAt: twoHoursAgo, ttlS: 3665 });
  const before = readFileSync(join(s.data, 'leases', 'heavy-1.json'), 'utf8');
  const r = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-b') }));
  assert.equal(r.ok, false, 'the live holder keeps its slot');
  assert.equal(readFileSync(join(s.data, 'leases', 'heavy-1.json'), 'utf8'), before);
  assert.doesNotThrow(() => process.kill(childPid, 0), 'its child runs on, unsignalled');
});

test('a lease file of a newer schema occupies its slot and is never touched; an unreadable one is reaped', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.data, 'leases'), { recursive: true });
  writeFileSync(join(s.data, 'leases', 'heavy-1.json'), '{"schema":2,"future":true}\n');
  const r = sched.acquire('heavy', s.ctx());
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(s.data, 'leases', 'heavy-1.json'), 'utf8'), '{"schema":2,"future":true}\n');
  writeFileSync(join(s.data, 'leases', 'e2e-1.json'), 'not json');
  assert.equal(sched.acquire('e2e', s.ctx()).ok, true);
});

test('lease race: 12 processes acquire `agent` (max 3) at once; exactly 3 win, on distinct slots and port blocks', { timeout: 60000 }, async (t) => {
  const s = sandbox(t);
  const go = join(s.base, 'go'); // agent leases are kept by TTL, so they outlive the racers
  const script = `
    import { existsSync } from 'node:fs';
    const sched = await import(${JSON.stringify(SCHED_URL)});
    const until = Date.now() + 20000;
    while (!existsSync(process.env.GO)) { if (Date.now() > until) process.exit(3); await new Promise((r) => setTimeout(r, 20)); }
    const r = sched.acquire('agent', { names: ${JSON.stringify(names)}, env: process.env, cwd: process.env.WT, readings: ${JSON.stringify(CALM)},
      owner: { sessionId: 'race', key: process.env.KEY }, lockTimeoutMs: 20000 });
    process.stdout.write(JSON.stringify({ ok: r.ok, slot: r.lease?.slot ?? null, ports: r.lease?.ports ?? null }));
  `;
  for (let round = 0; round < 2; round++) {
    rmSync(join(s.data, 'leases'), { recursive: true, force: true });
    rmSync(go, { force: true });
    const runs = Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...s.env, GO: go, WT: s.dir(`r${i}`), KEY: `toolu_${round}_${i}` }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer exit ${code}`))));
    }));
    await pause(300);
    writeFileSync(go, '');
    const results = await Promise.all(runs);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 3, `round ${round}: exactly the max`);
    assert.deepEqual(winners.map((r) => r.slot).sort(), [1, 2, 3]);
    assert.equal(new Set(winners.map((r) => r.ports[0])).size, 3);
    assert.equal(leaseFiles(s.data).length, 3);
  }
});

// ---- the scheduler lock (findings r1 1: no automatic stale-lock recovery) ----

const FSX_URL = pathToFileURL(join(pluginDir, 'lib', 'fsx', 'index.mjs')).href;
const schedLock = (data) => join(data, 'leases', 'lock');
function plantStaleLock(data) {
  const lock = schedLock(data);
  mkdirSync(lock, { recursive: true });
  const pid = deadPid();
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid, token: `${pid}.0123456789abcdef`, host: os.hostname(), startedAt: iso(60e3), procStart: iso(61e3) }));
  return { pid, text: readFileSync(join(lock, 'owner.json'), 'utf8') };
}
async function untilFile(file, ms = 15000) {
  for (const until = Date.now() + ms; !existsSync(file);) {
    assert.ok(Date.now() < until, `${file} within ${ms} ms`);
    await pause(10);
  }
}

test('a scheduler lock whose owner is dead is never removed by a scheduler call: scheduler-busy (exit 7) with the hint slots --unlock-stale', (t) => {
  const s = sandbox(t);
  const stale = plantStaleLock(s.data);
  for (const call of [() => sched.acquire('heavy', s.ctx()), () => sched.calibrate({ names, env: s.env, readings: CALM, freeMin: 25 })]) {
    assert.throws(call, (e) => e.code === 'scheduler-busy' && e.exit === 'REFUSED' && new RegExp(`${names.bin} slots --unlock-stale`).test(e.hint), 'refused at once');
  }
  assert.equal(readFileSync(join(schedLock(s.data), 'owner.json'), 'utf8'), stale.text, 'the lock is untouched');
  assert.deepEqual(leaseFiles(s.data), [], 'nothing granted');
});

test('slots --unlock-stale: consent required; removes a dead owner\'s lock that stayed unchanged; refuses a live one (exit 7) and touches nothing', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const stale = plantStaleLock(s.data);
  assert.equal((await cli(['slots', '--unlock-stale'], { env: s.env, cwd })).code, EXIT.REFUSED, 'no terminal, no --yes');
  assert.ok(existsSync(schedLock(s.data)));
  const removed = await cli(['slots', '--unlock-stale', '--yes'], { env: s.env, cwd });
  assert.equal(removed.code, EXIT.OK);
  assert.equal(removed.env.data.removed, true);
  assert.equal(removed.env.data.owner.pid, stale.pid);
  assert.equal(existsSync(schedLock(s.data)), false);
  assert.equal(sched.acquire('heavy', s.ctx()).ok, true, 'the scheduler works again');
  const none = await cli(['slots', '--unlock-stale', '--yes'], { env: s.env, cwd });
  assert.deepEqual([none.code, none.env.data.removed], [EXIT.OK, false]);
  // A live holder: refused, the lock stays.
  const hold = join(s.base, 'hold');
  const inside = join(s.base, 'inside');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { existsSync, writeFileSync } from 'node:fs';
    const { withLock } = await import(${JSON.stringify(FSX_URL)});
    const pause = new Int32Array(new SharedArrayBuffer(4));
    withLock(process.env.LOCK, () => { writeFileSync(process.env.INSIDE, ''); for (const until = Date.now() + 20000; existsSync(process.env.HOLD) && Date.now() < until;) Atomics.wait(pause, 0, 0, 20); });
  `], { env: { ...s.env, LOCK: schedLock(s.data), HOLD: hold, INSIDE: inside }, stdio: 'ignore' });
  writeFileSync(hold, '');
  t.after(() => { rmSync(hold, { force: true }); try { holder.kill('SIGKILL'); } catch { /* gone */ } });
  await untilFile(inside);
  const live = await cli(['slots', '--unlock-stale', '--yes'], { env: s.env, cwd });
  assert.equal(live.code, EXIT.REFUSED);
  assert.equal(live.env.errors[0].code, 'scheduler-busy');
  assert.ok(existsSync(schedLock(s.data)), 'the live lock stays');
  rmSync(hold);
  await new Promise((r) => { holder.once('exit', r); });
});

test('review r1 interleaving: an unlock that saw a dead owner never removes the live lock that replaced it; never two holders', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  plantStaleLock(s.data);
  const f = (n) => join(s.base, n);
  const run = (code, env) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...s.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    return { p, done: new Promise((resolve) => { p.once('exit', (code) => resolve({ code, out })); }) };
  };
  // U1 observes the dead owner first, then stays quiet for 1.5 s before its second look.
  const u1 = run(`
    import { writeFileSync } from 'node:fs';
    const sched = await import(${JSON.stringify(SCHED_URL)});
    writeFileSync(process.env.STARTED, '');
    let r;
    try { r = sched.unlockStale({ names: ${JSON.stringify(names)}, env: process.env, quietMs: 1500 }); } catch (e) { r = { code: e.code, exit: e.exit }; }
    process.stdout.write(JSON.stringify(r));
  `, { STARTED: f('started') });
  await untilFile(f('started'));
  // C removes the dead lock meanwhile, takes the lock and stays in its critical section until DONE.
  const c = run(`
    import { existsSync, writeFileSync } from 'node:fs';
    const sched = await import(${JSON.stringify(SCHED_URL)});
    const { withLock } = await import(${JSON.stringify(FSX_URL)});
    const pause = new Int32Array(new SharedArrayBuffer(4));
    sched.unlockStale({ names: ${JSON.stringify(names)}, env: process.env, quietMs: 50 });
    withLock(process.env.LOCK, () => { writeFileSync(process.env.INSIDE, String(process.pid)); for (const until = Date.now() + 20000; !existsSync(process.env.DONE) && Date.now() < until;) Atomics.wait(pause, 0, 0, 20); });
  `, { LOCK: schedLock(s.data), INSIDE: f('inside'), DONE: f('done') });
  await untilFile(f('inside'));
  const u1Result = JSON.parse((await u1.done).out);
  assert.deepEqual(u1Result, { code: 'scheduler-busy', exit: 'REFUSED' }, 'U1 refuses: the lock changed (or is held) since its first look');
  assert.equal(JSON.parse(readFileSync(join(schedLock(s.data), 'owner.json'), 'utf8')).pid, c.p.pid, 'the live lock of C is in place');
  assert.throws(() => sched.acquire('heavy', s.ctx({ lockTimeoutMs: 100 })), (e) => e.code === 'scheduler-busy' && e.exit === 'ENV', 'a third caller waits for C');
  writeFileSync(f('done'), '');
  assert.equal((await c.done).code, 0);
  assert.equal(sched.acquire('heavy', s.ctx()).ok, true);
  assert.deepEqual(leaseFiles(s.data), ['heavy-1.json']);
});

// ---- FIFO tickets for exclusive kinds (§7.8a) ----

test('FIFO: heavy waiters from three worktrees get the lease in arrival order, never by racing for a free slot', (t) => {
  const s = sandbox(t);
  const [a, b, c] = ['wt-a', 'wt-b', 'wt-c'].map((n) => s.ctx({ cwd: s.dir(n) }));
  const ra = sched.acquire('heavy', a);
  assert.equal(ra.ok, true);
  const rb = sched.acquire('heavy', b);
  const rc = sched.acquire('heavy', c);
  assert.equal(rb.ok, false);
  assert.equal(rb.position, 0);
  assert.equal(rc.position, 1);
  assert.deepEqual(rc.reasons.map((r) => r.code), ['queued']);
  sched.release(ra.lease, a);
  const early = sched.acquire('heavy', c);
  assert.equal(early.ok, false, 'C may not take the free slot while B is ahead');
  assert.equal(early.position, 1);
  const rb2 = sched.acquire('heavy', b);
  assert.equal(rb2.ok, true);
  sched.release(rb2.lease, b);
  assert.equal(sched.acquire('heavy', c).ok, true);
  assert.equal(existsSync(join(s.data, 'heavy-queue')) ? readdirSync(join(s.data, 'heavy-queue')).filter((f) => f.endsWith('.json')).length : 0, 0, 'no tickets left');
});

test('review r1 9 (by design): with max > 1 the first (max − held) tickets may take a slot in any order; none behind them overtakes; the help says so', async (t) => {
  const s = sandbox(t);
  sched.calibrate({ names, env: s.env, readings: CALM, max: { heavy: 2 } });
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((n) => s.ctx({ cwd: s.dir(`wt-${n}`) }));
  const held = [a, b].map((x) => sched.acquire('heavy', x));
  assert.deepEqual([c, d, e].map((x) => sched.acquire('heavy', x).position), [0, 1, 2]);
  for (const h of held) sched.release(h.lease, s.ctx());
  assert.equal(sched.acquire('heavy', d).ok, true, 'D is within the window of 2 free slots: it may go before C');
  assert.equal(sched.acquire('heavy', e).ok, false, 'E is behind the window (1 free slot, C first): it never overtakes');
  assert.equal(sched.acquire('heavy', c).ok, true);
  const help = await cli(['heavy', '--help'], { env: s.env, cwd: s.dir('wt-a') });
  assert.match(help.env.data.usage, /first \(max − in use\) tickets/);
});

test('§7.8a: one queue entry per worktree; a ticket of a gone process is reaped and blocks nobody; e2e queues the same way', (t) => {
  const s = sandbox(t);
  const a = s.ctx({ cwd: s.dir('wt-a') });
  const b = s.ctx({ cwd: s.dir('wt-b') });
  const holder = sched.acquire('e2e', a);
  assert.equal(holder.ok, true);
  assert.equal(sched.acquire('e2e', b).position, 0);
  const parent = idOf(process.ppid);
  assert.ok(parent.start, 'the parent process is running');
  assert.throws(() => sched.acquire('e2e', { ...b, owner: parent }), (e) => e.code === 'already-queued' && e.exit === 'FAIL');
  assert.equal(sched.dequeue('e2e', b), true);
  // A ticket of a dead process ahead of everyone: reaped, so B is first again.
  const qdir = join(s.data, 'e2e-queue');
  mkdirSync(qdir, { recursive: true });
  const ghost = realpathSync(s.dir('wt-ghost'));
  writeFileSync(join(qdir, `${hash(ghost, 16)}.json`), `${JSON.stringify({ schema: 1, kind: 'e2e', seq: 1, worktree: ghost, owner: oldId(deadPid()), task: null, at: iso(60e3), deadline: iso(-3600e3) }, null, 2)}\n`);
  const rb = sched.acquire('e2e', b);
  assert.equal(rb.position, 0, 'the dead ticket does not count');
  assert.equal(existsSync(join(qdir, `${hash(ghost, 16)}.json`)), false);
  sched.release(holder.lease, a);
  assert.equal(sched.acquire('e2e', b).ok, true);
});

test('heavy semaphore across processes: 5 waiters never overlap and run in ticket order', { timeout: 60000 }, async (t) => {
  const s = sandbox(t);
  const log = join(s.base, 'log');
  writeFileSync(log, '');
  const script = `
    import { appendFileSync } from 'node:fs';
    const sched = await import(${JSON.stringify(SCHED_URL)});
    const opts = { names: ${JSON.stringify(names)}, env: process.env, cwd: process.env.WT, readings: ${JSON.stringify(CALM)}, lockTimeoutMs: 20000 };
    let seq = null;
    const r = await sched.acquireWait('heavy', { ...opts, timeoutMs: 40000, pollMs: 250, onWait: (w) => { if (seq === null) { seq = w.seq; appendFileSync(process.env.LOG, 'queued ' + process.env.NAME + ' ' + w.seq + '\\n'); } } });
    if (!r.ok) process.exit(4);
    appendFileSync(process.env.LOG, 'start ' + process.env.NAME + ' ' + Date.now() + '\\n');
    await new Promise((res) => setTimeout(res, 80));
    appendFileSync(process.env.LOG, 'end ' + process.env.NAME + ' ' + Date.now() + '\\n');
    sched.release(r.lease, opts);
  `;
  const first = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-first') }));
  assert.equal(first.ok, true, 'held while the waiters line up');
  const procs = Array.from({ length: 5 }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...s.env, WT: s.dir(`w${i}`), LOG: log, NAME: `w${i}` }, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`waiter exit ${code}`))));
  }));
  const until = Date.now() + 20000;
  while (readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('queued')).length < 5) {
    assert.ok(Date.now() < until, 'all waiters queued within 20 s');
    await pause(20);
  }
  sched.release(first.lease, s.ctx());
  await Promise.all(procs);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
  const order = lines.filter(([w]) => w === 'queued').sort((x, y) => Number(x[2]) - Number(y[2])).map(([, n]) => n);
  const runs = lines.filter(([w]) => w !== 'queued');
  assert.deepEqual(runs.filter(([w]) => w === 'start').map(([, n]) => n), order, 'started in ticket order');
  for (let i = 0; i < runs.length; i += 2) {
    assert.equal(runs[i][0], 'start');
    assert.equal(runs[i + 1][0], 'end');
    assert.equal(runs[i][1], runs[i + 1][1], 'no other run starts before this one ends');
  }
});

// The wait is driven by an injected clock (opts.now, opts.sleep): a virtual clock starts at the real time and moves only
// when the code sleeps, so no real time passes and a loaded machine cannot race the deadline (T-MG-68).
function virtualClock(speed = 1) {
  let offset = 0;
  const slept = [];
  return { now: () => Date.now() + offset, sleep: async (ms) => { slept.push(ms); offset += ms * speed; }, slept };
}
const ticketDeadline = (queue) => Date.parse(JSON.parse(readFileSync(join(queue, readdirSync(queue).find((f) => f.endsWith('.json'))), 'utf8')).deadline);
const tickets = (queue) => (existsSync(queue) ? readdirSync(queue).filter((f) => f.endsWith('.json')) : []);

for (const speed of [1, 10]) {
  test(`acquireWait gives up at its deadline and leaves no ticket behind (virtual clock, a sleep ${speed}x as long as asked)`, { timeout: 20000 }, async (t) => {
    const s = sandbox(t);
    const held = sched.acquire('heavy', s.ctx());
    const b = s.ctx({ cwd: s.dir('wt-b') });
    const queue = join(s.data, 'heavy-queue');
    const clock = virtualClock(speed);
    const began = clock.now();
    const realBegan = Date.now();
    let deadline = null;
    const r = await sched.acquireWait('heavy', { ...b, timeoutMs: 5000, pollMs: 1000, now: clock.now, sleep: clock.sleep, onWait: () => { deadline ??= ticketDeadline(queue); } });
    assert.ok(Date.now() - realBegan < 3000, 'no real time was spent waiting');
    assert.equal(r.ok, false);
    assert.equal(r.reasons.at(-1).code, 'wait-timeout');
    assert.ok(clock.slept.length >= 1 && clock.slept.every((ms) => ms <= 1000), 'it slept in poll steps, never past the poll interval');
    assert.ok(deadline >= began + 5000 && deadline <= clock.now(), 'the ticket expires when the wait ends');
    assert.deepEqual(tickets(queue), []);
    sched.release(held.lease, s.ctx());
  });
}

test('acquireWait with a clock that jumps past the deadline between attempts times out at once and withdraws its ticket', { timeout: 20000 }, async (t) => {
  const s = sandbox(t);
  const held = sched.acquire('heavy', s.ctx());
  const b = s.ctx({ cwd: s.dir('wt-b') });
  const queue = join(s.data, 'heavy-queue');
  let calls = 0;
  const now = () => Date.now() + (calls++ > 0 ? 3600e3 : 0); // the first reading is true, every later one is an hour on
  const r = await sched.acquireWait('heavy', { ...b, timeoutMs: 5000, pollMs: 1000, now, sleep: async () => { throw new Error('must not sleep past the deadline'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reasons.at(-1).code, 'wait-timeout');
  assert.deepEqual(tickets(queue), []);
  sched.release(held.lease, s.ctx());
});

test('acquireWait on the real clock gives up and leaves no ticket behind (outcome only: how often it polls depends on the machine)', { timeout: 20000 }, async (t) => {
  const s = sandbox(t);
  const held = sched.acquire('heavy', s.ctx());
  const b = s.ctx({ cwd: s.dir('wt-b') });
  const queue = join(s.data, 'heavy-queue');
  const r = await sched.acquireWait('heavy', { ...b, timeoutMs: 300, pollMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.reasons.at(-1).code, 'wait-timeout');
  assert.deepEqual(tickets(queue), []);
  sched.release(held.lease, s.ctx());
});

test('review r1 8: a ticket records its deadline; any caller removes an expired ticket whatever its owner; before it a live or unknown owner keeps its place', (t) => {
  const s = sandbox(t);
  const qdir = join(s.data, 'heavy-queue');
  const held = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-x') }));
  const until = Date.now() + 60e3;
  assert.equal(sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-c'), deadline: until })).ok, false);
  const own = JSON.parse(readFileSync(join(qdir, `${hash(realpathSync(s.dir('wt-c')), 16)}.json`), 'utf8'));
  assert.equal(Date.parse(own.deadline), until, 'the ticket carries the deadline of its wait');
  sched.dequeue('heavy', s.ctx({ cwd: s.dir('wt-c') }));
  sched.release(held.lease, s.ctx());
  const b = realpathSync(s.dir('wt-b'));
  const plant = (deadline, owner) => {
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, `${hash(b, 16)}.json`), `${JSON.stringify({ schema: 1, kind: 'heavy', seq: 1, worktree: b, owner, task: null, at: iso(60e3), deadline }, null, 2)}\n`);
  };
  const unknownOwner = { pid: FAKE, start: '1000', method: 'ps' };
  const blind = fakeSystem(() => null, { alive: (pid) => pid === FAKE || realAlive(pid) });
  const c = (extra = {}) => sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-c'), ...extra }));
  plant(iso(-60e3), ME);
  assert.deepEqual([c().ok, c().position], [false, 1], 'a live owner before its deadline is ahead');
  sched.dequeue('heavy', s.ctx({ cwd: s.dir('wt-c') }));
  plant(iso(-60e3), unknownOwner);
  assert.equal(c({ system: blind.system }).ok, false, 'an unknown owner before its deadline is ahead');
  sched.dequeue('heavy', s.ctx({ cwd: s.dir('wt-c'), system: blind.system }));
  for (const owner of [ME, unknownOwner]) {
    plant(iso(1000), owner);
    const r = c({ system: blind.system });
    assert.equal(r.ok, true, 'an expired ticket blocks nobody, whatever its owner');
    assert.equal(existsSync(join(qdir, `${hash(b, 16)}.json`)), false, 'and is removed');
    sched.release(r.lease, s.ctx());
  }
  plant(new Date(Date.now() - 365 * 86400e3).toISOString(), unknownOwner);
  assert.equal(c({ system: blind.system }).ok, true, 'review r1 8: a crashed ticket with a reused pid and no identity, a year on');
});

test('review r1 8: a wait that ends while another call holds the lock withdraws its ticket once the lock is free', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const held = sched.acquire('heavy', s.ctx());
  const [go, lockedFile] = [join(s.base, 'go'), join(s.base, 'locked')];
  const l = spawn(process.execPath, ['--input-type=module', '-e', `
    import { existsSync, writeFileSync } from 'node:fs';
    const { withLock } = await import(${JSON.stringify(FSX_URL)});
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (const until = Date.now() + 20000; !existsSync(process.env.GO) && Date.now() < until;) Atomics.wait(pause, 0, 0, 10);
    withLock(process.env.LOCK, () => { writeFileSync(process.env.LOCKED, ''); Atomics.wait(pause, 0, 0, 1500); }, { timeoutMs: 10000 });
  `], { env: { ...s.env, GO: go, LOCKED: lockedFile, LOCK: schedLock(s.data) }, stdio: 'ignore' });
  t.after(() => { try { l.kill('SIGKILL'); } catch { /* gone */ } });
  const stall = new Int32Array(new SharedArrayBuffer(4));
  let first = true;
  const b = s.ctx({ cwd: s.dir('wt-b'), lockTimeoutMs: 100 });
  const r = await sched.acquireWait('heavy', {
    ...b, timeoutMs: 300, pollMs: 50,
    onWait: () => { // queued: let L take the lock, and wait until it holds it, so the deadline falls inside its section
      if (!first) return;
      first = false;
      writeFileSync(go, '');
      for (const until = Date.now() + 10000; !existsSync(lockedFile) && Date.now() < until;) Atomics.wait(stall, 0, 0, 10);
    },
  });
  assert.equal(r.reasons.at(-1).code, 'wait-timeout');
  assert.deepEqual(queued(s.data, 'heavy'), [], 'the ticket was withdrawn after the lock came free');
  await new Promise((res) => { if (l.exitCode !== null) res(); else l.once('exit', res); });
  sched.release(held.lease, s.ctx());
});

// ---- admission (spec §7.8, §14 shadow) ----

test('admission: load ≥ LOAD_MAX, free memory < FREE_MIN or unmeasured load are reasons; shadow reports them, on waits', (t) => {
  const s = sandbox(t);
  sched.calibrate({ names, env: s.env, readings: CALM });
  const busy = { ...CALM, load1: 18 };
  const shadow = sched.acquire('heavy', s.ctx({ readings: busy }));
  assert.equal(shadow.ok, true, 'shadow: capacity decides');
  assert.deepEqual(shadow.shadow.map((r) => r.code), ['load']);
  assert.match(shadow.shadow[0].message, /load 18\.0 ≥ 17\.0/);
  sched.release(shadow.lease, s.ctx());
  const on = sched.acquire('heavy', s.ctx({ readings: busy, mode: 'on' }));
  assert.equal(on.ok, false);
  assert.deepEqual(on.reasons.map((r) => r.code), ['load']);
  sched.dequeue('heavy', s.ctx());
  const low = sched.acquire('agent', s.ctx({ readings: { ...CALM, availBytes: 2 * 2 ** 30 }, mode: 'on' }));
  assert.equal(low.ok, false);
  assert.match(low.reasons[0].message, /free memory 6% < 30%/);
  const blind = sched.acquire('agent', s.ctx({ readings: { ...CALM, load1: null, loadMeasurable: false }, mode: 'on' }));
  assert.deepEqual(blind.reasons.map((r) => r.code), ['load-unmeasured'], 'fail closed until calibrated without a load check');
  assert.equal(sched.acquire('agent', s.ctx({ mode: 'on' })).ok, true);
});

test('U13: two rate-limit errors within 10 minutes in the transcript are a reason; older or single ones are not', (t) => {
  const s = sandbox(t);
  const transcript = join(s.base, 'transcript.jsonl');
  const err = (msAgo) => JSON.stringify({ type: 'assistant', isApiErrorMessage: true, timestamp: iso(msAgo), message: { content: [{ type: 'text', text: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}' }] } });
  const ok = (msAgo) => JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), message: { content: [{ type: 'text', text: 'rate limits are discussed here' }] } });
  writeFileSync(transcript, `${[err(30 * 60e3), err(20 * 60e3), ok(60e3), err(5 * 60e3)].join('\n')}\n`);
  assert.deepEqual(sched.rateLimitReasons(transcript), []);
  writeFileSync(transcript, `${[err(9 * 60e3), ok(60e3), err(60e3)].join('\n')}\n`);
  const reasons = sched.rateLimitReasons(transcript);
  assert.deepEqual(reasons.map((r) => r.code), ['rate-limit']);
  assert.equal(sched.rateLimitReasons(join(s.base, 'missing.jsonl')).length, 0);
  const on = sched.acquire('agent', s.ctx({ transcriptPath: transcript, mode: 'on' }));
  assert.equal(on.ok, false);
  assert.deepEqual(on.reasons.map((r) => r.code), ['rate-limit']);
});

test('admitAgent: only the implementer is admitted; shadow allows a busy machine and returns the would-deny record; on denies', (t) => {
  const s = sandbox(t);
  const repo = s.dir('repo');
  assert.equal(spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo], { env: ISO.env }).status, 0);
  mkdirSync(join(repo, names.stateDir), { recursive: true });
  const writeState = (flags) => writeFileSync(join(repo, names.stateDir, 'state.json'), `${JSON.stringify({ schema: 1, codename: names.codename, createdWith: '2.0.0', activatedAt: iso(), flags }, null, 2)}\n`);
  const input = (n, type = `${names.plugin}:implementer`) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: repo, tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type, prompt: 'x' } });
  const busy = { ...CALM, load1: 30 };
  writeState({});
  assert.equal(sched.admitAgent(input(0, 'Explore'), { names, env: s.env, readings: busy }).action, 'pass');
  const shadow = sched.admitAgent(input(1), { names, env: s.env, readings: busy });
  assert.equal(shadow.action, 'allow', 'default mode is shadow');
  assert.equal(shadow.lease.owner.key, 'toolu_1');
  assert.deepEqual(shadow.shadow.reasons.map((r) => r.code), ['load']);
  assert.equal(shadow.shadow.action, 'would-deny');
  writeState({ admission: 'on' });
  const denied = sched.admitAgent(input(2), { names, env: s.env, readings: busy });
  assert.equal(denied.action, 'deny');
  assert.match(denied.message, new RegExp(`^machine busy: load 30\\.0 ≥ 17\\.0; run \`${names.bin} tick\` later$`));
  writeState({ admission: 'off' });
  assert.equal(sched.admitAgent(input(3), { names, env: s.env, readings: busy }).action, 'pass');
  rmSync(join(repo, names.stateDir), { recursive: true });
  assert.equal(sched.admitAgent(input(4), { names, env: s.env, readings: busy }).action, 'pass', 'inactive repository: no-op');
  assert.equal(sched.admitAgent({ junk: true }, { names, env: s.env }).action, 'pass', 'malformed input: pass');
});

// ---- orphans of dead holders (§7.8a) ----

function sleeper(t) {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  p.unref();
  t.after(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } });
  return p.pid;
}
async function gone(pid, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > until) return false;
    await pause(25);
  }
}

test('the reaper kills the process group of an orphan whose holder is dead; a reused child pid is never killed', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const orphan = sleeper(t);
  const bystander = sleeper(t);
  await pause(100);
  plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child: idOf(orphan) });
  plantLease(s.data, 'e2e-1', { owner: oldId(deadPid()), child: oldId(bystander), id: 'cccccccccccccccc' });
  assert.equal(sched.acquire('heavy', s.ctx()).ok, true);
  assert.equal(await gone(orphan), true, 'orphan killed');
  assert.equal(sched.acquire('e2e', s.ctx({ cwd: s.dir('wt-b') })).ok, true, 'the e2e lease is reaped too');
  await pause(200);
  assert.doesNotThrow(() => process.kill(bystander, 0), 'a process with another start time is not the orphan');
});

test('review r1 7: the reaper ends the members a gone leader left in its process group', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const dir = pidDir(t);
  const member = join(dir, 'member');
  const exitFile = join(s.base, 'exit');
  // The leader (own group) starts a member, then exits on a signal file; the member stays in the leader's group.
  const leader = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(${JSON.stringify(member)}, String(process.pid)); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const w = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(exitFile)})) { clearInterval(w); process.exit(0); } }, 10);`], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ } });
  await untilFile(member);
  const leaderId = idOf(leader.pid);
  writeFileSync(exitFile, '');
  await new Promise((r) => { leader.once('exit', r); });
  const memberPid = Number(readFileSync(member, 'utf8'));
  assert.doesNotThrow(() => process.kill(memberPid, 0), 'the member outlived its leader');
  plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child: leaderId });
  assert.equal(sched.acquire('heavy', s.ctx()).ok, true);
  assert.equal(await gone(memberPid), true, 'the member left in the group is ended');
});

test('review r1 7: group membership is verified: an id that leads another process, a member older than the leader or one without a start get no signal', (t) => {
  const s = sandbox(t);
  const child = { pid: FAKE, start: '1000', method: 'ps' };
  const [M, OLDER] = [FAKE + 1, FAKE + 2];
  const alive = (pid) => pid === M || pid === OLDER || realAlive(pid);
  let termed = false;
  const left = fakeSystem(() => tableOf('ps', termed ? [] : [[M, '1005', FAKE]]), { alive, onKill: (sig) => { if (sig === 'SIGTERM') termed = true; } });
  plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child });
  const a = sched.acquire('heavy', s.ctx({ system: left.system }));
  assert.equal(a.ok, true);
  assert.deepEqual(left.calls, [[-FAKE, 'SIGTERM']], 'the leader is gone, its member is not: SIGTERM to the group; gone after it, no SIGKILL');
  sched.release(a.lease, s.ctx());
  for (const [why, rows] of [['older than the leader', [[OLDER, '900', FAKE]]], ['the id leads another process', [[FAKE, '2000'], [M, '2001', FAKE]]]]) {
    const none = fakeSystem(() => tableOf('ps', rows), { alive: (pid) => pid === FAKE || alive(pid) });
    plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child });
    const r = sched.acquire('heavy', s.ctx({ system: none.system }));
    assert.equal(r.ok, true, `${why}: the group is gone, the lease is reaped`);
    assert.deepEqual(none.calls, [], `${why}: no signal`);
    sched.release(r.lease, s.ctx());
  }
  const blur = fakeSystem(() => tableOf('ps', [[M, null, FAKE]]), { alive });
  plantLease(s.data, 'heavy-1', { owner: oldId(deadPid()), child });
  assert.equal(sched.acquire('heavy', s.ctx({ system: blur.system })).ok, false, 'a member without a start: unknown, the lease is kept');
  assert.deepEqual(blur.calls, []);
});

test('attachChild records the child with its start time; a live holder keeps its child', (t) => {
  const s = sandbox(t);
  const child = sleeper(t);
  const r = sched.acquire('heavy', s.ctx());
  assert.equal(sched.attachChild(r.lease, child, s.ctx()), true);
  assert.deepEqual(leaseDoc(s.data, 'heavy-1').child, idOf(child));
  assert.equal(sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-b') })).ok, false);
  assert.doesNotThrow(() => process.kill(child, 0));
});

// ---- supervised run (§7.8a: hard time limit, no-output limit) ----

const child = (code) => spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

test('supervise: output is forwarded and the exit status kept; the hard time limit and the no-output limit end the whole group', { timeout: 30000 }, async (t) => {
  const out = [];
  const done = await sched.supervise(child('process.stdout.write("hi\\n"); process.stderr.write("e\\n"); process.exit(3)'), { timeoutMs: 10000, idleMs: 5000, out: (d) => out.push(String(d)), err: (d) => out.push(String(d)) });
  assert.deepEqual({ ended: done.ended, status: done.status }, { ended: 'exit', status: 3 });
  assert.match(out.join(''), /hi/);
  assert.match(out.join(''), /e/);
  // Hard limit: output keeps coming, the run is still ended; its own child (same group) goes too.
  const pidFile = join(mkdtempSync(join(tmpdir(), 'sched-run-')), 'grandchild');
  t.after(() => rmSync(dirname(pidFile), { recursive: true, force: true }));
  const chatty = child(`const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => process.stdout.write('.'), 20);`);
  const timed = await sched.supervise(chatty, { timeoutMs: 600, idleMs: 5000, out: () => {}, err: () => {} });
  assert.equal(timed.ended, 'timeout');
  assert.equal(await gone(Number(readFileSync(pidFile, 'utf8'))), true, 'grandchild killed with the group');
  // No-output limit: silent after one line.
  const quiet = await sched.supervise(child('process.stdout.write("once\\n"); setInterval(() => {}, 1000)'), { timeoutMs: 10000, idleMs: 400, out: () => {}, err: () => {} });
  assert.equal(quiet.ended, 'idle');
  // A run ignoring SIGTERM is killed after the grace period.
  const stubborn = await sched.supervise(child('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), { timeoutMs: 10000, idleMs: 300, graceMs: 300, out: () => {}, err: () => {} });
  assert.equal(stubborn.ended, 'idle');
  assert.equal(stubborn.signal, 'SIGKILL');
});

// A leader (own group) that starts a member ignoring SIGTERM; the member writes its pid once its handler is set.
const stubbornMember = (pidFile) => `process.on('SIGTERM', () => {}); const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)}); setInterval(() => {}, 1000);`;
const withStubbornMember = (pidFile, then, stdio = 'ignore') => `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubbornMember(pidFile))}], { stdio: ${JSON.stringify(stdio)} }); ${then}`;
// A scratch directory whose pid files name processes to kill when the test ends (before the directory goes).
function pidDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sched-grp-'));
  t.after(() => {
    for (const f of readdirSync(dir)) { try { process.kill(Number(readFileSync(join(dir, f), 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('review r1 2: a member of the group ignoring SIGTERM is killed after the grace period on the time limit, the no-output limit and a normal exit', { timeout: 60000 }, async (t) => {
  const dir = pidDir(t);
  const cases = [
    // The leader keeps printing and dies on SIGTERM; its member must still go (SIGKILL is not cancelled).
    { name: 'timeout', then: 'setInterval(() => process.stdout.write("."), 50);', opts: { timeoutMs: 300, idleMs: 10000 }, ready: true },
    { name: 'idle', then: 'setInterval(() => {}, 1000);', opts: { timeoutMs: 10000, idleMs: 300 }, ready: true },
    // The leader exits 3 once its member runs; the member keeps the output pipes open.
    { name: 'exit', then: `const w = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(join(dir, 'exit'))})) { clearInterval(w); process.exit(3); } }, 10);`, opts: { timeoutMs: 10000, idleMs: 10000 }, stdio: 'inherit' },
  ];
  for (const c of cases) {
    const pidFile = join(dir, c.name);
    const p = child(withStubbornMember(pidFile, c.then, c.stdio));
    if (c.ready) await untilFile(pidFile); // the member has its SIGTERM handler before a limit fires
    const done = await sched.supervise(p, { ...c.opts, graceMs: 300, out: () => {}, err: () => {} });
    assert.equal(done.ended, c.name, c.name);
    if (c.name === 'exit') assert.equal(done.status, 3);
    assert.equal(await gone(Number(readFileSync(pidFile, 'utf8')), 2000), true, `${c.name}: the member that ignored SIGTERM is gone once supervise returns`);
  }
});

// ---- `slots` and `slots calibrate` (command table) ----

async function cli(args, { env, cwd, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd };
  const code = await main([...args, '--json'], { io });
  return { code, env: JSON.parse(out.join('')) };
}

test('slots: read-only list of calibration, readings, leases and queues; writes nothing', async (t) => {
  const s = sandbox(t);
  const empty = await cli(['slots'], { env: s.env, cwd: s.dir('wt-a') });
  assert.equal(empty.code, EXIT.OK);
  assert.equal(empty.env.data.calibration.saved, false);
  assert.deepEqual(empty.env.data.kinds.heavy, { max: 1, used: 0, queued: 0 });
  assert.equal(existsSync(s.data), false, 'nothing written');
  const held = sched.acquire('heavy', s.ctx({ task: 'T-AB-7' }));
  sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-b') }));
  const listed = await cli(['slots'], { env: s.env, cwd: s.dir('wt-a') });
  assert.equal(listed.code, EXIT.OK);
  const lease = listed.env.data.leases.find((l) => l.id === held.lease.id);
  assert.equal(lease.status, 'live');
  assert.equal(lease.task, 'T-AB-7');
  assert.deepEqual(lease.ports, held.lease.ports);
  assert.equal(listed.env.data.queues.heavy.length, 1);
  assert.deepEqual(listed.env.data.kinds.heavy, { max: 1, used: 1, queued: 1 });
  assert.equal(listed.env.data.calibration.saved, true);
  const before = readdirSync(join(s.data, 'leases')).sort();
  plantLease(s.data, 'agent-1', { owner: oldId(deadPid()), id: 'dddddddddddddddd' });
  const stale = await cli(['slots'], { env: s.env, cwd: s.dir('wt-a') });
  assert.equal(stale.env.data.leases.find((l) => l.id === 'dddddddddddddddd').status, 'stale');
  assert.deepEqual(readdirSync(join(s.data, 'leases')).sort(), [...before, 'agent-1.json'].sort(), 'listing reaps nothing');
});

test('slots calibrate: refusals exit 2 and write nothing; overrides are saved and shown; consent required', async (t) => {
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  assert.equal((await cli(['slots', 'calibrate', '--free-min', '25'], { env: s.env, cwd })).code, EXIT.REFUSED, 'no terminal, no --yes');
  for (const args of [['--free-min', '0'], ['--load-max', 'off'], ['--max', 'heavy=0'], ['--max', 'gpu=1'], ['--free-min', 'x']]) {
    const r = await cli(['slots', 'calibrate', ...args, '--yes'], { env: s.env, cwd });
    if (args[1] === 'off' && process.platform === 'win32') continue;
    assert.equal(r.code, EXIT.USAGE, args.join(' '));
  }
  assert.equal(existsSync(join(s.data, 'calibration.json')), false);
  const ok = await cli(['slots', 'calibrate', '--load-max', '12', '--free-min', '25', '--max', 'heavy=2,e2e=1', '--yes'], { env: s.env, cwd });
  assert.equal(ok.code, EXIT.OK);
  assert.equal(ok.env.data.calibration.loadMax, '12.0');
  const listed = await cli(['slots'], { env: s.env, cwd });
  assert.equal(listed.env.data.calibration.freeMinPct, 25);
  assert.equal(listed.env.data.kinds.heavy.max, 2);
  assert.ok(statSync(join(s.data, 'calibration.json')).isFile());
});

// ---- `heavy -- <cmd…>` (spec §7.8, §7.8a): FIFO queue → lease → start → attachChild → supervise → release ----

const BIN = join(pluginDir, 'bin', names.bin);
// Calm readings unless a test injects its own: heavy is admitted only while the machine check passes (addendum 11).
async function heavy(flags, cmd, { env, cwd, json = true, readings = () => CALM }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)), stdinIsTTY: false, env, cwd, readings };
  const code = await main(['heavy', ...flags, ...(json ? ['--json'] : []), '--', ...cmd], { io });
  return { code, out: out.join(''), err: err.join(''), env: json ? JSON.parse(out.join('')) : null };
}
const nodeCmd = (code) => [process.execPath, '-e', code];
const queued = (data, kind) => (existsSync(join(data, `${kind}-queue`)) ? readdirSync(join(data, `${kind}-queue`)).filter((f) => f.endsWith('.json')) : []);

test('heavy: runs the command under the heavy lease with its env, returns its output in the result and releases the lease when it ends', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const show = nodeCmd(`console.log([process.env.${names.envPrefix}PORT_BASE, process.env.${names.envPrefix}PORT_MAX, process.env.${names.envPrefix}DB_NAME, process.env.${names.envPrefix}SLOT].join(' ')); console.error('to stderr')`);
  const r = await heavy([], show, { env: s.env, cwd });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.equal(r.out.trim().split('\n').length, 1, '--json: exactly one envelope line on stdout');
  assert.equal(r.err, '', 'S2: the CLI prints only its result (lib/cli/output.mjs), never the raw output of the command');
  const lease = r.env.data.lease;
  assert.deepEqual([lease.kind, lease.slot], ['heavy', 1]);
  assert.match(r.env.data.output, new RegExp(`^${lease.ports[0]} ${lease.ports[1]} ${lease.db} heavy-1$`, 'm'), 'the command saw the lease env; its output is in data.output');
  assert.match(r.env.data.output, /^to stderr$/m, 'stdout and stderr of the command both kept');
  assert.deepEqual(leaseFiles(s.data), [], 'released when the command ended');
  const plain = await heavy([], nodeCmd('console.log("hello \\u001b[31mred\\u001b[0m")'), { env: s.env, cwd, json: false });
  assert.equal(plain.code, EXIT.OK);
  assert.match(plain.out, /^hello .*red/m, 'without --json the output is the text of the result');
  assert.doesNotMatch(plain.out, /\u001b/, 'printed through the one writer: no escape sequence reaches the terminal');
  const e2e = await heavy(['--e2e'], show, { env: s.env, cwd });
  assert.equal(e2e.code, EXIT.OK);
  assert.match(e2e.env.data.output, / e2e-1$/m, '--e2e takes the e2e lease');
  // Only the tail is kept: a run printing more than 64 KB keeps its last 64 KB and says how much was left out.
  const big = await heavy([], nodeCmd('for (let i = 0; i < 4000; i++) console.log("line " + i + " " + "x".repeat(40))'), { env: s.env, cwd });
  assert.equal(big.code, EXIT.OK);
  assert.ok(Buffer.byteLength(big.env.data.output) <= 64 * 1024 + 100, 'bounded');
  assert.match(big.env.data.output, /^\[\d+ earlier bytes of output omitted\]$/m);
  assert.match(big.env.data.output, /^line 3999 x+$/m, 'the end of the output is kept');
});

test('heavy: a failing command exits 1 with its status; the time limit exits 6, the no-output limit 5, the queue deadline 3', { timeout: 60000 }, async (t) => {
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const failed = await heavy([], nodeCmd('process.exit(3)'), { env: s.env, cwd });
  assert.equal(failed.code, EXIT.FAIL);
  assert.equal(failed.env.data.status, 3);
  assert.equal(failed.env.errors[0].code, 'command-failed');
  const timed = await heavy(['--timeout', '1'], nodeCmd('setInterval(() => process.stdout.write("."), 50)'), { env: s.env, cwd });
  assert.equal(timed.code, EXIT.BUDGET);
  assert.equal(timed.env.errors[0].code, 'time-limit');
  assert.equal(timed.env.data.ended, 'timeout');
  const idle = await heavy(['--idle', '1'], nodeCmd('process.stdout.write("once\\n"); setInterval(() => {}, 1000)'), { env: s.env, cwd });
  assert.equal(idle.code, EXIT.STALLED);
  assert.equal(idle.env.errors[0].code, 'no-output');
  assert.deepEqual(leaseFiles(s.data), [], 'every run released its lease');
  const held = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-holder') }));
  assert.equal(held.ok, true);
  const waited = await heavy(['--wait', '1'], nodeCmd('0'), { env: s.env, cwd });
  assert.equal(waited.code, EXIT.WAIT);
  assert.equal(waited.env.errors[0].code, 'wait-timeout');
  assert.deepEqual(queued(s.data, 'heavy'), [], 'the ticket was withdrawn');
  sched.release(held.lease, s.ctx());
});

test('addendum 10: heavy has a hard time limit, 45 min by default (--timeout, else <PREFIX>HEAVY_TIMEOUT); on it the group gets SIGTERM, grace, SIGKILL; exit 6; the lease goes after the group', { timeout: 60000 }, async (t) => {
  const { HEAVY_LIMITS } = await import(pathToFileURL(join(pluginDir, 'lib', 'sched', 'cli.mjs')).href);
  assert.equal(HEAVY_LIMITS.timeout.def, 2700, 'default 45 min');
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const envName = `${names.envPrefix}HEAVY_TIMEOUT`;
  const pidFile = join(pidDir(t), 'member');
  const r = await heavy([], nodeCmd(withStubbornMember(pidFile, 'setInterval(() => process.stdout.write("."), 100);')), { env: { ...s.env, [envName]: '1' }, cwd });
  assert.equal(r.code, EXIT.BUDGET);
  assert.equal(r.env.data.ended, 'timeout');
  assert.equal(r.env.errors[0].code, 'time-limit');
  assert.equal(await gone(Number(readFileSync(pidFile, 'utf8')), 2000), true, 'the member that ignored SIGTERM is gone');
  assert.deepEqual(leaseFiles(s.data), [], 'released after the group');
  const flag = await heavy(['--timeout', '1'], nodeCmd('setInterval(() => process.stdout.write("."), 100)'), { env: { ...s.env, [envName]: '600' }, cwd });
  assert.equal(flag.code, EXIT.BUDGET, 'the flag wins over the env');
  const bad = await heavy([], nodeCmd('0'), { env: { ...s.env, [envName]: '1h' }, cwd });
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.env.errors[0].message, new RegExp(envName));
});

test('review r1 6: a child that cannot be recorded in its lease has its group ended before the error goes on', { timeout: 60000 }, async (t) => {
  const { runLeased } = await import(pathToFileURL(join(pluginDir, 'lib', 'sched', 'cli.mjs')).href);
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const dir = pidDir(t);
  const [member, lockedFile] = [join(dir, 'member'), join(s.base, 'locked')];
  const run = (lease, ctx) => runLeased(lease, nodeCmd(withStubbornMember(member, 'setInterval(() => {}, 1000);')), { opts: ctx, env: s.env, cwd, timeoutMs: 60000, idleMs: 60000, graceMs: 300 });
  // (a) attachChild meets lock contention: L holds the scheduler lock until the command's member runs, then 5 s more,
  // so the attach (lock wait 3 s) fails after the whole command is up.
  const got = sched.acquire('heavy', s.ctx());
  const l = spawn(process.execPath, ['--input-type=module', '-e', `
    import { existsSync, writeFileSync } from 'node:fs';
    const { withLock } = await import(${JSON.stringify(FSX_URL)});
    const pause = new Int32Array(new SharedArrayBuffer(4));
    withLock(process.env.LOCK, () => {
      writeFileSync(process.env.LOCKED, '');
      for (const until = Date.now() + 20000; !existsSync(process.env.MEMBER) && Date.now() < until;) Atomics.wait(pause, 0, 0, 10);
      Atomics.wait(pause, 0, 0, 5000);
    });
  `], { env: { ...s.env, LOCK: schedLock(s.data), LOCKED: lockedFile, MEMBER: member }, stdio: 'ignore' });
  t.after(() => { try { l.kill('SIGKILL'); } catch { /* gone */ } });
  await untilFile(lockedFile);
  await assert.rejects(run(got.lease, s.ctx({ lockTimeoutMs: 3000 })), (e) => e.code === 'scheduler-busy');
  assert.equal(await gone(Number(readFileSync(member, 'utf8')), 2000), true, 'the command group (with a member ignoring SIGTERM) is gone');
  await new Promise((res) => { if (l.exitCode !== null) res(); else l.once('exit', res); });
  assert.deepEqual(leaseFiles(s.data), ['heavy-1.json'], 'the lease is left to the caller, released after this');
  sched.release(got.lease, s.ctx());
  // (b) The lease was taken away before the attach: lease-lost, the group is ended.
  rmSync(member, { force: true });
  const lost = sched.acquire('heavy', s.ctx());
  sched.release(lost.lease, s.ctx());
  await assert.rejects(run(lost.lease, s.ctx()), (e) => e.code === 'lease-lost');
});

test('addendum 11: heavy is admitted only when the machine check passes; meanwhile its ticket waits with its FIFO place and deadline', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const BUSY = { ...CALM, load1: 30 };
  const qdir = join(s.data, 'heavy-queue');
  let calls = 0;
  let waiting = null;
  const reading = () => { // busy for two attempts, then calm; the queue is looked at when the machine turns calm
    calls += 1;
    if (calls === 3) waiting = readdirSync(qdir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(qdir, f), 'utf8')));
    return calls < 3 ? BUSY : CALM;
  };
  const r = await heavy(['--wait', '20'], nodeCmd('console.log("ran")'), { env: s.env, cwd, readings: reading });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.ok(calls >= 3, 'the machine was checked until it passed');
  assert.equal(waiting.length, 1, 'the ticket waited in the queue');
  assert.equal(waiting[0].worktree, realpathSync(cwd));
  assert.ok(Date.parse(waiting[0].deadline) > Date.now(), 'with its deadline');
  assert.match(r.env.data.output, /^ran$/m);
  const busy = await heavy(['--wait', '1'], nodeCmd('console.log("never")'), { env: s.env, cwd, readings: () => BUSY });
  assert.equal(busy.code, EXIT.WAIT, 'busy throughout: no slot within --wait');
  assert.match(busy.env.errors[0].message, /load 30\.0 ≥ 17\.0/);
  assert.deepEqual(queued(s.data, 'heavy'), [], 'the ticket was withdrawn');
});

test('heavy: one queue entry per worktree (exit 1); invalid limits and a missing command exit 2; a missing program exits 8', { timeout: 30000 }, async (t) => {
  const s = sandbox(t);
  const cwd = s.dir('wt-a');
  const worktree = realpathSync(cwd);
  mkdirSync(join(s.data, 'heavy-queue'), { recursive: true });
  writeFileSync(join(s.data, 'heavy-queue', `${hash(worktree, 16)}.json`), `${JSON.stringify({ schema: 1, kind: 'heavy', seq: 1, worktree, owner: idOf(process.ppid), task: null, at: iso(), deadline: iso(-3600e3) }, null, 2)}\n`);
  const twice = await heavy([], nodeCmd('0'), { env: s.env, cwd });
  assert.equal(twice.code, EXIT.FAIL);
  assert.equal(twice.env.errors[0].code, 'already-queued');
  for (const flags of [['--timeout', '0'], ['--idle', 'x'], ['--wait', '-1']]) {
    assert.equal((await heavy(flags, nodeCmd('0'), { env: s.env, cwd: s.dir('wt-b') })).code, EXIT.USAGE, flags.join(' '));
  }
  const out = [];
  assert.equal(await main(['heavy', '--json'], { io: { out: (x) => out.push(x), err: () => {}, stdinIsTTY: false, env: s.env, cwd } }), EXIT.USAGE, 'no command');
  const missing = await heavy([], ['no-such-program-zz9'], { env: s.env, cwd: s.dir('wt-c') });
  assert.equal(missing.code, EXIT.ENV);
  assert.deepEqual(leaseFiles(s.data), []);
});

test('heavy: SIGTERM to the runner ends the command group and releases the lease; after SIGKILL the reaper ends the orphan', { timeout: 120000 }, async (t) => {
  const s = sandbox(t);
  // The command reports its pid and its child's pid through a file (its output is shown only when the run ends).
  const long = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(process.env.PIDS + '.tmp', process.pid + ' ' + g.pid); require('node:fs').renameSync(process.env.PIDS + '.tmp', process.env.PIDS); setInterval(() => {}, 1000);`;
  sched.calibrate({ names, env: s.env, loadMax: '9999', freeMin: 1 }); // the runners read this machine: admit them
  const runner = (wt) => {
    const pidFile = join(s.base, `pids-${wt}`);
    const p = spawn(process.execPath, [BIN, 'heavy', '--', process.execPath, '-e', long], { cwd: s.dir(wt), env: { ...s.env, PIDS: pidFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.resume();
    // Waits on what can be observed, with generous deadlines (a busy machine): the command's pids, then the lease
    // naming the command with the store unlocked. The runner records the command after starting it, so the command
    // can report first; a signal before the record would leave the reaper without the orphan, and a SIGKILL while
    // the runner still holds the store lock leaves that lock stale (ESTALE by design).
    const pids = (async () => {
      for (const until = Date.now() + 20000; !existsSync(pidFile);) {
        if (Date.now() > until) throw new Error(`the command did not report its pids within 20 s; runner exit ${p.exitCode}, stderr: ${err}`);
        await pause(20);
      }
      const [cmd, grand] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      let doc = null;
      const storeLock = join(s.data, 'leases', 'lock');
      for (const until = Date.now() + 20000; doc?.child?.pid !== cmd || existsSync(storeLock);) {
        if (Date.now() > until) throw new Error(`the lease did not record the command ${cmd} within 20 s (store locked: ${existsSync(storeLock)}): ${JSON.stringify(doc)}; stderr: ${err}`);
        await pause(20);
        try { doc = leaseDoc(s.data, 'heavy-1'); } catch { doc = null; }
      }
      return [cmd, grand];
    })();
    return { p, pids, exit: new Promise((resolve) => { p.once('exit', (code, signal) => resolve({ code, signal })); }) };
  };
  const a = runner('wt-a');
  const [cmdA, grandA] = await a.pids;
  t.after(() => { for (const pid of [cmdA, grandA]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  assert.equal(leaseDoc(s.data, 'heavy-1').child.pid, cmdA, 'the command is recorded in the lease');
  a.p.kill('SIGTERM');
  const ended = await a.exit;
  assert.equal(ended.code, EXIT.FAIL, 'the command ended by the forwarded signal');
  assert.equal(await gone(cmdA, 20000), true);
  assert.equal(await gone(grandA, 20000), true, 'the whole group');
  assert.deepEqual(leaseFiles(s.data), []);
  const b = runner('wt-b');
  const [cmdB, grandB] = await b.pids;
  t.after(() => { for (const pid of [cmdB, grandB]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  b.p.kill('SIGKILL');
  await b.exit;
  assert.doesNotThrow(() => process.kill(cmdB, 0), 'an orphan until reaped');
  const next = sched.acquire('heavy', s.ctx({ cwd: s.dir('wt-c') }));
  assert.equal(next.ok, true, 'the dead runner\'s lease is reaped');
  assert.equal(await gone(cmdB, 20000), true, 'the orphan command is ended');
  assert.equal(await gone(grandB, 20000), true, 'with its group');
});
