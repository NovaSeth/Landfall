// State locks (spec §5.4): the store lock and the move-aside lock are lib/fsx locks; these are their state errors and
// the explicit removal of a lock whose owner is gone.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { unlockStale as fsxUnlockStale, writeAtomic } from '../fsx/index.mjs';
import { StateError } from './errors.mjs';

// The lock that serializes moving a foreign local/ aside (fix round 1, F4): outside the directory it moves, so a
// writer that checked local/ before another one moved it aside and took a fresh store lock cannot move that one too.
export const MOVE_LOCK = '.local-move.lock';

// The lib/fsx lock errors as state errors (other errors unchanged).
export function lockFailure(err, names) {
  if (err?.code === 'ELOCKED') return new StateError('locked', 'ENV', err.message, { hint: `wait for the other ${names.bin} command to finish` });
  if (err?.code === 'ESTALE') return new StateError('stale-lock', 'REFUSED', err.message, { hint: `if no ${names.bin} command is running, run '${names.bin} state unlock --stale'` });
  if (err?.code === 'EREENTRANT') return new StateError('lock-reentry', 'INTERNAL', err.message, { hint: 'a state write was started inside another one; report this' });
  return err;
}

// lib/fsx unlockStale refusals (EBUSY) as state errors (other errors unchanged).
export function busyFailure(err, names) {
  if (err?.code !== 'EBUSY') return err;
  return new StateError('store-busy', 'REFUSED', err.message, { hint: `run it when no ${names.bin} command is running: it removes only a lock whose owner is gone and that stayed unchanged for 2 seconds` });
}

// Removes the store lock of a process that is gone (an explicit command, for a store nobody is using; lib/fsx
// unlockStale); { removed, owner }. quietMs: how long the lock must stay unchanged (default 2 s).
export function unlockStale(store, { quietMs } = {}) {
  try {
    const move = fsxUnlockStale(store.abs(MOVE_LOCK), { quietMs });
    const out = fsxUnlockStale(store.abs('local/lock'), { quietMs });
    return out.removed || !move.removed ? out : move;
  } catch (err) {
    throw busyFailure(err, store.names);
  }
}

// Test hook: creates <dir>/paused, then waits (at most 10 s) until <dir>/go exists.
export function pauseUntilSignalled(dir) {
  writeAtomic(join(dir, 'paused'), '');
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 2000 && !existsSync(join(dir, 'go')); i++) Atomics.wait(nap, 0, 0, 5);
}
