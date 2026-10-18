// Machine config (spec §5.3, SD-38): `${CLAUDE_PLUGIN_DATA}/config.json`, this user's overrides of capability flags and
// executor preferences for every repository, written by hand (the plugin only reads it; lib/config merges it). Read like
// every state file: a newer schema refuses (exit 7), an invalid one is state-invalid (exit 1), an older one is upgraded in
// memory. null when the machine data directory is unknown or holds no config.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDoc } from './document.mjs';
import { guarded } from './errors.mjs';
import { MACHINE_KINDS } from './kinds.mjs';
import { MIGRATIONS } from './migrations/index.mjs';
import { upgradeDoc } from './upgrade.mjs';

const CONFIG = MACHINE_KINDS.machineConfig;

export function readMachineConfig(dataDir, names) {
  if (typeof dataDir !== 'string' || dataDir === '') return null;
  const file = join(dataDir, CONFIG.path());
  let text;
  try {
    text = guarded(() => readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  return parseDoc(CONFIG, text, { where: file, names, upgrade: (k, d, w) => upgradeDoc(k, d, MIGRATIONS, w) });
}
