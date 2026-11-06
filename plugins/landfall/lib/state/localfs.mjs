// Files and directories under <state>/local/ that other units need (T-MG-143, GC-M6: the state unit is the only writer
// under the state directory). Both go through the same local/ ownership as the store's writes (local.mjs): a foreign
// local/ is moved aside before a write (a hook's store skips instead), an unknown owner refuses.
import { join } from 'node:path';
import { makeDirs, makeTempDir, removeFile, removeTree } from '../fsx/index.mjs';
import { StateError } from './errors.mjs';
import { claimLocal, hidden } from './local.mjs';
import { missing } from './paths.mjs';
import { open } from './store.mjs';

// A new directory <dir>/local/<prefix>XXXXXX (local/ made when absent); its absolute path.
export function localTempDir(dir, names, prefix) {
  const store = open(dir, { names });
  if (store.foreignLocal === 'skip' && hidden(store.localStatus())) throw new StateError('local-foreign', 'ENV', `${join(dir, 'local')} belongs to another machine; nothing was written`, { hint: 'run the command instead of the hook' });
  claimLocal(store);
  const local = store.abs('local');
  makeDirs(local);
  return makeTempDir(join(local, prefix));
}

// Removes <dir>/<rel> (rel is local/… with no '..'; a directory tree only with { tree: true }). True when something was
// removed; false when it was absent or local/ is not this machine's (a hidden local/ is not touched).
export function removeLocalFile(dir, names, rel, { tree = false } = {}) {
  if (typeof rel !== 'string' || !/^local\/[^\0]+$/.test(rel) || rel.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new TypeError(`state.removeLocalFile: ${rel} is not a path under local/`);
  const store = open(dir, { names });
  if (hidden(store.localStatus())) return false;
  const file = store.abs(rel);
  try {
    if (tree) removeTree(file);
    else removeFile(file);
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
}
