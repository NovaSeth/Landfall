// This machine's id (T-MG-77): machine data `machine.json` { schema, id }, a random 128-bit hex value. It is written
// once, by the first state write that needs it, through the machine data writer path (the projects.json lock, every
// check inside, atomic replace, mode 0600), and re-read thereafter. Reads never create it: a machine without an id owns
// no local/ yet. Read like every state file: a newer schema refuses, an invalid one is state-invalid.
import { randomBytes } from 'node:crypto';
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

const MACHINE = MACHINE_KINDS.machine;

function readDoc(dataDir, names, write) {
  const file = join(dataDir, MACHINE.path());
  let text;
  try {
    text = guarded(() => readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  return parseDoc(MACHINE, text, { where: file, names, write, upgrade: (k, d, w) => upgradeDoc(k, d, MIGRATIONS, w) });
}

// The id, or null when the machine data directory is unknown or holds none.
export function readMachineId(dataDir, names) {
  if (typeof dataDir !== 'string' || dataDir === '') return null;
  return readDoc(dataDir, names, false)?.id ?? null;
}

// The id, created when missing.
export function ensureMachineId(dataDir, names) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new StateError('no-machine-data', 'ENV', 'the machine data directory is unknown', { hint: 'set CLAUDE_PLUGIN_DATA or HOME' });
  const known = readMachineId(dataDir, names);
  if (known) return known;
  const file = join(dataDir, MACHINE.path());
  try {
    return guarded(() => withLock(join(dataDir, 'projects.lock'), () => {
      const cur = readDoc(dataDir, names, true);
      if (cur?.id) return cur.id;
      const next = { schema: MACHINE.version, id: randomBytes(16).toString('hex') };
      checkWrite(MACHINE, next, { where: file });
      writeAtomic(file, format(MACHINE.spec, next), { mode: 0o600 });
      return next.id;
    }));
  } catch (err) {
    throw lockFailure(err, names);
  }
}
