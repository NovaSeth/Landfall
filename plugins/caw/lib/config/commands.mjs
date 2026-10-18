// `<bin> flags show|set` and `<bin> config show|set` (spec §8.2, §14, SD-38, §5.1 config.json): the command
// implementations behind their command table rows (loaded by the CLI only, never by a hook).
//   flags show   every rollout capability (mode, source, what the mode does), then the team flags (lanes and the
//                generated files: set by the engine at a tier change or here; unset = what the tier offers).
//   flags set    one flag of an active repository, to a mode it has; a flip is recorded first as a decision (kind
//                general, the user's --reason as its Why), then written to config.json. The same value writes nothing.
// Context comes from io (cwd, env), never from process state (REV-58). Exit 2 an unknown flag or mode · 7 an inactive
// repository, a newer schema, no consent · 8 not a git repository.
import { relative } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { authorHandle, createDecision } from '../decisions/index.mjs';
import { ENGINE_FLAGS } from '../engine/index.mjs';
import { TARGETS } from '../gen/index.mjs';
import { LIMITS, StateError, machineDataDir, open, resolve } from '../state/index.mjs';
import { ROLLOUT, flagsOf, readConfig, rollout } from './index.mjs';

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
  if (r) return { kind: 'rollout', modes: r.modes, default: r.default, describe: (mode) => r[mode] ?? '' };
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
  const { flags, ignored } = flagsOf(configs);
  const rows = {};
  for (const c of ROLLOUT) rows[c.name] = { ...flags[c.name], kind: 'rollout', default: c.default, modes: [...c.modes], effect: c[flags[c.name].mode] ?? '' };
  for (const name of TEAM_FLAGS) rows[name] = { mode: flags[name]?.mode ?? null, source: flags[name] ? 'repo' : null, kind: 'team', default: null, modes: [...TEAM_MODES], effect: '' };
  for (const [name, f] of Object.entries(flags)) if (!rows[name]) rows[name] = { ...f, kind: 'unknown', default: null, modes: [], effect: 'not a flag of this plugin version' };
  const width = Math.max(...Object.keys(rows).map((k) => k.length)) + 2;
  const line = (name, r) => `  ${name.padEnd(width)}${(r.mode ?? 'unset').padEnd(8)}${(r.source ?? '').padEnd(9)}${r.effect || (r.mode === null ? 'the tier offers it' : '')}`.trimEnd();
  const file = machineFile(where, names, io.env);
  const lines = [
    `Capability flags of ${where.repo} (${where.active ? 'config.json' : 'not active: defaults'}; machine overrides: ${file ?? 'no plugin data directory'})`,
    ...Object.entries(rows).filter(([, r]) => r.kind === 'rollout').map(([n, r]) => line(n, r)),
    'Team flags (set by the engine at a tier change, or here):',
    ...Object.entries(rows).filter(([, r]) => r.kind !== 'rollout').map(([n, r]) => line(n, r)),
    ...ignored.map((n) => `  ${n}: ignored in the machine config (only rollout capabilities are overridden per machine)`),
  ];
  return { data: { repo: where.repo, active: where.active, flags: rows, ignored, machineConfig: file }, text: `${lines.join('\n')}\n` };
});

export const flagsSet = guarded(({ args, flags: opts, io, names }) => {
  const name = String(args.cap);
  const mode = String(args.mode);
  const spec = flagSpec(name);
  if (!spec) throw usage('unknown-capability', `unknown flag: ${name.slice(0, 40)}`, `flags: ${[...ROLLOUT.map((c) => c.name), ...TEAM_FLAGS].join(', ')}`);
  if (!spec.modes.includes(mode)) throw usage('invalid-mode', `${name} has no mode ${JSON.stringify(mode.slice(0, 20))}`, `${name} takes ${spec.modes.join(' or ')}`);
  const where = here({ io, names });
  if (!where.active) throw new StateError('inactive', 'REFUSED', `${where.repo} is not active: flags are recorded only in an active repository`, { hint: `activate it first (${names.bin} init); a machine override goes in ${machineFile(where, names, io.env) ?? 'the plugin data directory'}/config.json` });
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
