// Crash safety of the file boundary (spec §4.2, §4.3, SD-10): lib/fsx is the only module doing atomic replace,
// exclusive creation and locks, and lib/state writes only through it. A process killed at any point of a write
// leaves the old or the new content, never a partial file; an exclusive create leaves the file complete or
// absent; temporary files of dead processes are swept; a lock gives mutual exclusion across processes and a
// lock left by a dead process is broken. Kills are injected deterministically: the child replaces one node:fs
// function with a SIGKILL of itself (syncBuiltinESMExports), so the kill lands exactly at that call.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const FSX = pathToFileURL(join(pluginDir, 'lib', 'fsx', 'index.mjs')).href;
const fsx = await import(FSX);

function scratch(t, prefix = 'state-atomic-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Children never see the real HOME.
const childEnv = (home) => ({ PATH: process.env.PATH, HOME: home, LANG: 'C' });
const TEMP = /^\.(.+)\.(\d+)\.[0-9a-f]{8}\.tmp$/;
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

// Child prologue: replace node:fs `fn` so that its first call kills the process (a write call first writes half
// of its data, so the kill lands in the middle of writing).
const killAt = (fn) => `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWriteSync = fs.writeSync;
const half = (d) => { const b = Buffer.from(d); return b.subarray(0, b.length >> 1); };
fs[${JSON.stringify(fn)}] = (...a) => {
  if (${JSON.stringify(fn)} === 'writeFileSync' || ${JSON.stringify(fn)} === 'writeSync') realWriteSync(a[0], half(a[1]));
  process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
const fsx = await import(${JSON.stringify(FSX)});
`;
const runChild = (code, home) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: childEnv(home), timeout: 30000 });
// Resolves on the child's first output; rejects when it exits first (a broken child never hangs the test).
const ready = (child) => new Promise((res, rej) => {
  child.stdout.once('data', res);
  child.once('exit', (code, signal) => rej(new Error(`child exited before it was ready (${code ?? signal})`)));
});
const T = { timeout: 300000 };
// unlockStale waits quietMs (default 2 s) for the lock to stay unchanged; the lock semantics tests keep it short
// (the quiescence contract has its own test with the default).
const Q = { quietMs: 50 };
const KILL_POINTS = ['openSync', 'writeFileSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'linkSync'];

test('writeAtomic: a kill at any call leaves the old or the new content; temps of the dead writer are swept', T, (t) => {
  const dir = scratch(t);
  const OLD = `${'o'.repeat(50000)}\n`;
  const NEW = `${'n'.repeat(80000)}\n`;
  let killed = 0;
  for (const fn of KILL_POINTS) {
    const file = join(dir, `${fn}.json`);
    writeFileSync(file, OLD);
    const r = runChild(`${killAt(fn)}fsx.writeAtomic(${JSON.stringify(file)}, ${JSON.stringify(NEW)});`, dir);
    const now = readFileSync(file, 'utf8');
    assert.ok(now === OLD || now === NEW, `${fn}: partial content (${now.length} chars)`);
    if (r.signal === 'SIGKILL') killed++;
    else assert.equal(r.status, 0, `${fn}: ${r.stderr}`);
  }
  assert.ok(killed >= 4, `the kill points were reached (${killed})`);
  // The dead writers' temporary files are swept; the targets stay.
  assert.ok(readdirSync(dir).some((f) => TEMP.test(f)), 'a kill before rename leaves a temporary file');
  fsx.sweepTemps(dir);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.')), []);
  assert.equal(readdirSync(dir).length, KILL_POINTS.length);
});

test('writeAtomic under kills at random moments: the target is always one complete version', T, async (t) => {
  const dir = scratch(t);
  const file = join(dir, 'big.json');
  const size = 1 << 21;
  const code = `const fsx = await import(${JSON.stringify(FSX)});
const a = 'a'.repeat(${size}); const b = 'b'.repeat(${size});
for (let i = 0; ; i++) { fsx.writeAtomic(${JSON.stringify(file)}, i % 2 ? a : b); if (i === 0) process.stdout.write('ready\\n'); }`;
  for (let round = 0; round < 8; round++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(dir), stdio: ['ignore', 'pipe', 'inherit'] });
    await ready(child);
    await new Promise((res) => setTimeout(res, 5 + Math.floor(Math.random() * 60)));
    child.kill('SIGKILL');
    await new Promise((res) => child.once('exit', res));
    const now = readFileSync(file, 'utf8');
    assert.equal(now.length, size, `round ${round}: partial file`);
    assert.ok(/^(a+|b+)$/.test(now), `round ${round}: mixed content`);
  }
});

test('createExclusive: a kill at any call leaves the file complete or absent', T, (t) => {
  const dir = scratch(t);
  const DATA = `${'x'.repeat(60000)}\n`;
  let killed = 0;
  for (const fn of KILL_POINTS) {
    const file = join(dir, `${fn}.json`);
    const r = runChild(`${killAt(fn)}fsx.createExclusive(${JSON.stringify(file)}, ${JSON.stringify(DATA)});`, dir);
    if (existsSync(file)) { const now = readFileSync(file, 'utf8'); assert.ok(now === DATA, `${fn}: partial file (${now.length} of ${DATA.length} chars)`); }
    if (r.signal === 'SIGKILL') killed++;
    else { assert.equal(r.status, 0, `${fn}: ${r.stderr}`); assert.ok(existsSync(file), `${fn}: created`); }
  }
  assert.ok(killed >= 4, `the kill points were reached (${killed})`);
  fsx.sweepTemps(dir);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.')), [], 'leftovers swept');
});

test('createExclusive: of N racing processes exactly one creates the file, with its complete content', T, async (t) => {
  const dir = scratch(t);
  const file = join(dir, 'claim.json');
  const go = join(dir, 'go');
  const n = 8;
  const code = (k) => `const fsx = await import(${JSON.stringify(FSX)});
const { existsSync } = await import('node:fs');
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 1);
process.stdout.write(String(fsx.createExclusive(${JSON.stringify(file)}, ${JSON.stringify(String(k))}.repeat(200000))));`;
  const runs = Array.from({ length: n }, (_, k) => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code(k)], { env: childEnv(dir) });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (status) => res({ status, out, k }));
  }));
  writeFileSync(go, '');
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.status, 0);
  const winners = results.filter((r) => r.out === 'true');
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.ok(readFileSync(file, 'utf8') === String(winners[0].k).repeat(200000), 'the winner content, complete');
  assert.deepEqual(readdirSync(dir).sort(), ['claim.json', 'go']);
});

test('sweepTemps removes only temporary files of dead processes', T, (t) => {
  const dir = scratch(t);
  const dead = `.doc.json.${deadPid()}.0123abcd.tmp`;
  const alive = `.doc.json.${process.pid}.0123abcd.tmp`;
  for (const f of [dead, alive, '.doc.json.notapid.tmp', 'doc.json', '.hidden']) writeFileSync(join(dir, f), 'x');
  assert.equal(fsx.sweepTemps(dir), 1);
  assert.deepEqual(readdirSync(dir).sort(), [alive, '.doc.json.notapid.tmp', '.hidden', 'doc.json'].sort());
  assert.equal(fsx.sweepTemps(join(dir, 'missing')), 0, 'a missing directory is not an error');
});

// N processes increment one counter under the lock, with a stale lock of a dead process present at the start.
// Without mutual exclusion increments are lost; without the takeover nobody gets in.
// A dead process's lock. Taken a year ago: a process that reuses its pid meanwhile started later, so it is not
// the owner (the plant stays stale under heavy process churn).
const stalePlant = (lock, extra = {}) => { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: deadPid(), token: `${deadPid()}.0123456789abcdef`, host: hostname(), startedAt: new Date(Date.now() - 365 * 86400000).toISOString(), ...extra })); };
test('withLock: mutual exclusion across processes', T, async (t) => {
  const dir = scratch(t);
  const counter = join(dir, 'counter');
  const lock = join(dir, 'counter.lock');
  const go = join(dir, 'go');
  writeFileSync(counter, '0');
  const n = 6;
  const times = 25;
  const code = `const fsx = await import(${JSON.stringify(FSX)});
const { existsSync, readFileSync } = await import('node:fs');
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 1);
for (let i = 0; i < ${times}; i++) fsx.withLock(${JSON.stringify(lock)}, () => {
  const v = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
  Atomics.wait(sleep, 0, 0, 1);
  fsx.writeAtomic(${JSON.stringify(counter)}, String(v + 1));
}, { timeoutMs: 60000 });`;
  const runs = Array.from({ length: n }, () => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(dir), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => res({ status, err }));
  }));
  writeFileSync(go, '');
  for (const r of await Promise.all(runs)) assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(counter, 'utf8'), String(n * times));
  assert.ok(!existsSync(lock), 'the lock is released');
  assert.deepEqual(readdirSync(dir).sort(), ['counter', 'go']);
});

// findings-r3: a lock left by a dead process is never taken over; only unlockStale (explicit) removes it, and it
// refuses a lock whose owner runs. It also clears leftovers of dead processes next to the lock.
test('a stale lock refuses every waiter (ESTALE) until unlockStale removes it; unlockStale never removes a live lock', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 's.lock');
  stalePlant(lock);
  const dead = deadPid();
  mkdirSync(`${lock}.new-${dead}-${dead}.0123456789abcdef`);
  mkdirSync(`${lock}.unlock-${dead}-0123456789abcdef`);
  for (let i = 0; i < 3; i++) assert.throws(() => fsx.withLock(lock, () => 1, { timeoutMs: 2000 }), (e) => e.code === 'ESTALE' && /no longer running/.test(e.message));
  assert.ok(existsSync(join(lock, 'owner.json')), 'nobody took it over');
  const r = fsx.unlockStale(lock, Q);
  assert.equal(r.removed, true);
  assert.deepEqual(readdirSync(dir), [], 'the lock and the dead leftovers are gone');
  assert.deepEqual(fsx.unlockStale(lock, Q), { removed: false, owner: null }, 'nothing to remove');
  // A running owner: refused, the lock stays.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `const fsx = await import(${JSON.stringify(FSX)});
fsx.withLock(${JSON.stringify(lock)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });`], { env: childEnv(dir), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await ready(holder);
  const bytes = readFileSync(join(lock, 'owner.json'), 'utf8');
  assert.throws(() => fsx.unlockStale(lock, Q), (e) => e.code === 'EBUSY' && /running process/.test(e.message));
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), bytes, 'the live lock is untouched');
  holder.kill('SIGKILL');
  await new Promise((res) => holder.once('exit', res));
  assert.equal(fsx.unlockStale(lock, Q).removed, true, 'removed once its owner is gone');
});

test('withLock: a live holder makes a waiter time out; once it dies its lock refuses (ESTALE) until unlocked; no nesting', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'x.lock');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `const fsx = await import(${JSON.stringify(FSX)});
fsx.withLock(${JSON.stringify(lock)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });`], { env: childEnv(dir), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await ready(holder);
  const started = Date.now();
  assert.throws(() => fsx.withLock(lock, () => 1, { timeoutMs: 300 }), (e) => e.code === 'ELOCKED' && /pid \d+/.test(e.message));
  // A ceiling, not a speed check: a waiter that never gave up would hang the test (S3: loaded gates).
  assert.ok(Date.now() - started < 60000, 'the waiter gives up after its timeout');
  holder.kill('SIGKILL');
  await new Promise((res) => holder.once('exit', res));
  assert.throws(() => fsx.withLock(lock, () => 42, { timeoutMs: 5000 }), (e) => e.code === 'ESTALE', 'a dead holder\'s lock is not taken over');
  assert.equal(fsx.unlockStale(lock, Q).removed, true);
  assert.equal(fsx.withLock(lock, () => 42), 42);
  assert.ok(!existsSync(lock));
  // Nesting is a programming error; the outer lock stays and is released by the outer call.
  assert.throws(() => fsx.withLock(lock, () => fsx.withLock(lock, () => 0, { timeoutMs: 1000 })), (e) => e.code === 'EREENTRANT');
  assert.ok(!existsSync(lock), 'released after the outer call');
  // An error in the body releases the lock and propagates.
  assert.throws(() => fsx.withLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(lock));
});

// Another host's lock: a wait while younger than the TTL (its pid means nothing here), stale after.
test('withLock: a lock of another host is stale only after the TTL, and only unlockStale removes it', T, (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'h.lock');
  stalePlant(lock, { pid: process.pid, host: 'another-host', startedAt: new Date().toISOString() });
  assert.throws(() => fsx.withLock(lock, () => 1, { timeoutMs: 200, ttlMs: 60000 }), (e) => e.code === 'ELOCKED' && /another-host/.test(e.message));
  assert.throws(() => fsx.unlockStale(lock, { ttlMs: 60000, ...Q }), (e) => e.code === 'EBUSY', 'young: not removed');
  const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ ...owner, startedAt: new Date(Date.now() - 3600000).toISOString() }));
  assert.throws(() => fsx.withLock(lock, () => 2, { timeoutMs: 2000, ttlMs: 60000 }), (e) => e.code === 'ESTALE');
  assert.equal(fsx.unlockStale(lock, { ttlMs: 60000, ...Q }).removed, true);
  assert.equal(fsx.withLock(lock, () => 3), 3);
  assert.deepEqual(readdirSync(dir), []);
});

// ---- Review round 1 (findings-r1.md items 3, 4, 5, 8) ----

// Two spellings of one lock (a directory alias, and a case variant on a case-insensitive volume) are one lock: a
// nested acquisition through the other spelling is the same programming error (EREENTRANT), not a second lock.
test('lock identity is the lock, not the path string: a nested acquisition through an alias is refused, the outer lock stays', T, (t) => {
  const dir = realpathSync(scratch(t));
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'alias'));
  const outer = join(dir, 'real', 'same.lock');
  writeFileSync(join(dir, 'probe'), '');
  const foldsCase = existsSync(join(dir, 'PROBE')) && statSync(join(dir, 'PROBE')).ino === statSync(join(dir, 'probe')).ino;
  const upper = join(dir, 'real', 'SAME.lock');
  for (const inner of foldsCase ? [join(dir, 'alias', 'same.lock'), upper] : [join(dir, 'alias', 'same.lock')]) {
    assert.throws(() => fsx.withLock(outer, () => {
      try { return fsx.withLock(inner, () => 'entered', { timeoutMs: 1000 }); } finally { assert.ok(existsSync(join(outer, 'owner.json')), `${inner}: the outer lock stays`); }
    }), (e) => e.code === 'EREENTRANT', inner);
    assert.ok(!existsSync(outer), 'released after the outer call');
  }
  if (!foldsCase) assert.equal(fsx.withLock(outer, () => fsx.withLock(upper, () => existsSync(outer) && existsSync(upper))), true, 'a case-sensitive volume: two locks');
});

// ---- Review round 2 ----
// Item D (rereview-r1) / findings-r2 point 4: no fallback without hard links. createExclusive refuses with
// EFSUNSUPPORTED, writes no destination and leaves no temporary file — also when killed at any call.
test('createExclusive without hard links refuses (EFSUNSUPPORTED) and leaves nothing, even when killed (rereview item D)', T, (t) => {
  const dir = scratch(t);
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
    for (const fn of [null, 'openSync', 'renameSync', 'closeSync']) {
      const file = join(dir, `${code}-${fn}.json`);
      const r = runChild(`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fsx = await import(${JSON.stringify(FSX)});
const real = { ...fs };
let armed = false;
fs.linkSync = () => { armed = true; throw Object.assign(new Error('no hard links'), { code: ${JSON.stringify(code)} }); };
if (${JSON.stringify(fn)}) fs[${JSON.stringify(fn)}] = (...a) => { if (armed) process.kill(process.pid, 'SIGKILL'); return real[${JSON.stringify(fn)}](...a); };
syncBuiltinESMExports();
let out;
try { out = fsx.createExclusive(${JSON.stringify(file)}, 'content'); } catch (e) { out = e.code; }
process.stdout.write(JSON.stringify(out));`, dir);
      if (r.signal !== 'SIGKILL') {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout), 'EFSUNSUPPORTED', `${code} ${fn}: refused`);
      }
      assert.equal(existsSync(file), false, `${code} ${fn}: no destination (not even an empty one)`);
    }
  }
  fsx.sweepTemps(dir);
  assert.deepEqual(readdirSync(dir), [], 'no temporary file left by refusals; killed writers\' temps swept');
});

// Item A (rereview-r1), in the lock layout of round 2: A sees the stale owner X and is delayed; B takes the lock
// over and holds it; A then acts on its old observation. C must not enter while B holds, and neither may A.
// (Merge-gate fix: A re-reads the lock before calling it stale, finds B's live lock and waits for it; before, it
// refused with ESTALE, a false report of a gone owner while B held the lock.)
test('a delayed taker acting on an old stale observation never lets a third process in while the owner holds (rereview item A)', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'a.lock');
  const f = (n) => join(dir, n);
  stalePlant(lock);
  const wait = (name) => `while (!fs.existsSync(${JSON.stringify(f(name))})) Atomics.wait(sleep, 0, 0, 2);`;
  const prologue = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fsx = await import(${JSON.stringify(FSX)});
const sleep = new Int32Array(new SharedArrayBuffer(4));
const real = { readFileSync: fs.readFileSync, renameSync: fs.renameSync };`;
  const spawnOf = (code) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(dir), stdio: ['ignore', 'ignore', 'inherit'] }); const done = new Promise((r) => c.once('exit', r)); t.after(() => c.kill('SIGKILL')); return done; };
  const inside = (who) => `fs.writeFileSync(${JSON.stringify(f(`${who}-in`))}, String(fs.existsSync(${JSON.stringify(f('B-in'))}) && !fs.existsSync(${JSON.stringify(f('B-out'))})))`;
  const a = spawnOf(`${prologue}
let looked = false;
fs.readFileSync = (p, ...x) => { const out = real.readFileSync(p, ...x); if (!looked && String(p) === ${JSON.stringify(join(lock, 'owner.json'))}) { looked = true; fs.writeFileSync(${JSON.stringify(f('A-looked'))}, ''); ${wait('goA')} } return out; };
syncBuiltinESMExports();
try { fsx.withLock(${JSON.stringify(lock)}, () => ${inside('A')}, { timeoutMs: 20000 }); } catch {}`);
  const waitFor = async (name, ms = 60000) => { for (const end = performance.now() + ms; performance.now() < end && !existsSync(f(name));) await new Promise((r) => setTimeout(r, 5)); return existsSync(f(name)); };
  assert.ok(await waitFor('A-looked'), 'A looked at the stale owner');
  const b = spawnOf(`${prologue}
fsx.unlockStale(${JSON.stringify(lock)}, ${JSON.stringify(Q)}); // findings-r3: removing a stale lock is an explicit act
fsx.withLock(${JSON.stringify(lock)}, () => { fs.writeFileSync(${JSON.stringify(f('B-in'))}, ''); ${wait('releaseB')} fs.writeFileSync(${JSON.stringify(f('B-out'))}, ''); }, { timeoutMs: 20000 });`);
  assert.ok(await waitFor('B-in'), 'B removed the stale lock and holds a new one');
  writeFileSync(f('goA'), '');
  await new Promise((r) => setTimeout(r, 300)); // A acts on its old observation
  const c = spawnOf(`${prologue}
try { fsx.withLock(${JSON.stringify(lock)}, () => ${inside('C')}, { timeoutMs: 700 }); } catch {}`);
  await c;
  const cWhileB = existsSync(f('C-in')) && readFileSync(f('C-in'), 'utf8') === 'true';
  const aWhileB = existsSync(f('A-in')) && readFileSync(f('A-in'), 'utf8') === 'true';
  writeFileSync(f('releaseB'), '');
  await Promise.all([a, b]);
  assert.equal(cWhileB, false, 'C entered while B held the lock');
  assert.equal(aWhileB, false, 'A entered while B held the lock');
  assert.equal(readFileSync(f('A-in'), 'utf8'), 'false', 'A, not acting on its old look, waited for B and entered after it released');
});

// Found while running the suite: another process removing the lock's parent it created (and left empty) can
// make the next mkdir of a prepared lock fail with ENOENT, or EINVAL on macOS; the waiter recreates the parent
// and tries again.
test('withLock: a parent directory vanishing under a waiter (ENOENT or EINVAL) is recreated', T, (t) => {
  const dir = scratch(t);
  for (const code of ['ENOENT', 'EINVAL']) {
    const lock = join(dir, code, 'p.lock');
    const r = runChild(`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fsx = await import(${JSON.stringify(FSX)});
const real = fs.mkdirSync;
let failed = false;
fs.mkdirSync = (p, ...a) => { if (!failed && String(p).includes('p.lock.new-')) { failed = true; fs.rmSync(${JSON.stringify(join(dir, code))}, { recursive: true }); throw Object.assign(new Error('vanished'), { code: ${JSON.stringify(code)} }); } return real(p, ...a); };
syncBuiltinESMExports();
process.stdout.write(String(fsx.withLock(${JSON.stringify(lock)}, () => 'in', { timeoutMs: 2000 })));`, dir);
    assert.equal(r.status, 0, `${code}: ${r.stderr}`);
    assert.equal(r.stdout, 'in');
  }
});

// ---- Review round 3 (closing) ----
// Item 1 (rereview-r2): the stale lock is older than the TTL. A reads its owner X and is delayed; B gets the
// lock; A then acts on its old observation (round 2: renames the lock, which is B's by now). C must never enter
// while B holds, and neither may A.
test('an old stale lock: a delayed process acting on its old observation never lets C in while B holds (rereview-r2 item 1)', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'o.lock');
  const f = (n) => join(dir, n);
  stalePlant(lock);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(join(lock, 'owner.json'), old, old);
  utimesSync(lock, old, old);
  const wait = (name) => `while (!fs.existsSync(${JSON.stringify(f(name))})) Atomics.wait(sleep, 0, 0, 2);`;
  const prologue = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fsx = await import(${JSON.stringify(FSX)});
const sleep = new Int32Array(new SharedArrayBuffer(4));
const real = { readFileSync: fs.readFileSync, renameSync: fs.renameSync };`;
  const spawnOf = (code) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(dir), stdio: ['ignore', 'ignore', 'inherit'] }); const done = new Promise((r) => c.once('exit', r)); t.after(() => c.kill('SIGKILL')); return done; };
  const inside = (who) => `fs.writeFileSync(${JSON.stringify(f(`${who}-in`))}, String(fs.existsSync(${JSON.stringify(f('B-in'))}) && !fs.existsSync(${JSON.stringify(f('B-out'))})))`;
  // A pauses after its first look at X, and again right after moving the lock (if it ever does) while B holds.
  const a = spawnOf(`${prologue}
let looked = false; let moved = false;
fs.readFileSync = (p, ...x) => { const out = real.readFileSync(p, ...x); if (!looked && String(p) === ${JSON.stringify(join(lock, 'owner.json'))}) { looked = true; fs.writeFileSync(${JSON.stringify(f('A-looked'))}, ''); ${wait('goA')} } return out; };
fs.renameSync = (src, ...x) => { const out = real.renameSync(src, ...x); if (!moved && String(src) === ${JSON.stringify(lock)} && fs.existsSync(${JSON.stringify(f('B-in'))})) { moved = true; fs.writeFileSync(${JSON.stringify(f('A-moved'))}, ''); ${wait('goA2')} } return out; };
syncBuiltinESMExports();
try { fsx.withLock(${JSON.stringify(lock)}, () => ${inside('A')}, { timeoutMs: 20000 }); } catch {}`);
  const waitFor = async (name, ms = 60000) => { for (const end = performance.now() + ms; performance.now() < end && !existsSync(f(name));) await new Promise((r) => setTimeout(r, 5)); return existsSync(f(name)); };
  assert.ok(await waitFor('A-looked'), 'A looked at the stale owner');
  // B gets the lock (round 2: by an automatic takeover).
  const b = spawnOf(`${prologue}
fsx.unlockStale(${JSON.stringify(lock)}, ${JSON.stringify(Q)}); // findings-r3: removing a stale lock is an explicit act
fsx.withLock(${JSON.stringify(lock)}, () => { fs.writeFileSync(${JSON.stringify(f('B-in'))}, ''); ${wait('releaseB')} fs.writeFileSync(${JSON.stringify(f('B-out'))}, ''); }, { timeoutMs: 20000 });`);
  assert.ok(await waitFor('B-in'), 'B holds the lock');
  writeFileSync(f('goA'), '');
  await waitFor('A-moved', 1500);
  const c = spawnOf(`${prologue}
try { fsx.withLock(${JSON.stringify(lock)}, () => ${inside('C')}, { timeoutMs: 700 }); } catch {}`);
  await c;
  const cWhileB = existsSync(f('C-in')) && readFileSync(f('C-in'), 'utf8') === 'true';
  const aWhileB = existsSync(f('A-in')) && readFileSync(f('A-in'), 'utf8') === 'true';
  writeFileSync(f('goA2'), '');
  writeFileSync(f('releaseB'), '');
  await Promise.all([a, b]);
  assert.equal(cWhileB, false, 'C entered while B held the lock');
  assert.equal(aWhileB, false, 'A entered while B held the lock');
});

// unlockStale must not move a live lock aside even for a moment: while it is aside, another process could
// create the lock and enter while the live owner still works.
test('unlockStale never moves a live lock aside, not even briefly', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'u.lock');
  const f = (n) => join(dir, n);
  const wait = (name) => `while (!fs.existsSync(${JSON.stringify(f(name))})) Atomics.wait(sleep, 0, 0, 2);`;
  const prologue = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fsx = await import(${JSON.stringify(FSX)});
const sleep = new Int32Array(new SharedArrayBuffer(4));`;
  const spawnOf = (code) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(dir), stdio: ['ignore', 'ignore', 'inherit'] }); const done = new Promise((r) => c.once('exit', r)); t.after(() => c.kill('SIGKILL')); return done; };
  const b = spawnOf(`${prologue}
fsx.withLock(${JSON.stringify(lock)}, () => { fs.writeFileSync(${JSON.stringify(f('B-in'))}, ''); ${wait('releaseB')} fs.writeFileSync(${JSON.stringify(f('B-out'))}, ''); }, { timeoutMs: 20000 });`);
  const waitFor = async (name, ms = 60000) => { for (const end = performance.now() + ms; performance.now() < end && !existsSync(f(name));) await new Promise((r) => setTimeout(r, 5)); return existsSync(f(name)); };
  assert.ok(await waitFor('B-in'));
  // The unlocking process pauses right after any move of the lock, which is when C would get in.
  const u = spawnOf(`${prologue}
const real = fs.renameSync;
fs.renameSync = (src, ...x) => { const out = real(src, ...x); if (String(src) === ${JSON.stringify(lock)}) { fs.writeFileSync(${JSON.stringify(f('U-moved'))}, ''); ${wait('goU')} } return out; };
syncBuiltinESMExports();
try { fsx.unlockStale(${JSON.stringify(lock)}, ${JSON.stringify(Q)}); } catch (e) { fs.writeFileSync(${JSON.stringify(f('U-said'))}, e.code); }`);
  await waitFor('U-moved', 1500);
  const c = spawnOf(`${prologue}
try { fsx.withLock(${JSON.stringify(lock)}, () => fs.writeFileSync(${JSON.stringify(f('C-in'))}, String(fs.existsSync(${JSON.stringify(f('B-in'))}) && !fs.existsSync(${JSON.stringify(f('B-out'))}))), { timeoutMs: 500 }); } catch {}`);
  await c;
  writeFileSync(f('goU'), '');
  await u;
  writeFileSync(f('releaseB'), '');
  await b;
  assert.equal(existsSync(f('C-in')) && readFileSync(f('C-in'), 'utf8'), false, 'C entered while B held the lock');
  assert.equal(readFileSync(f('U-said'), 'utf8'), 'EBUSY', 'unlockStale refused the live lock');
});

// ---- Merge-gate defect (zombies, pid reuse) ----
// A lock holder that exited but was not reaped by its parent is a zombie: kill(pid, 0) still succeeds for it.
// Its lock must count as left by a gone process (ESTALE at once), not as held (a wait until the deadline).
test('a lock whose owner is a zombie is stale (ESTALE), not held', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'z.lock');
  const f = (n) => join(dir, n);
  // sh starts the holder, then becomes `sleep`, which never reaps it: the holder exits holding the lock.
  const holder = `const fsx = await import(${JSON.stringify(FSX)}); const fs = await import('node:fs');
fsx.withLock(${JSON.stringify(lock)}, () => { fs.writeFileSync(${JSON.stringify(f('pid.tmp'))}, String(process.pid)); fs.renameSync(${JSON.stringify(f('pid.tmp'))}, ${JSON.stringify(f('pid'))}); process.exit(0); });`;
  writeFileSync(f('holder.mjs'), holder);
  const parent = spawn('/bin/sh', ['-c', `"${process.execPath}" "${f('holder.mjs')}" & exec sleep 600`], { env: childEnv(dir), stdio: 'ignore' });
  t.after(() => parent.kill('SIGKILL'));
  // Waits bounded by generous deadlines, not by speed (S3: loaded gates). The holder renames its pid file into place,
  // so a holder descheduled mid-write is never read as an empty file (pid 0).
  for (const end = performance.now() + 60000; !existsSync(f('pid'));) {
    if (performance.now() > end) assert.fail(`the holder did not write its pid within 60 s (files: ${readdirSync(dir).join(', ')})`);
    await new Promise((r) => setTimeout(r, 5));
  }
  const pid = Number(readFileSync(f('pid'), 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, `the holder's pid: ${pid}`);
  const stat = () => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  for (const end = performance.now() + 60000; performance.now() < end && !stat().startsWith('Z');) await new Promise((r) => setTimeout(r, 10));
  assert.match(stat(), /^Z/, `the holder is a zombie (pid ${pid} within 60 s)`);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, true, 'kill(pid, 0) still succeeds for a zombie');
  // Refused as stale (ESTALE), not after waiting out the deadline (that ends in ELOCKED); no speed check.
  assert.throws(() => fsx.withLock(lock, () => 1, { timeoutMs: 60000 }), (e) => e.code === 'ESTALE');
  assert.equal(fsx.unlockStale(lock, Q).removed, true, 'and the explicit unlock removes it');
});

// The owner's pid now belongs to another process that started after the lock was taken (pid reuse): stale.
test('a lock whose pid was reused by a later process is stale (ESTALE), not held', T, async (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'r.lock');
  const later = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => later.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  stalePlant(lock, { pid: later.pid, startedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  // Refused as stale (ESTALE), not after waiting out the deadline (that ends in ELOCKED); no speed check.
  assert.throws(() => fsx.withLock(lock, () => 1, { timeoutMs: 60000 }), (e) => e.code === 'ESTALE');
  // The same pid with a lock taken after it started is its own: held, waited for, then ELOCKED.
  rmSync(lock, { recursive: true });
  stalePlant(lock, { pid: later.pid, startedAt: new Date().toISOString() });
  assert.throws(() => fsx.withLock(lock, () => 1, { timeoutMs: 300 }), (e) => e.code === 'ELOCKED');
});

// A waiter that finds the lock free but loses every creation race (here: the rename into place always finds a
// lock) gives up at its deadline with ELOCKED; it does not spin forever.
test('withLock: a lock that is free on every look but never won ends at the deadline with ELOCKED', T, (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'w.lock');
  const code = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRename = fs.renameSync;
fs.renameSync = (a, b) => { if (String(a).includes('.new-')) throw Object.assign(new Error('lost'), { code: 'ENOTEMPTY' }); return realRename(a, b); };
syncBuiltinESMExports();
const fsx = await import(${JSON.stringify(FSX)});
try { fsx.withLock(${JSON.stringify(lock)}, () => 1, { timeoutMs: 300 }); console.log('taken'); } catch (e) { console.log(e.code); }
`;
  const r = runChild(code, dir);
  assert.equal(r.error?.code, undefined, `the waiter ended (${r.error?.code})`);
  assert.equal(r.stdout.trim(), 'ELOCKED', r.stderr);
});

// No unbounded waits: a lock wait without a finite deadline is refused before anything is touched.
test('withLock: a timeout that is not a finite number of ms is refused', (t) => {
  const dir = scratch(t);
  for (const timeoutMs of [Infinity, Number.NaN, -1]) {
    assert.throws(() => fsx.withLock(join(dir, 'i.lock'), () => 1, { timeoutMs }), TypeError, String(timeoutMs));
  }
  assert.deepEqual(readdirSync(dir), []);
});

// S3 contract: unlockStale is the explicit `state unlock --stale` for a store nobody is using. It removes a lock
// only when the owner is gone at two reads 2 s apart and the lock did not change in between; otherwise it refuses
// (EBUSY) and touches nothing (no put-back). Changes during the wait are made by the unlocking process itself, at
// its wait, so each case is deterministic.
test('unlockStale removes only a dead owner\'s lock that stays unchanged for 2 s; otherwise EBUSY, nothing touched (S3)', T, (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'q.lock');
  const owner = (pid, extra = {}) => JSON.stringify({ pid, token: `${pid}.0123456789abcdef`, host: hostname(), startedAt: new Date().toISOString(), ...extra });
  const plant = (bytes) => { rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), bytes); };
  const dead = owner(deadPid(), { startedAt: new Date(Date.now() - 365 * 86400000).toISOString() });
  const live = owner(process.pid);
  // during: code run by the unlocker when it starts its 2 s wait; atRename: code run instead of its first rename.
  const unlock = ({ during = '', atRename = '' } = {}) => runChild(`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const lock = ${JSON.stringify(lock)};
const realWait = Atomics.wait;
Atomics.wait = (...a) => { if (a[3] === 2000) { ${during} } return realWait(...a); };
const realRename = fs.renameSync;
let renamed = false;
fs.renameSync = (...a) => { if (!renamed && String(a[0]) === lock) { renamed = true; ${atRename} } return realRename(...a); };
syncBuiltinESMExports();
const fsx = await import(${JSON.stringify(FSX)});
const started = Date.now();
let out;
try { out = fsx.unlockStale(lock).removed; } catch (e) { out = e.code + ' ' + e.message; }
process.stdout.write(JSON.stringify({ out, ms: Date.now() - started }));`, dir);
  const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const leftovers = () => readdirSync(dir).filter((n) => n.startsWith('q.lock.'));

  // A live owner: refused at once.
  plant(live);
  let r = result(unlock());
  assert.match(r.out, /^EBUSY .*running process/);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), live, 'the live lock is untouched');
  // The owner looked gone, but during the wait its lock was replaced by a live process's lock (the release of
  // one owner and the take of the next): refused, the new lock untouched.
  plant(dead);
  r = result(unlock({ during: `fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock); fs.writeFileSync(lock + '/owner.json', ${JSON.stringify(live)});` }));
  assert.match(r.out, /^EBUSY .*changed within 2000 ms/);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), live, 'the new lock is untouched');
  // The lock went away during the wait: refused.
  plant(dead);
  r = result(unlock({ during: 'fs.rmSync(lock, { recursive: true });' }));
  assert.match(r.out, /^EBUSY .*changed/);
  // The lock went away right before the move aside: refused, nothing moved.
  plant(dead);
  r = result(unlock({ atRename: 'fs.rmSync(lock, { recursive: true });' }));
  assert.match(r.out, /^EBUSY .*removed meanwhile/);
  assert.deepEqual(leftovers(), []);
  // A dead owner's lock that stays unchanged: removed, after the 2 s wait.
  plant(dead);
  r = result(unlock());
  assert.equal(r.out, true);
  assert.ok(r.ms >= 1900, `it waited ${r.ms} ms`);
  assert.ok(!existsSync(lock));
  assert.deepEqual(leftovers(), []);
});
