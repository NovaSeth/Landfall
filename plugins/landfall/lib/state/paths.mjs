// State paths (spec §4.3, SC10): the checked absolute path of a file in a state directory. Every path is checked
// component by component from the store root (inclusive): a symbolic link, or a name that differs in case from the
// entry on disk, is refused (state-invalid), never followed — the lock directory and backups included.
// Accepted residual (findings-r3): path checks and the file operation that follows are separate system calls
// (Node has no openat or O_NOFOLLOW for directories), so a process that can already write the store could swap
// a checked directory for a link in between. Locks never write through links, and that process could write the
// store directly anyway; this window is not closed.
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StateError } from './errors.mjs';

export const missing = (err) => err.code === 'ENOENT' || err.code === 'ENOTDIR';

export const unsafe = (path, why) => new StateError('state-invalid', 'FAIL', `${path} ${why}; the state never follows links or case aliases`, { hint: 'replace it with a plain directory or file of exactly that name' });

// realpath names where an entry is now: on macOS it asks the system for the path of the opened entry, so an
// entry renamed meanwhile (a lock released to lock.released-<token>) comes back under its new name. A case alias
// is the same entry (same inode) under a path that differs from ours only in case; anything else moved
// meanwhile and is treated as if lstat had missed it (findings S3).
function caseAlias(cur, onDisk, st) {
  const fold = (p) => p.normalize('NFC').toLowerCase();
  if (fold(onDisk) !== fold(cur)) return false;
  const now = lstatSync(onDisk, { throwIfNoEntry: false });
  return now !== undefined && now.ino === st.ino && now.dev === st.dev;
}

function checkPath(dir, parts) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  if (st.isSymbolicLink()) throw unsafe(dir, 'is a symbolic link');
  const root = realpathSync.native(dir);
  let cur = root;
  let curSt = st;
  const done = [];
  for (const part of parts) {
    st = lstatSync(join(cur, part), { throwIfNoEntry: false });
    if (!st) break;
    done.push(part);
    if (st.isSymbolicLink()) throw unsafe(join(dir, ...done), 'is a symbolic link');
    if (!st.isDirectory() && done.length < parts.length) break;
    cur = join(cur, part);
    curSt = st;
  }
  if (cur !== root) {
    const onDisk = realpathSync.native(cur);
    if (onDisk !== cur && caseAlias(cur, onDisk, curSt)) throw unsafe(join(dir, ...done), `differs in case from its name on disk (${onDisk.slice(root.length + 1)})`);
  }
}

// The absolute path of `rel` in `dir` after the checks.
export function checkedAbs(dir, rel) {
  const parts = rel === '' ? [] : rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new TypeError(`state: bad store path ${rel}`);
  // Entries can vanish while they are checked (another process removing its lock): check again.
  for (let attempt = 0; ; attempt++) {
    try {
      checkPath(dir, parts);
      return join(dir, rel);
    } catch (err) {
      if (!missing(err) || attempt >= 5) throw err;
    }
  }
}

// The absolute path of `rel` in the state directory `dir` after the store's checks, for the units that read the state
// directory's files themselves (lib/decisions).
export function checkedPath(dir, rel) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new TypeError(`state.checkedPath: the state directory must be an absolute path, got ${dir}`);
  return checkedAbs(dir, rel);
}
