// PreToolUse Bash hook `guard-bash` (spec §7.13, §8.3, SD-29, SD-33, GC8): runs the guard (lib/guard) on
// tool_input.command. A block is the permission decision JSON with the reason (rule ID first); an allow prints nothing.
// It also runs in subagents and in bypassPermissions mode, in every repository where the plugin is enabled, but does
// nothing where the plugin has no state: when the command's directory resolves with certainty to no state at all (not in a
// repository, or a repository with no state directory, not linked, no worktree copy, the directory not inside one), the
// command is allowed at once without being parsed.
// Input outside the contract (tool_input.command not a non-empty string) → allow. The repository of the command's
// directory is resolved once per call through lib/state (lib/hooks/loop-state.mjs stateOf, git bounded by the guard's
// budget): when it is active, its team mode (one registered handle: solo, more: team), its project rules (guard-extra.txt
// of the state directory) and its state directory (the command-owned state files, lib/guard/protect.mjs) reach the guard;
// when it cannot be resolved (machine data unreadable, git missing or slow), the state is unknown: a command that names
// the state directory or a state file is blocked (fail closed, GC8), any other passes; otherwise the team mode is unknown
// (the push-to-main shapes fail closed) and only the universal tokens apply (spec §7.13). In a linked worktree the state
// is its project's, and the worktree's checked-out copy of an in-repo state directory (lib/state resolve `copy`) is
// guarded the same way: the guard runs once per guarded directory and the first block wins. Injectable for tests:
// readProjectMode(), readGuardExtra(), state ({ dir, repo } | { unknown, dir, repo } | null), autoAllow ('off' | 'shadow'
// | 'on'; else userConfig auto_allow_own_commands=false → off, else the auto-allow capability flag of lib/config, read
// only for an own command, its default shadow when it cannot be read), shadowLog(entry), git (lib/git's git()).
// The shadow log stays in the plugin data directory until lib/state appends to local/shadow.jsonl (ruling R72, S4).
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { modeOf, readConfig, rollout } from '../config/index.mjs';
import { evaluate, LIMIT } from '../guard/index.mjs';
import { expandLiterals, parse } from '../guard/tokenizer.mjs';
import { realPath } from '../guard/protect.mjs';
import { heartbeatAgent } from '../sched/index.mjs';
import { open, stateDirName } from '../state/index.mjs';
import { externalBash, isExternalAgent } from './external-bash.mjs';
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
// The guard's views of the state, one per guarded directory (the state directory, then a worktree copy): { dir, repo }
// (real paths) for an active one, { unknown, dir, repo, name } when it cannot be resolved (dir: the in-repo location when
// git answers, else null; name: the in-repo directory name); [null] when there is none.
function guardStates(s, names) {
  const copy = (w, extra) => (w?.copy ? [{ ...extra, dir: realPath(w.copy), repo: w.worktree }] : []);
  if (s.unknown) {
    const extra = { unknown: s.unknown, name: stateDirName(names) };
    return [{ ...extra, dir: s.fallback ? realPath(s.fallback.dir) : null, repo: s.fallback?.repo ?? null }, ...copy(s.fallback, extra)];
  }
  return s.where?.active ? [{ dir: realPath(s.where.dir), repo: s.where.repo }, ...copy(s.where, {})] : [null];
}

// True when the resolved state is certainly empty: no repository, or a repository whose state directory does not exist,
// is not linked, has no worktree copy, and the directory is not inside one. Active, unknown or any trace goes to the guard.
function stateless(s, cwd) {
  if (s.none) return s.certain === true;
  const w = s.where;
  if (s.unknown || !w || w.active || w.linked) return false;
  if (existsSync(w.dir) || (w.copy && existsSync(w.copy))) return false;
  const c = realPath(cwd);
  const inside = (d) => c === d || c.startsWith(d + sep);
  return !inside(w.dir) && !(w.copy && inside(w.copy));
}

// Fails closed, no parsing: the shortcut stays only for plain words (letters, digits and . _ : @ % + , -) separated by single
// spaces, so no quote, escape, expansion, brace, glob, operator, redirection, tab or newline gets through, and none of a
// short option that is -C or -c or has more than one letter (-Cdir, -xC), any long option except --version and --help, a
// directory variable (GIT_DIR, GIT_WORK_TREE), cd, pushd, popd, chdir, a parent path, or a command that moves or removes
// files (rm mv cp ln find xargs): any of them may reach a repository with state.
const PLAIN = /^[\w.:@%+,-]+( [\w.:@%+,-]+)*$/;
const MUST_GUARD = /\b(cd|pushd|popd|chdir|rm|mv|cp|ln|find|xargs)\b|(^|\s)-([Cc]|[A-Za-z0-9]{2,}|-(?!(version|help)(\s|$)))|GIT_DIR|GIT_WORK_TREE|\.\./;
export const mustGuard = (command) => !PLAIN.test(command) || MUST_GUARD.test(command);

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

// Role gate (SEC-13): the trust anchor for a review is the hook input, which an agent cannot write. A subagent (agent_type
// set) never dispatches, and records a review only as the plugin's reviewer or security-reviewer. The gate reads the
// guard's tokenized form (literal variables expanded, quotes removed): each simple command whose program is the binary
// (bare, by path, behind env/node/command/sudo …, or inside a literal `bash -c`) is checked for the words `task set …
// dispatched` and `review record`. A line that cannot be reduced to literal words (an expansion, a substitution, eval, a
// heredoc into a shell) and names the binary is denied for a subagent. Script files and interpreter code are not read.
// The main session (no agent_type) is unchanged.
const SHELLS = /^(ba|z|da|k)?sh$/;
const WRAP = /^(env|command|exec|sudo|nohup|time|nice|xargs|node|builtin)$/;
const base = (t) => t.slice(t.lastIndexOf('/') + 1);
// The argv (after the binary) of every call of the binary in text, pushed to out; false when the text cannot be reduced.
function calls(text, bin, depth, out) {
  let cmds;
  try { cmds = parse(expandLiterals(text), { limit: LIMIT.cmd }); } catch { return false; }
  for (const c of cmds) {
    const w = c.words.map((x) => x.text);
    if (SHELLS.test(base(w[0] ?? ''))) {
      const i = w.findIndex((t, k) => k > 0 && /^-[a-z]*c$/.test(t));
      if (i > 0 && w[i + 1] !== undefined && depth < 3) { if (!calls(w[i + 1], bin, depth + 1, out)) return false; }
      else if (c.heredoc !== null && i < 0 && c.heredoc.includes(bin)) return false;
      continue;
    }
    if (base(w[0] ?? '') === 'eval' && w.some((t) => t.includes(bin))) return false;
    const k = w.findIndex((t) => base(t) === bin);
    if (k >= 0 && w.slice(0, k).every((t) => WRAP.test(base(t)) || t.startsWith('-') || t.includes('='))) out.push(w.slice(k + 1));
  }
  return true;
}
export function roleDeny(input, command, plugin, bin = plugin) {
  const t = input?.agent_type;
  if (typeof t !== 'string' || !t) return null;
  const argvs = [];
  if (command.length > LIMIT.cmd || !calls(command, bin, 0, argvs)) {
    return command.includes(bin) ? `SEC-13: blocked: a subagent cannot run this line, it cannot be read as plain words. Instead write the ${bin} call as plain words.` : null;
  }
  for (const a of argvs) {
    const i = a.indexOf('task');
    if (i >= 0 && a[i + 1] === 'set' && a.indexOf('dispatched', i + 2) > 0) return 'SEC-13: blocked: only the orchestrator dispatches. Instead leave `task set <id> dispatched` to the orchestrator session.';
  }
  if (t !== `${plugin}:reviewer` && t !== `${plugin}:security-reviewer`) {
    for (const a of argvs) {
      const i = a.indexOf('review');
      if (i >= 0 && a[i + 1] === 'record') return 'SEC-13: blocked: only the reviewer agents record a review. Instead let the orchestrator dispatch the reviewer and store its review file.';
    }
  }
  return null;
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// After the decision: refresh the heartbeat of the agent lease bound to input.agent_id (lib/sched, at most once a
// minute). Only a string agent_id of the ID pattern is matched, so an event without one never refreshes an unbound
// lease (T-MG-96 F4). It runs only while BEAT_MIN_LEFT_MS of the guard's deadline remains, with the lock wait capped
// so BEAT_MARGIN_MS stays for the rest, and an error or a timeout is ignored: it never changes the decision nor pushes
// it past its budget (GC8, T-MG-96 F5).
export const BEAT_MIN_LEFT_MS = 150;
const BEAT_MARGIN_MS = 100;
const BEAT_LOCK_MS = 100;
function beat(input, env, deadline = Infinity) {
  const agentId = input?.agent_id;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return;
  const left = deadline - performance.now();
  if (!(left >= BEAT_MIN_LEFT_MS)) return;
  try { heartbeatAgent(agentId, { names: loadNames(), env, lockTimeoutMs: Math.floor(Math.min(BEAT_LOCK_MS, left - BEAT_MARGIN_MS)) }); } catch { /* never changes the decision */ }
}

export function guardBash(input, opts = {}) {
  const r = guardDecision(input, opts);
  beat(input, opts.env ?? process.env, opts.deadline ?? Infinity);
  return r;
}

function guardDecision(input, opts = {}) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command) return { stdout: '' };
  const env = opts.env ?? process.env;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : (env.CLAUDE_PROJECT_DIR || process.cwd());
  const names = loadNames();
  const role = roleDeny(input, command, names.plugin, names.bin);
  if (role) {
    (opts.shadowLog ?? defaultShadowLog(env))({ at: new Date().toISOString(), capability: 'guard-bash', event: 'block', rule: 'SEC-13', command: command.slice(0, 200), cwd });
    return deny(role);
  }
  if (isExternalAgent(input, names.plugin)) { // the external wrapper agent: its policy first (G2); an allowed command still meets the guard
    const r = externalBash(input);
    if (r.code === 2) return r;
  }
  let resolved; // once, and only when a default reader needs it
  const s = () => (resolved ??= stateOf(cwd, env, opts.deadline ?? Infinity));
  const active = () => (s().where?.active ? s().where : null);
  if (opts.state === undefined && !mustGuard(command) && stateless(s(), cwd)) return { stdout: '' };
  let v;
  for (const state of opts.state !== undefined ? [opts.state] : guardStates(s(), names)) {
    v = evaluate(command, {
      cwd, env, deadline: opts.deadline, git: opts.git, state,
      readProjectMode: opts.readProjectMode ?? (() => projectMode(active(), names)),
      readGuardExtra: opts.readGuardExtra ?? (() => guardExtra(active())),
    });
    if (v.deny) break;
  }
  const stderr = v.warnings.length ? `${v.warnings.join('\n')}\n` : '';
  if (v.deny) {
    // every block is logged (plugin data shadow.jsonl), so `doctor` can count the blocks of the last days: a block on a
    // read or a plain idiom is a gap of the guard, not of the command (retro 2026-10 §4.1)
    (opts.shadowLog ?? defaultShadowLog(env))({ at: new Date().toISOString(), capability: 'guard-bash', event: 'block', rule: /^([A-Z]{3}-\d+)/.exec(v.deny)?.[1] ?? 'other', command: command.slice(0, 200), cwd });
    return { ...deny(v.deny), stderr };
  }
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
