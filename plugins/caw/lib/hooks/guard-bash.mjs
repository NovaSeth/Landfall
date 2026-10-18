// PreToolUse Bash hook `guard-bash` (spec §7.13, §8.3, SD-29, SD-33, GC8): runs the guard (lib/guard) on
// tool_input.command. A block is the permission decision JSON with the reason (rule ID first); an allow prints nothing.
// It also runs in subagents and in bypassPermissions mode, in every repository where the plugin is enabled.
// Input outside the contract (tool_input.command not a non-empty string) → allow. The repository of the command's
// directory is resolved once per call through lib/state (lib/hooks/loop-state.mjs stateOf, git bounded by the guard's
// budget): when it is active, its team mode (one registered handle: solo, more: team), its project rules (guard-extra.txt
// of the state directory) and its state directory (the command-owned state files, lib/guard/protect.mjs) reach the guard;
// when it cannot be resolved (machine data unreadable, git missing or slow), the state is unknown: a command that names
// the state directory or a state file is blocked (fail closed, GC8), any other passes; otherwise the team mode is unknown
// (the push-to-main shapes fail closed) and only the universal tokens apply (spec §7.13). Injectable for tests:
// readProjectMode(), readGuardExtra(), state ({ dir, repo } | { unknown, dir, repo } | null), autoAllow ('off' | 'shadow'
// | 'on'; else userConfig auto_allow_own_commands=false → off, else the auto-allow capability flag of lib/config, read
// only for an own command, its default shadow when it cannot be read), shadowLog(entry), git (lib/git's git()).
// The shadow log stays in the plugin data directory until lib/state appends to local/shadow.jsonl (ruling R72, S4).
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { modeOf, readConfig, rollout } from '../config/index.mjs';
import { evaluate } from '../guard/index.mjs';
import { realPath } from '../guard/protect.mjs';
import { open, stateDirName } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const GUARD_EXTRA_MAX = 65536;

// Team mode from the registered handles; a store that refuses to list them (a link, a bad name) throws: the guard
// then has no team mode and fails closed.
export function projectMode(where, names) {
  if (!where) return 'unknown';
  const handles = open(where.dir, { names }).list('team').length;
  return handles === 1 ? 'solo' : handles > 1 ? 'team' : 'unknown';
}
// The project rules of an active repository: guard-extra.txt of its state directory, read directly (only writes are
// reserved to lib/state), never through a link; null when absent. An unreadable file throws: a token is then blocked.
export function guardExtra(where) {
  if (!where) return null;
  const file = join(where.dir, 'guard-extra.txt');
  let st;
  try { st = lstatSync(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
  const refuse = (code) => Object.assign(new Error(code), { code });
  if (st.isSymbolicLink()) throw refuse('a symbolic link');
  if (!st.isFile()) throw refuse('not a regular file');
  if (st.size > GUARD_EXTRA_MAX) throw refuse('too large');
  return readFileSync(file, 'utf8');
}
// The guard's view of the state: { dir, repo } (real paths) for an active one, { unknown, dir, repo, name } when it cannot
// be resolved (dir: the in-repo location when git answers, else null; name: the in-repo directory name), null when there
// is none.
function guardState(s, names) {
  if (s.unknown) return { unknown: s.unknown, dir: s.fallback ? realPath(s.fallback.dir) : null, repo: s.fallback?.repo ?? null, name: stateDirName(names) };
  return s.where?.active ? { dir: realPath(s.where.dir), repo: s.where.repo } : null;
}

const decision = (permissionDecision, reason) => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } }),
});
const deny = (reason) => decision('deny', reason);

// The default shadow log: one JSON line in the plugin data directory (the per-repository log under the state directory
// comes with lib/state). No directory → no log.
function defaultShadowLog(env) {
  return (entry) => {
    const dir = env.CLAUDE_PLUGIN_DATA;
    if (typeof dir !== 'string' || !isAbsolute(dir)) return;
    try { appendFileSync(join(dir, 'shadow.jsonl'), `${JSON.stringify(entry)}\n`); } catch { /* a log never blocks a command */ }
  };
}
const AUTO_ALLOW = 'auto-allow';
function autoAllowMode(opts, env, where, names) {
  if (opts.autoAllow) return opts.autoAllow;
  if (/^(false|0|off|no)$/i.test(env.CLAUDE_PLUGIN_OPTION_AUTO_ALLOW_OWN_COMMANDS ?? '')) return 'off';
  try { return modeOf(AUTO_ALLOW, readConfig(where, { names, env })); } catch { return rollout(AUTO_ALLOW).default; }
}

export function guardBash(input, opts = {}) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command) return { stdout: '' };
  const env = opts.env ?? process.env;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : (env.CLAUDE_PROJECT_DIR || process.cwd());
  const names = loadNames();
  let resolved; // once, and only when a default reader needs it
  const s = () => (resolved ??= stateOf(cwd, env, opts.deadline ?? Infinity));
  const active = () => (s().where?.active ? s().where : null);
  const v = evaluate(command, {
    cwd, env, deadline: opts.deadline, git: opts.git, state: opts.state !== undefined ? opts.state : guardState(s(), names),
    readProjectMode: opts.readProjectMode ?? (() => projectMode(active(), names)),
    readGuardExtra: opts.readGuardExtra ?? (() => guardExtra(active())),
  });
  const stderr = v.warnings.length ? `${v.warnings.join('\n')}\n` : '';
  if (v.deny) return { ...deny(v.deny), stderr };
  if (v.own) {
    const mode = autoAllowMode(opts, env, s().where ?? null, names);
    if (mode === 'on') return { ...decision('allow', `SD-33: own command \`${v.own}\` is on the auto-allow list.`), stderr };
    if (mode === 'shadow') {
      (opts.shadowLog ?? defaultShadowLog(env))({ at: new Date().toISOString(), capability: 'auto-allow', event: 'would-allow',
        subcommand: v.own, command: command.slice(0, 200), cwd });
    }
  }
  return { stdout: '', stderr };
}
