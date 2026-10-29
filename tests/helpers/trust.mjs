// Test helper (T-MG-77 slice B): a fixture that writes profile.json or config.json by hand records trust for them, as
// `landfall trust` would after a y at a terminal. A machine-data write of the test process (its isolated env); never
// used by production code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function trustHere(lib, stateDir, names, env = process.env) {
  const state = await lib('state/index.mjs');
  const read = (rel) => { try { return JSON.parse(readFileSync(join(stateDir, rel), 'utf8')); } catch { return null; } };
  const gates = read('profile.json')?.gates ?? [];
  const thresholds = read('config.json')?.thresholds ?? {};
  state.recordTrust({
    dataDir: state.machineDataDir(names, env), names, key: state.repoKey(stateDir, { env }),
    gates: gates.length ? state.gatesShaOf(gates) : null,
    overrides: Object.keys(thresholds).length ? state.overridesShaOf(thresholds) : null,
  });
}
