// Config unit (spec §5.1 config.json, §5.3, §14, SD-38): the capability flags with their defaults and machine overrides,
// the threshold overrides of a repository and the executor role preferences. Other units import only this file; it is
// read-only and safe for hooks (it imports lib/state alone). The commands that write the config live in commands.mjs,
// loaded by their command table rows only. Sources, highest first:
//   machine   ${CLAUDE_PLUGIN_DATA}/config.json (lib/state readMachineConfig): flags of rollout capabilities, executors
//   repo      <state>/config.json (lib/state, with the flags an old state.json still carries): flags, thresholds, executors
//   default   spec §14 for the rollout capabilities (capabilities.mjs); the unit's own data for thresholds
import { machineDataDir, open, readMachineConfig, resolve } from '../state/index.mjs';
import { ROLLOUT, repoMaySet, rollout } from './capabilities.mjs';

export { MODES, ROLLOUT, repoMaySet, rollout } from './capabilities.mjs';
export const ROLES = Object.freeze(['reviewer', 'implementer']);

// The repository's and the machine's config documents (null when absent). where: a lib/state resolve() result, or
// null outside a repository (machine data only).
export function readConfig(where, { names, env }) {
  const repo = where?.active ? open(where.dir, { names }).read('config', null) : null;
  const machine = readMachineConfig(where?.dataDir ?? machineDataDir(names, env), names);
  return { repo, machine };
}

// { flags: { name: { mode, source, repo?, machine? } }, ignored: [names], lowered: [{ name, mode }] }: every rollout
// capability (machine, then repo, then its default), then each other flag the repository sets; `repo` and `machine` are
// the values each source holds. A machine entry for a flag that is no rollout capability is ignored (team flags are the
// repository's) and listed in `ignored`; a repository value that would lower a protective capability is not applied
// (the default holds) and listed in `lowered` (capabilities.mjs repoMaySet).
export function flagsOf({ repo = null, machine = null } = {}) {
  const r = repo?.flags ?? {};
  const m = machine?.flags ?? {};
  const flags = {};
  const lowered = [];
  for (const c of ROLLOUT) {
    const held = { ...(Object.hasOwn(r, c.name) ? { repo: r[c.name] } : {}), ...(Object.hasOwn(m, c.name) ? { machine: m[c.name] } : {}) };
    if (Object.hasOwn(m, c.name)) flags[c.name] = { mode: m[c.name], source: 'machine', ...held };
    else if (Object.hasOwn(r, c.name) && repoMaySet(c, r[c.name])) flags[c.name] = { mode: r[c.name], source: 'repo', ...held };
    else flags[c.name] = { mode: c.default, source: 'default', ...held };
    if (Object.hasOwn(r, c.name) && !repoMaySet(c, r[c.name])) lowered.push({ name: c.name, mode: r[c.name] });
  }
  for (const name of Object.keys(r).sort()) if (!flags[name]) flags[name] = { mode: r[name], source: 'repo', repo: r[name] };
  return { flags, ignored: Object.keys(m).filter((name) => !rollout(name)).sort(), lowered };
}

// The mode of one flag (off | shadow | on), or null for a team flag nobody set.
export const modeOf = (name, configs) => flagsOf(configs).flags[name]?.mode ?? null;

// The mode of a capability for a command run at cwd (the CLI dispatcher): state errors propagate as typed errors.
export function capabilityMode(name, { cwd, env, names }) {
  const where = resolve({ cwd, env, names });
  return modeOf(name, readConfig(where, { names, env }));
}

// The executor preferences per role: { role: { providers, source } } (machine, then repo; none: [] from default).
export function executorsOf({ repo = null, machine = null } = {}) {
  const out = {};
  for (const role of ROLES) {
    if (machine?.executors?.[role]) out[role] = { providers: [...machine.executors[role]], source: 'machine' };
    else if (repo?.executors?.[role]) out[role] = { providers: [...repo.executors[role]], source: 'repo' };
    else out[role] = { providers: [], source: 'default' };
  }
  return out;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every '<unit>.<path>' whose value in the unit's threshold data is an integer (the schema field excluded), in order.
export function thresholdKeys(unit, defaults) {
  const out = [];
  const walk = (v, path) => {
    if (Number.isInteger(v)) { if (path !== 'schema') out.push(`${unit}.${path}`); return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(defaults, '');
  return out;
}

// The unit's threshold data with the repository's overrides applied (a copy; defaults unchanged). An override whose key
// names no integer of the data (a hand edit) is skipped and listed in `unknown`.
export function thresholdsOf(unit, defaults, repo) {
  const data = structuredClone(defaults);
  const keys = new Set(thresholdKeys(unit, defaults));
  const applied = {};
  const unknown = [];
  for (const [key, o] of Object.entries(repo?.thresholds ?? {})) {
    if (!key.startsWith(`${unit}.`)) continue;
    if (!keys.has(key)) { unknown.push(key); continue; }
    const parts = key.split('.').slice(1);
    let at = data;
    for (const p of parts.slice(0, -1)) at = at[p];
    at[parts[parts.length - 1]] = o.value;
    applied[key] = o;
  }
  return { data, applied, unknown };
}

