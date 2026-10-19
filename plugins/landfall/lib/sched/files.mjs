// Scheduler files in machine data (spec §4.2: sched owns leases/**, the queues and calibration.json): typed reads,
// writes through lib/fsx (exclusive create, atomic replace) and the one scheduler lock.
// Every check and the write it decides run in one section of the lock (never split across two). A lock whose owner
// is gone is never removed by a scheduler call (findings r1 1): the call refuses with scheduler-busy (exit 7) and only
// the explicit `slots --unlock-stale` removes it, by the quiescent rule of lib/fsx unlockStale (the owner gone at two
// reads 2 s apart and the lock unchanged in between; no put-back).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { unlockStale as fsxUnlockStale, withLock } from '../fsx/index.mjs';
import { StateError, check, machineDataDir, serialize } from '../state/index.mjs';

export function dataDirOf({ names, env } = {}) {
  if (!names || !env) throw new TypeError('sched: pass names and env explicitly (context comes from the caller)');
  const dir = machineDataDir(names, env);
  if (!dir) throw new StateError('no-machine-data', 'ENV', 'the machine data directory is unknown', { hint: 'set CLAUDE_PLUGIN_DATA or HOME' });
  return dir;
}

// Names in a directory ([] when it is missing).
export function entries(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

// { doc } · { missing } · { newer, doc } (a schema this plugin does not know: never interpreted or removed) ·
// { invalid: why } (not JSON or failed field checks).
export function readDoc(kind, file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { missing: true };
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { invalid: 'not valid JSON' };
  }
  if (doc && typeof doc === 'object' && Number.isInteger(doc.schema) && doc.schema > kind.version) return { newer: true, doc };
  const errors = check(kind, doc);
  return errors.length ? { invalid: errors[0].message } : { doc };
}

// File text of a document; a failed field check is a usage error naming the field (nothing is written).
export function toText(kind, doc) {
  const errors = check(kind, doc);
  if (errors.length) throw new StateError(errors[0].code, 'USAGE', `${kind.name}: ${errors[0].message}`, { hint: 'correct the value; nothing was written' });
  return serialize(kind, doc);
}

const lockOf = (dataDir) => join(dataDir, 'leases', 'lock');

// Runs fn() in the scheduler lock. A live holder past timeoutMs: scheduler-busy (ENV, retry). A holder that is gone:
// scheduler-busy (REFUSED) naming the explicit unlock; the lock is left as it is.
export function locked(dataDir, fn, { timeoutMs = 5000, names } = {}) {
  try {
    return withLock(lockOf(dataDir), fn, { timeoutMs });
  } catch (err) {
    if (err?.code === 'ELOCKED') throw new StateError('scheduler-busy', 'ENV', err.message, { hint: 'another scheduler call holds its lock; retry in a moment' });
    if (err?.code === 'ESTALE') throw new StateError('scheduler-busy', 'REFUSED', err.message, { hint: `if no ${names.bin} command is running, run '${names.bin} slots --unlock-stale'` });
    throw err;
  }
}

// `slots --unlock-stale`: removes the scheduler lock of an owner that is gone (lib/fsx unlockStale); { removed, owner }.
export function unlockStale(opts = {}) {
  try {
    return fsxUnlockStale(lockOf(dataDirOf(opts)), { quietMs: opts.quietMs });
  } catch (err) {
    if (err?.code !== 'EBUSY') throw err;
    throw new StateError('scheduler-busy', 'REFUSED', err.message, { hint: `run it when no ${opts.names.bin} command is running: it removes only a lock whose owner is gone and that stayed unchanged for 2 seconds` });
  }
}
