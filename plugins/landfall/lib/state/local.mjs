// State local/ (T-MG-77): the machine-local part of a state directory. local/.machine names the machine that owns it
// (lib/state/machine.mjs localForeign); a foreign local/ is moved aside before a write. Every function takes the Store.
import { lstatSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isAlive, moveTree, withLock, writeAtomic } from '../fsx/index.mjs';
import { StateError } from './errors.mjs';
import { MARKER, forgetShipped, localForeign, machineId } from './machine.mjs';
import { MOVE_LOCK, pauseUntilSignalled } from './locks.mjs';
import { missing } from './paths.mjs';
import { machineDataDir, resolvedDataDir } from './resolve.mjs';
import { repoKey, recordTrust } from './trust.mjs';

// What a write does with a foreign local/ (T-MG-77): 'move' (a command: move it aside, then write) or 'skip' (a hook:
// write nothing, the lock section does not run). The hook entry (lib/cli/hook.mjs) sets 'skip' for its process.
export const FOREIGN = ['move', 'skip'];
let foreignDefault = 'move';
export function setForeignLocal(mode) {
  if (!FOREIGN.includes(mode)) throw new TypeError(`state.setForeignLocal: ${mode} is not one of ${FOREIGN.join('|')}`);
  foreignDefault = mode;
}
export const foreignLocalOf = (mode) => mode ?? foreignDefault;

export const isLocal = (rel) => rel === 'local' || rel.startsWith('local/');
// Hidden local/ states: what readers see as empty.
export const hidden = (status) => status === 'foreign' || status === 'unknown';
// <UTC yyyymmddThhmmss>
const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

// The state directory's .gitignore: machine-local state, the moved-aside copies of a foreign local/ and temporary files
// of interrupted atomic writes, the move-aside lock. ensureIgnored adds the missing lines (init, and every move-aside
// before the rename).
const IGNORED = ['local/', 'local.foreign-*/', '.*.tmp', '.local-move.lock'];
export function ensureIgnored(store) {
  const text = store.readText('.gitignore');
  if (text === null) return store.createText('.gitignore', `${IGNORED.join('\n')}\n`);
  const lines = text.split(/\r?\n/);
  const missingLines = IGNORED.filter((line) => !lines.includes(line));
  if (missingLines.length) store.writeText('.gitignore', `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missingLines.join('\n')}\n`);
  return missingLines.length > 0;
}

// 'absent' (no local/) · 'mine' (this machine's marker; also when the path check of local/ fails: the reader's own
// check reports it) · 'unmarked' (no marker and nothing shipped: marked at the next write; adoption of its gates is
// trust.mjs's, on machine-side evidence only) · 'foreign' (shipped: tracked by git, another machine's marker, a
// marker that is not a file) · 'unknown' (git gave no answer: hidden like foreign, never moved, writes refused).
export function localStatus(store) {
  if (store.localState === undefined) store.localState = ownerOfLocal(store);
  return store.localState;
}

function ownerOfLocal(store, fresh = false) {
  try { store.abs('local'); } catch { return 'mine'; }
  const { foreign, unknown, why } = localForeign(store.dir, { fresh });
  store.localWhy = why;
  if (unknown) return 'unknown';
  if (foreign) return 'foreign';
  return { absent: 'absent', ours: 'mine' }[why] ?? 'unmarked';
}

const unknownOwner = (store) => new StateError('git-failed', 'ENV', `the owner of ${join(store.dir, 'local')} is unknown: ${store.localWhy}; nothing was written`, { hint: 'check that git runs in this directory, then run the command again' });

// Before a write: a foreign local/ is moved aside to local.foreign-<stamp>/ (one rename; the store lock lives inside
// local/, so the rename comes first). Moves are serialized by MOVE_LOCK (outside local/); under it git is asked
// again (another process may have moved it aside and started a fresh local/ meanwhile), the repository gets its trust
// entry without adoption, .gitignore its missing lines, then the rename: the fresh local/ that replaces a shipped
// one is never adopted, not even by a reader between the rename and the end of the write (fix round 2, F1). A trust
// entry that cannot be written aborts the move and the write (trust-write-failed, naming trust.json). Without a
// machine data directory there is no projects.json, so nothing can adopt. An unknown owner refuses the write:
// nothing moves on a guess.
export function claimLocal(store) {
  store.localState = undefined;
  if (localStatus(store) === 'unknown') throw unknownOwner(store);
  if (localStatus(store) !== 'foreign') return;
  withLock(store.abs(MOVE_LOCK), () => moveAside(store), { timeoutMs: store.lockTimeoutMs });
  store.localState = undefined;
}

function moveAside(store) {
  store.localState = ownerOfLocal(store, true);
  if (store.localState === 'unknown') throw unknownOwner(store);
  if (store.localState !== 'foreign') return;
  const from = store.abs('local');
  const dataDir = dataDirOf(store);
  if (dataDir) {
    try {
      recordTrust({ dataDir, names: store.names, key: repoKey(store.dir) });
    } catch (err) {
      throw new StateError('trust-write-failed', 'ENV', `${join(dataDir, 'trust.json')} could not be written (${err.message}); ${from} was not moved aside and nothing was written`, { hint: 'check that file and its directory, then run the command again' });
    }
  }
  ensureIgnored(store);
  // A lock inside it whose owner runs on this host: a live writer (another machine data directory), never moved.
  let owner = null;
  try { owner = JSON.parse(readFileSync(join(from, 'lock', 'owner.json'), 'utf8')); } catch { /* none or unreadable */ }
  if (owner && owner.host === hostname() && Number.isInteger(owner.pid) && isAlive(owner.pid)) {
    throw new StateError('locked', 'ENV', `${from} is foreign but its lock is held by the running process ${owner.pid}`, { hint: `wait for the other ${store.names.bin} command to finish` });
  }
  const stamp = stampOf(new Date());
  let to = join(store.dir, `local.foreign-${stamp}`);
  for (let n = 2; lstatSync(to, { throwIfNoEntry: false }); n++) to = join(store.dir, `local.foreign-${stamp}-${n}`);
  const pause = process.env[`${store.names.envPrefix}TEST_MOVE_PAUSE`];
  if (pause) pauseUntilSignalled(pause);
  try {
    moveTree(from, to);
    store.movedAside = to;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  forgetShipped(store.dir); // what git tracks under local/ was moved aside with it
}

// After a write succeeded (under the lock; a section that wrote nothing marks nothing): local/ carries this machine's
// marker. Marking trusts nothing (fix round 1, F1). Best effort: a marker that cannot be written leaves local/ unmarked.
export function markLocal(store) {
  if (!store.active) return; // deactivate removed the state: nothing to mark
  try {
    if (store.readText(MARKER) !== null && localStatus(store) === 'mine') return;
    writeAtomic(store.abs(MARKER), `${machineId()}\n`);
    store.localState = 'mine';
  } catch { /* best effort */ }
}

// The machine data directory of this store's commands (resolve's, else the process environment's), or null.
export function dataDirOf(store) {
  const known = resolvedDataDir(store.dir);
  if (known) return known;
  try { return store.names?.plugin ? machineDataDir(store.names, process.env) : null; } catch { return null; }
}
