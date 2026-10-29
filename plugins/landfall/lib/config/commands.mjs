// `<bin> flags show|set` and `<bin> config show|set` (spec §8.2, §14, SD-38, §5.1 config.json): the command
// implementations behind their command table rows (loaded by the CLI only, never by a hook).
//   flags show   every rollout capability (mode, source, what the mode does), then the team flags (lanes and the
//                generated files: set by the engine at a tier change or here; unset = what the tier offers).
//   flags set    one flag of an active repository, to a mode it has; a flip is recorded first as a decision (kind
//                general, the user's --reason as its Why), then written to config.json. The same value writes nothing.
//                The repository's config never lowers a protective capability (it arrives with a clone): that is
//                refused with the hint to use --local, which writes this user's machine override instead (plugin data
//                config.json; rollout capabilities only; no decision: it is no team record).
//   config show  the threshold overrides with their default and decision, the executor preferences with their source,
//                the flags that differ from their default.
//   config set   thresholds.<unit>.<path> <integer|default> --decision <D>: an override of a number of the unit's
//                threshold data (router, engine), only with an active decision (lib/decisions requireDecision; exit 1
//                otherwise, nothing written), which config.json keeps with it; `default` removes it.
//                executors.<role> <provider,…|default>: the role's providers in order of preference; no decision.
// Context comes from io (cwd, env), never from process state (COD-9). Exit 2 an unknown flag or mode · 7 an inactive
// repository, a newer schema, no consent · 8 not a git repository.
import { relative } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { authorHandle, createDecision, requireDecision } from '../decisions/index.mjs';
import { ENGINE_FLAGS, THRESHOLDS as ENGINE_THRESHOLDS } from '../engine/index.mjs';
import { TARGETS } from '../gen/index.mjs';
import { THRESHOLDS as ROUTER_THRESHOLDS } from '../router/index.mjs';
import { LIMITS, PATTERNS, StateError, machineDataDir, open, resolve, updateMachineConfig } from '../state/index.mjs';
import { ROLES, ROLLOUT, executorsOf, flagsOf, readConfig, repoMaySet, rollout, thresholdKeys, thresholdsOf } from './index.mjs';

const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const guarded = (fn) => (ctx) => {
  try {
    return fn(ctx);
  } catch (err) {
    if (err instanceof StateError) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
};
const here = ({ io, names }) => resolve({ cwd: io.cwd, env: io.env, names });

// Team flags: the ones the engine sets by tier and the ones that enable a generated file; on or off, no default.
export const TEAM_FLAGS = Object.freeze([...new Set([...ENGINE_FLAGS, ...TARGETS.map((t) => t.capability)])]);
const TEAM_MODES = Object.freeze(['off', 'on']);

// { kind: rollout | team, modes, default, describe(mode) } of a flag name, or null.
function flagSpec(name) {
  const r = rollout(name);
  if (r) return { kind: 'rollout', modes: r.modes, default: r.default, protective: Boolean(r.protection), repoMay: (mode) => repoMaySet(r, mode), describe: (mode) => r[mode] ?? '' };
  if (TEAM_FLAGS.includes(name)) return { kind: 'team', modes: TEAM_MODES, default: null, describe: (mode) => (mode === 'on' ? 'enabled for the team' : 'disabled for the team') };
  return null;
}

const machineFile = (where, names, env) => {
  const dir = where?.dataDir ?? machineDataDir(names, env);
  return dir ? `${dir}/config.json` : null;
};

export const flagsShow = guarded(({ io, names }) => {
  const where = here({ io, names });
  const configs = readConfig(where, { names, env: io.env });
  const { flags, ignored, lowered } = flagsOf(configs);
  const rows = {};
  for (const c of ROLLOUT) rows[c.name] = { ...flags[c.name], kind: 'rollout', default: c.default, modes: [...c.modes], effect: c[flags[c.name].mode] ?? '' };
  for (const name of TEAM_FLAGS) rows[name] = { mode: flags[name]?.mode ?? null, source: flags[name] ? 'repo' : null, kind: 'team', default: null, modes: [...TEAM_MODES], effect: '' };
  for (const [name, f] of Object.entries(flags)) if (!rows[name]) rows[name] = { ...f, kind: 'unknown', default: null, modes: [], effect: 'not a flag of this plugin version' };
  const width = Math.max(...Object.keys(rows).map((k) => k.length)) + 2;
  const held = (r) => [r.repo !== undefined && r.source !== 'repo' ? `repo ${r.repo}` : null, r.machine !== undefined && r.source !== 'machine' ? `machine ${r.machine}` : null].filter(Boolean);
  const line = (name, r) => `  ${name.padEnd(width)}${(r.mode ?? 'unset').padEnd(8)}${(r.source ?? '').padEnd(9)}${r.effect || (r.mode === null ? 'the tier offers it' : '')}${held(r).length ? ` (${held(r).join(', ')})` : ''}`.trimEnd();
  const file = machineFile(where, names, io.env);
  const lines = [
    `Capability flags of ${where.repo} (${where.active ? 'config.json' : 'not active: defaults'}; machine overrides: ${file ?? 'no plugin data directory'})`,
    ...Object.entries(rows).filter(([, r]) => r.kind === 'rollout').map(([n, r]) => line(n, r)),
    'Team flags (set by the engine at a tier change, or here):',
    ...Object.entries(rows).filter(([, r]) => r.kind !== 'rollout').map(([n, r]) => line(n, r)),
    ...ignored.map((n) => `  ${n}: ignored in the machine config (only rollout capabilities are overridden per machine)`),
    ...lowered.map((l) => `  ${l.name}: the repository's ${l.mode} is ignored: a committed file never lowers a protective capability; '${names.bin} flags set ${l.name} ${l.mode} --local' does it on this machine`),
  ];
  return { data: { repo: where.repo, active: where.active, flags: rows, ignored, lowered, machineConfig: file }, text: `${lines.join('\n')}\n` };
});

export const flagsSet = guarded(({ args, flags: opts, io, names }) => {
  const name = String(args.cap);
  const mode = String(args.mode);
  const spec = flagSpec(name);
  if (!spec) throw usage('unknown-capability', `unknown flag: ${name.slice(0, 40)}`, `flags: ${[...ROLLOUT.map((c) => c.name), ...TEAM_FLAGS].join(', ')}`);
  if (!spec.modes.includes(mode)) throw usage('invalid-mode', `${name} has no mode ${JSON.stringify(mode.slice(0, 20))}`, `${name} takes ${spec.modes.join(' or ')}`);
  const where = here({ io, names });
  if (opts.local) return setLocal({ name, mode, spec, where, io, names });
  if (spec.protective && !spec.repoMay(mode)) {
    throw usage('protective-flag', `${name} ${mode} lowers a protective capability; the repository's config.json (it arrives with a clone) never does that`, `set it for this machine only: '${names.bin} flags set ${name} ${mode} --local'`);
  }
  if (!where.active) throw new StateError('inactive', 'REFUSED', `${where.repo} is not active: flags are recorded only in an active repository`, { hint: `activate it first (${names.bin} init), or set this machine's override with --local` });
  const store = open(where.dir, { names });
  const cur = store.read('config', null)?.flags?.[name] ?? null;
  const machine = flagsOf(readConfig(where, { names, env: io.env })).flags[name];
  const warnings = machine?.source === 'machine' && machine.mode !== mode ? [`the machine config overrides ${name} on this machine (${machine.mode})`] : [];
  if (cur === mode) return { data: { flag: name, mode, previous: cur, decision: null }, text: `${name} is already ${mode}; nothing written\n`, warnings };
  const from = cur ?? (spec.default === null ? 'unset' : `${spec.default} (default)`);
  const handle = authorHandle({ store, where, names, env: io.env });
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : null;
  if (reason !== null && [...reason].length > LIMITS.reason) throw usage('limit-exceeded', `--reason has ${[...reason].length} characters; the limit is ${LIMITS.reason}`, 'shorten it; nothing was written');
  const effect = spec.describe(mode);
  const { id, file } = createDecision({
    store, where, names, env: io.env, handle,
    input: {
      title: `Capability ${name}: ${from} → ${mode}`,
      why: reason ?? `${handle} set it with ${names.bin} flags set; no reason was given.`,
      cost: `With ${name} ${mode}${effect ? `, ${effect}` : ''}; ${names.bin} flags set ${name} ${cur ?? spec.default ?? 'off'} reverts it.`,
      kind: 'general', scope: [], supersedes: [],
    },
  });
  store.update('config', null, (doc) => ({ ...(doc ?? {}), flags: { ...(doc?.flags ?? {}), [name]: mode } }));
  const rel = relative(where.repo, where.dir).split('\\').join('/');
  return {
    data: { flag: name, mode, previous: cur, decision: id, file },
    text: `${name}: ${from} → ${mode} (${id}, ${rel && !rel.startsWith('..') ? `${rel}/` : ''}config.json)\n`,
    warnings,
  };
});

// `flags set --local`: this user's machine override of a rollout capability (plugin data config.json), any of its modes.
function setLocal({ name, mode, spec, where, io, names }) {
  if (spec.kind !== 'rollout') throw usage('team-flag', `${name} is a team flag: the repository sets it, a machine override would be ignored`, `set it without --local: '${names.bin} flags set ${name} ${mode}'`);
  const dataDir = where?.dataDir ?? machineDataDir(names, io.env);
  const before = readConfig(where, { names, env: io.env }).machine?.flags?.[name] ?? null;
  if (before === mode) return { data: { flag: name, mode, previous: before, decision: null, local: true }, text: `${name} is already ${mode} on this machine; nothing written\n` };
  updateMachineConfig(dataDir, names, (cur) => ({ ...(cur ?? {}), flags: { ...(cur?.flags ?? {}), [name]: mode } }));
  return { data: { flag: name, mode, previous: before, decision: null, local: true, file: machineFile(where, names, io.env) }, text: `${name}: ${before ?? 'not overridden'} → ${mode} on this machine (${machineFile(where, names, io.env)})\n` };
}

// The threshold data a key may override, per unit (the data each unit ships).
const THRESHOLD_DATA = Object.freeze({ router: ROUTER_THRESHOLDS, engine: ENGINE_THRESHOLDS });
const DEFAULT = 'default';
const valueAt = (data, path) => path.split('.').reduce((v, k) => v?.[k], data);

function inactive(where, names) {
  return new StateError('inactive', 'REFUSED', `${where.repo} is not active: the config is written only in an active repository`, { hint: `activate it first (${names.bin} init)` });
}

export const configShow = guarded(({ io, names }) => {
  const where = here({ io, names });
  const configs = readConfig(where, { names, env: io.env });
  const thresholds = {};
  const unknown = [];
  for (const [unit, data] of Object.entries(THRESHOLD_DATA)) {
    const r = thresholdsOf(unit, data, configs.repo);
    unknown.push(...r.unknown);
    for (const [key, o] of Object.entries(r.applied)) thresholds[key] = { value: o.value, default: valueAt(data, key.slice(unit.length + 1)), decision: o.decision, at: o.at };
  }
  const executors = executorsOf(configs);
  const { flags } = flagsOf(configs);
  const changed = Object.entries(flags).filter(([, f]) => f.source !== 'default');
  const file = machineFile(where, names, io.env);
  const lines = [
    `Config of ${where.repo} (${where.active ? 'config.json' : 'not active: defaults'}; machine overrides: ${file ?? 'no plugin data directory'})`,
    'Thresholds (override, shipped default, decision):',
    ...(Object.keys(thresholds).length ? Object.entries(thresholds).map(([k, o]) => `  ${k} = ${o.value} (default ${o.default}) · ${o.decision} · ${o.at.slice(0, 10)}`) : ['  (none: the shipped data)']),
    ...unknown.map((k) => `  ${k}: names no number of this version's data; ignored`),
    'Executors (providers in order of preference):',
    ...ROLES.map((role) => `  ${role.padEnd(12)}${executors[role].providers.length ? executors[role].providers.join(', ') : '(none)'} (${executors[role].source})`),
    `Flags: ${changed.length ? changed.map(([k, f]) => `${k} ${f.mode} (${f.source})`).join(', ') : 'all at their defaults'}; ${names.bin} flags show lists every flag`,
  ];
  return { data: { repo: where.repo, active: where.active, thresholds, unknownThresholds: unknown, executors, flags, machineConfig: file }, text: `${lines.join('\n')}\n` };
});

// { kind: 'threshold', key (unit.path), unit, default } | { kind: 'executors', role }, or a USAGE refusal.
function parseKey(raw, names) {
  const known = `thresholds.<unit>.<path> (units: ${Object.keys(THRESHOLD_DATA).join(', ')}) or executors.<role> (roles: ${ROLES.join(', ')})`;
  if (raw.startsWith('flags.')) throw usage('use-flags-set', `${raw.slice(0, 60)} is a flag`, `set flags with '${names.bin} flags set ${raw.slice(6, 46)} <mode>'`);
  const t = /^thresholds\.([a-z][a-z0-9]*)\.(.+)$/.exec(raw);
  if (t && Object.hasOwn(THRESHOLD_DATA, t[1])) {
    const key = `${t[1]}.${t[2]}`;
    if (!thresholdKeys(t[1], THRESHOLD_DATA[t[1]]).includes(key)) throw usage('unknown-key', `${raw.slice(0, 80)} names no number of the ${t[1]} threshold data`, `known: ${thresholdKeys(t[1], THRESHOLD_DATA[t[1]]).slice(0, 8).map((k) => `thresholds.${k}`).join(', ')}, …`);
    return { kind: 'threshold', key, default: valueAt(THRESHOLD_DATA[t[1]], t[2]) };
  }
  const e = /^executors\.(.+)$/.exec(raw);
  if (e && ROLES.includes(e[1])) return { kind: 'executors', role: e[1] };
  throw usage('unknown-key', `unknown config key: ${raw.slice(0, 80)}`, `keys: ${known}`);
}

export const configSet = guarded(({ args, flags: opts, io, names }) => {
  const key = parseKey(String(args.key), names);
  const raw = String(args.value);
  const where = here({ io, names });
  if (key.kind === 'executors') {
    if (opts.decision !== undefined) throw usage('unexpected-decision', '--decision applies to threshold overrides only', `drop it: '${names.bin} config set executors.${key.role} <provider,…>'`);
    const providers = raw === DEFAULT ? null : [...new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))];
    if (providers && (providers.length === 0 || providers.length > LIMITS.providers || providers.some((x) => !PATTERNS.kebab.test(x) || x.length > LIMITS.token))) {
      throw usage('invalid-value', `executors.${key.role}: ${JSON.stringify(raw.slice(0, 60))} is not a list of provider names`, `up to ${LIMITS.providers} kebab-case names, comma-separated (such as codex,claude), or ${DEFAULT}`);
    }
    if (!where.active) throw inactive(where, names);
    const store = open(where.dir, { names });
    const doc = store.update('config', null, (cur) => {
      const executors = { ...(cur?.executors ?? {}) };
      if (providers) executors[key.role] = providers; else delete executors[key.role];
      const { executors: _, ...rest } = cur ?? {};
      return Object.keys(executors).length ? { ...rest, executors } : rest;
    });
    const set = doc?.executors?.[key.role] ?? [];
    return { data: { executors: { role: key.role, providers: set } }, text: `executors.${key.role}: ${set.length ? set.join(', ') : 'default (none)'}\n` };
  }
  const value = raw === DEFAULT ? null : /^(0|[1-9]\d{0,9})$/.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(value) || (value !== null && value > LIMITS.thresholdValue)) throw usage('invalid-value', `${args.key}: ${JSON.stringify(raw.slice(0, 20))} is not a whole number from 0 to ${LIMITS.thresholdValue}`, `a whole number, or ${DEFAULT} to remove the override`);
  if (!where.active) throw inactive(where, names);
  const record = requireDecision({ dir: where.dir, id: opts.decision, names, what: `the threshold override ${key.key}` });
  const at = new Date().toISOString();
  const store = open(where.dir, { names });
  store.update('config', null, (cur) => {
    const thresholds = { ...(cur?.thresholds ?? {}) };
    if (value === null) delete thresholds[key.key]; else thresholds[key.key] = { value, decision: record.id, at };
    const { thresholds: _, ...rest } = cur ?? {};
    return Object.keys(thresholds).length ? { ...rest, thresholds } : rest;
  });
  const threshold = { key: key.key, value: value ?? key.default, default: key.default, decision: record.id, at };
  return { data: { threshold }, text: `${key.key} = ${threshold.value} (default ${key.default}) · ${record.id}\n` };
});
