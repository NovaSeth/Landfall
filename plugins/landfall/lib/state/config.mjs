// Machine config (spec §5.3, SD-38): `${CLAUDE_PLUGIN_DATA}/config.json`, this user's overrides of capability flags and
// executor preferences for every repository (lib/config merges it; `flags set --local` writes a flag, the rest is edited
// by hand). Read like every state file: a newer schema refuses (exit 7), an invalid one is state-invalid (exit 1), an
// older one is upgraded in memory. null when the machine data directory is unknown or holds no config.json.
// updateMachineConfig: read-modify-write under the machine data lock (the one of projects.json, so `state unlock
// --stale` covers it), every check inside, atomic replace.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from '../fsx/index.mjs';
import { checkWrite, parseDoc } from './document.mjs';
import { StateError, guarded } from './errors.mjs';
import { MACHINE_KINDS } from './kinds.mjs';
import { MIGRATIONS } from './migrations/index.mjs';
import { format } from './schema.mjs';
import { lockFailure } from './store.mjs';
import { upgradeDoc } from './upgrade.mjs';

const CONFIG = MACHINE_KINDS.machineConfig;

export function readMachineConfig(dataDir, names, { write = false } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') return null;
  const file = join(dataDir, CONFIG.path());
  let text;
  try {
    text = guarded(() => readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  return parseDoc(CONFIG, text, { where: file, names, write, upgrade: (k, d, w) => upgradeDoc(k, d, MIGRATIONS, w) });
}

// fn(copy of the current document or null) → the new document (schema stamped); returns what was written.
export function updateMachineConfig(dataDir, names, fn) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new StateError('no-machine-data', 'ENV', 'the machine data directory is unknown', { hint: 'set CLAUDE_PLUGIN_DATA or HOME' });
  const file = join(dataDir, CONFIG.path());
  try {
    return guarded(() => withLock(join(dataDir, 'projects.lock'), () => {
      const cur = readMachineConfig(dataDir, names, { write: true });
      const next = { ...fn(cur === null ? null : structuredClone(cur)), schema: CONFIG.version };
      checkWrite(CONFIG, next, { where: file });
      writeAtomic(file, format(CONFIG.spec, next));
      return next;
    }));
  } catch (err) {
    throw lockFailure(err, names);
  }
}
