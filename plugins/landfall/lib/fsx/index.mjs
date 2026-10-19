// File boundary (spec §4.2, §4.3): the only module doing atomic replace, O_EXCL creation and file locks.
// Crash safety: a process killed at any point leaves the old or the new content (writeAtomic) and a file that is
// complete or absent (createExclusive), never a partial or empty file.
// writeAtomic: temporary file in the same directory, fsync, rename over the target, fsync of the directory.
// createExclusive: complete, fsynced temporary file, then link(2) to the target, which fails when the target
// exists (never overwrites). A file system without hard links is refused (EFSUNSUPPORTED); no fallback.
// Temporary files are named `.<target>.<pid>.<8 hex>.tmp`; sweepTemps removes those of dead processes.
//
// withLock (findings-r2 point 2, findings-r3): a lock is the directory <lock> holding owner.json { pid, token,
// host, startedAt, procStart }. It is prepared complete as <lock>.new-<pid>-<token> and renamed into place; the
// rename fails while a lock exists, so one process holds it and a lock always names its owner. The owner
// releases by renaming its lock to <lock>.released-<token> and removing it.
// The owner is gone when its pid is not running on this host (kill(0) fails, the process is a zombie, or the pid
// was reused by a process started after the lock was taken; processInfo), or, for another host's lock, when the
// lock is older than the TTL. Every wait has a deadline and ends in a typed error (ELOCKED).
// A lock whose owner is gone (its pid dead on this host, or another host's lock older than the TTL) is never
// taken over automatically: withLock fails with ESTALE, and only unlockStale, an explicit action for a store
// nobody is using, removes it.
// Acquiring a lock this process already holds (under any spelling of its path) fails with EREENTRANT: a nested
// critical section is a programming error.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { run } from '../proc/index.mjs';

const TEMP = /^\.(.+)\.(\d+)\.[0-9a-f]{8}\.tmp$/;
// link(2) errors meaning "this file system has no hard links".
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
export const LOCK_TTL_MS = 10 * 60 * 1000;

const hex = (n) => randomBytes(n).toString('hex');
const tempFor = (file) => join(dirname(file), `.${basename(file)}.${process.pid}.${hex(4)}.tmp`);
const quiet = (fn) => { try { fn(); } catch { /* best effort */ } };

function writeNew(path, data, mode) {
  let fd;
  try {
    fd = openSync(path, 'wx', mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) quiet(() => closeSync(fd));
    throw err;
  }
}

// Durability of a rename or link: best effort (some platforms cannot fsync a directory).
function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch { /* not supported here */ } finally {
    if (fd !== undefined) quiet(() => closeSync(fd));
  }
}

export function writeAtomic(file, data, { mode = 0o644 } = {}) {
  const tmp = tempFor(file);
  try {
    writeNew(tmp, data, mode);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dirname(file));
}

export function createExclusive(file, data = '', { mode = 0o644 } = {}) {
  const tmp = tempFor(file);
  try {
    writeNew(tmp, data, mode);
    try {
      linkSync(tmp, file);
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (NO_LINKS.has(err.code)) throw Object.assign(new Error(`${file}: the file system has no hard links (${err.code}), so a file cannot be created exclusively`), { code: 'EFSUNSUPPORTED' });
      throw err;
    }
    syncDir(dirname(file));
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Creates `dir` with its missing parents; returns the topmost directory created (undefined when none was).
export const makeDirs = (dir) => mkdirSync(dir, { recursive: true });

// Removes `leaf` and its parents up to `top` (made by makeDirs) while they are empty.
export function removeEmptyDirs(leaf, top) {
  if (!top) return;
  for (let d = leaf; d.startsWith(top); d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return; // not empty (another process uses it) or already gone
    }
    if (d === top) return;
  }
}

// Removes a file or a directory tree; a symbolic link is removed itself, never followed. A missing path is fine.
export const removeTree = (path) => rmSync(path, { recursive: true, force: true });

// True when a process with this pid exists (EPERM: it exists but belongs to another user).
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Removes temporary files of writers that died before rename or link; returns how many were removed.
export function sweepTemps(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    const m = TEMP.exec(name);
    if (!m) continue;
    const pid = Number(m[2]);
    if (pid === process.pid || isAlive(pid)) continue;
    rmSync(join(dir, name), { force: true });
    removed++;
  }
  return removed;
}

// ---- locks ----

const pause = new Int32Array(new SharedArrayBuffer(4));
const backoff = (pollMs) => Atomics.wait(pause, 0, 0, pollMs + Math.floor(Math.random() * pollMs));
const TOKEN = /^[0-9]+\.[0-9a-f]{16}$/;
const held = new Set(); // tokens of the locks this process holds

// The owner of the lock: null when there is no lock, {} when it cannot be read.
// A lock as unlockStale sees it: null when there is none, else { owner ({} when unreadable), id } where id
// changes whenever the lock is replaced or its owner record rewritten (directory inode, record bytes).
function observe(lock) {
  const st = lstatSync(lock, { throwIfNoEntry: false });
  if (!st) return null;
  const owner = readOwner(lock);
  if (owner === null) return null;
  let bytes = '';
  try { bytes = readFileSync(join(lock, 'owner.json'), 'utf8'); } catch { /* unreadable: no owner */ }
  return { owner, id: `${st.ino}:${bytes}` };
}

function readOwner(lock) {
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    return owner && typeof owner === 'object' ? owner : {};
  } catch (err) {
    if ((err.code === 'ENOENT' || err.code === 'ENOTDIR') && !lstatSync(lock, { throwIfNoEntry: false })) return null;
    return {};
  }
}

// The state of a process as the system reports it: { running, startMs }. running is false for a missing process
// and for a zombie (exited, not yet reaped: kill(pid, 0) still succeeds for it). startMs is its start time from
// ps etime (elapsed whole seconds, so no time zone is involved), measured from before ps ran: never more than a
// second later than the real start; null when it cannot be read. Without ps, /proc gives the state only.
function processInfo(pid) {
  if (!isAlive(pid)) return { running: false, startMs: null };
  const before = Date.now();
  const r = run('ps', ['-o', 'stat=,etime=', '-p', String(pid)], { unit: 'fsx', env: { PATH: process.env.PATH, LC_ALL: 'C' }, timeoutMs: 5000 });
  if (r.error === null) {
    const line = r.stdout.trim();
    if (r.status !== 0 || line === '') return { running: false, startMs: null }; // exited meanwhile
    const [stat, etime = ''] = line.split(/\s+/);
    if (/^[ZX]/.test(stat)) return { running: false, startMs: null };
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime); // [[dd-]hh:]mm:ss
    const elapsed = m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
    return { running: true, startMs: elapsed === null ? null : before - elapsed * 1000 };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))) return { running: false, startMs: null };
  } catch { /* no /proc either: kill(0) is all there is */ }
  return { running: true, startMs: null };
}

// Whether the owner of a lock on this host still runs. Not the owner: a missing or zombie process, and a process
// with the owner's pid that started after the lock was taken (the pid was reused). Cached briefly per owner for
// waiters polling every few milliseconds (a death is seen up to 200 ms late); `fresh` (unlockStale) skips it.
const runningCache = new Map();
function ownerRunning(owner, fresh) {
  const hit = runningCache.get(owner.token);
  if (!fresh && hit && Date.now() - hit.at < 200) return hit.running;
  const info = processInfo(owner.pid);
  // The owner started at procStart (older records: no later than startedAt). startMs is at most a second late, and
  // procStart is rounded down to the millisecond: a start more than 2 s after it is another process.
  const began = Date.parse(owner.procStart ?? owner.startedAt);
  const reused = info.running && info.startMs !== null && !Number.isNaN(began) && info.startMs > began + 2000;
  const running = info.running && !reused;
  if (runningCache.size > 64) runningCache.clear();
  runningCache.set(owner.token, { at: Date.now(), running });
  return running;
}

function isStale(owner, ttlMs, fresh = false) {
  if (!Number.isInteger(owner.pid) || typeof owner.token !== 'string' || !TOKEN.test(owner.token)) return false;
  if (owner.host !== hostname()) return Date.now() - Date.parse(owner.startedAt) > ttlMs;
  return owner.pid === process.pid ? !held.has(owner.token) : !ownerRunning(owner, fresh);
}

// True when this process now holds the lock.
function tryCreate(lock, token) {
  const prepared = `${lock}.new-${process.pid}-${token}`;
  mkdirSync(prepared);
  try {
    writeNew(join(prepared, 'owner.json'), JSON.stringify({ pid: process.pid, token, host: hostname(), startedAt: new Date().toISOString(), procStart: new Date(Math.floor(performance.timeOrigin)).toISOString() }), 0o644);
    renameSync(prepared, lock);
    return true;
  } catch (err) {
    rmSync(prepared, { recursive: true, force: true });
    if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) return false;
    throw err;
  }
}

function release(lock, token) {
  held.delete(token);
  if (readOwner(lock)?.token !== token) return; // taken over (this process looked dead): not ours to remove
  const gone = `${lock}.released-${token}`;
  try {
    renameSync(lock, gone);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  rmSync(gone, { recursive: true, force: true });
}

const lockError = (lock, owner, why, code = 'ELOCKED') => Object.assign(new Error(`lock ${lock} ${why}${owner?.pid ? ` (pid ${owner.pid}${owner.host && owner.host !== hostname() ? ` on ${owner.host}` : ''})` : ''}`), { code, lock, owner });

// Runs fn() while holding the lock; waits up to timeoutMs for a live holder (then ELOCKED); a lock of a gone
// owner fails at once (ESTALE). The lock's parent directory is created when missing and removed again afterwards
// when it is left empty.
export function withLock(lock, fn, { timeoutMs = 10000, pollMs = 5, ttlMs = LOCK_TTL_MS } = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs >= 0)) throw new TypeError(`withLock: timeoutMs must be a finite number of ms, got ${timeoutMs}`);
  const deadline = Date.now() + timeoutMs;
  const parent = dirname(lock);
  const made = makeDirs(parent);
  const token = `${process.pid}.${hex(8)}`;
  try {
    for (;;) {
      const owner = readOwner(lock);
      // Free but lost to other processes (or its parent kept vanishing) until the deadline: give up as well.
      if (owner === null && Date.now() >= deadline) throw lockError(lock, owner, `could not be taken within ${timeoutMs} ms`);
      if (owner === null) {
        try {
          if (tryCreate(lock, token)) break;
        } catch (err) {
          // The parent was removed by another process tidying up (macOS may report EINVAL while it goes).
          if (err.code !== 'ENOENT' && err.code !== 'EINVAL') throw err;
          makeDirs(parent);
        }
        continue;
      }
      if (owner.pid === process.pid && held.has(owner.token)) throw lockError(lock, owner, 'is already held by this process: a nested acquisition is a programming error', 'EREENTRANT');
      // Stale only if the lock is still the one judged: a holder may have released it (and exited) meanwhile.
      if (isStale(owner, ttlMs) && readOwner(lock)?.token === owner.token) throw lockError(lock, owner, 'was left by a process that is no longer running', 'ESTALE');
      if (Date.now() >= deadline) throw lockError(lock, owner, owner.pid ? `is held by another process; waited ${timeoutMs} ms` : 'has no readable owner; remove it if no process holds it');
      backoff(pollMs);
    }
  } catch (err) {
    removeEmptyDirs(parent, made);
    throw err;
  }
  held.add(token);
  try {
    return fn();
  } finally {
    release(lock, token);
    removeEmptyDirs(parent, made);
  }
}

// Removes a lock whose owner is gone: the explicit `state unlock --stale` after a crash, for a store nobody is
// using (findings S3). The lock is removed only when its owner is gone at two reads quietMs apart and nothing
// about it changed in between (same directory, same owner record): a dead owner's lock is never replaced by a
// writer (no takeover), so it is the one moved aside. Anything else refuses with EBUSY and touches nothing; there
// is no put-back. Leftovers of dead processes next to the lock (prepared, released, set-aside directories) are
// removed too. Returns { removed, owner } (owner: the removed lock's owner, null when there was none).
export function unlockStale(lock, { ttlMs = LOCK_TTL_MS, quietMs = 2000 } = {}) {
  const first = observe(lock);
  let removed = false;
  if (first !== null) {
    const busy = (why) => lockError(lock, first.owner, why, 'EBUSY');
    if (!first.owner.pid) throw busy('has no readable owner; remove it by hand if no process holds it');
    if (!isStale(first.owner, ttlMs, true)) throw busy('is held by a running process');
    Atomics.wait(pause, 0, 0, quietMs);
    const second = observe(lock);
    if (second?.id !== first.id || !isStale(second.owner, ttlMs, true)) throw busy(`changed within ${quietMs} ms: the store is in use`);
    const aside = `${lock}.unlock-${process.pid}-${hex(8)}`;
    try {
      renameSync(lock, aside);
    } catch (err) {
      if (err.code === 'ENOENT') throw busy('was removed meanwhile');
      throw err;
    }
    rmSync(aside, { recursive: true, force: true });
    removed = true;
  }
  const dir = dirname(lock);
  const name = basename(lock);
  let entries = [];
  try { entries = readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const entry of entries) {
    const m = /^\.(?:new|unlock|released)-(\d+)[-.]/.exec(entry.slice(name.length));
    if (entry.startsWith(name) && m && !isAlive(Number(m[1]))) rmSync(join(dir, entry), { recursive: true, force: true });
  }
  return { removed, owner: removed ? first.owner : null };
}
