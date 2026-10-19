// The Bash guard (spec §7.13, SD-29, SEC-3): a seatbelt against an accidental rule break by a cooperating agent, not a
// security boundary — a script from a file or code in another language can carry anything. The hard boundaries are on
// git's side: server branch protection, the secrets scan in the pre-push hook and in CI.
// Decision model — an allowlist of SHAPES (the guard does not prove arbitrary syntax harmless):
// 1. Prescan (tokens.mjs): a normalized text without a guarded token and without a project-rule literal → allow.
// 2. A token present → the whole command MUST be plain simple commands (tokenizer.mjs) and each MUST match a shape
//    (shapes.mjs, git-shape.mjs); a shape that recognizes a broken rule blocks with its rule ID.
// 3. Fail open only without a token. State a shape depends on (current branch, team mode, project rules, package.json,
//    tracked directories) read with an error or ambiguously → no shape; an error or an exceeded limit with a token
//    present → block. The path of an active state directory (opts.state) is a prescan literal too (protect.mjs).
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ownCommand } from './allow.mjs';
import { loadRules, ruleMatches } from './extra.mjs';
import { git } from '../git/index.mjs';
import { MSG, short } from './messages.mjs';
import { OWNED_NAMES, globReaches, inside, realPath, stateText } from './protect.mjs';
import { effects, shape } from './shapes.mjs';
import { NotPlain, parse, why } from './tokenizer.mjs';
import { BIN, caseVariants, prescan, variants } from './tokens.mjs';

export const LIMIT = Object.freeze({ cmd: 65536, spawns: 16, simple: 200 });
const TEAM_MODES = new Set(['solo', 'team']);

// The analysis context of one command. opts: cwd (the command's directory), env, deadline (performance.now() ms),
// readProjectMode() → 'solo' | 'team' | 'unknown', literals (project-rule tokens), git (lib/git's git(); tests memoize it),
// state ({ dir, repo }: the active state of the command's repository from lib/state, real paths; or null).
function context({ cwd, env = process.env, deadline = Infinity, readProjectMode, literals = [], git: runGit = git, state = null, stateHit = false }) {
  const branches = new Map(); const pushConfigs = new Map(); const tops = new Map(); const roots = new Map(); let mode; let spawns = 0;
  // one git call within the spawn limit and the deadline; a missing or silent git has no answer
  const gitRun = (dir, args) => {
    if (++spawns > LIMIT.spawns) throw new Error('too many git calls');
    const left = deadline - performance.now();
    if (left <= 0) throw new Error('analysis over its time budget');
    const r = runGit(['-C', dir, ...args], { env, timeoutMs: Math.max(1, Math.floor(Math.min(2000, left))) });
    if (r.error) throw new Error(r.error === 'missing' ? 'git is not on PATH' : 'git did not answer in time');
    return r;
  };
  const ctx = {
    cwd, cwdHint: null, env, state, stateHit, unsure: false, shadowNames: new Set(), simple: [],
    tick() { if (performance.now() > deadline) throw new Error('analysis over its time budget'); },
    inDir: (dir, v) => (/^~/.test(v) ? null : /^\//.test(v) ? resolve(v) : dir === null ? null : resolve(dir, v)),
    // code to run (bash -c, eval, node -e …): no token and no project-rule literal
    codeTok: (t) => prescan(t, literals).size > 0,
    // The current branch of the repository in dir (a push without a refspec, or with HEAD, pushes it). An unknown
    // directory, a possible state change earlier in the line (drift), a detached HEAD, an unborn branch, a git error → no shape.
    branch(dir) {
      if (dir === null || ctx.unsure) why('the branch is unknown or may change earlier in the line: push alone or name an explicit refspec');
      if (!branches.has(dir)) {
        const run = (args) => gitRun(dir, args);
        const r = run(['symbolic-ref', '-q', '--short', 'HEAD']);
        const ok = r.status === 0 && r.stdout.trim() && run(['rev-parse', '-q', '--verify', 'HEAD^{commit}']).status === 0;
        branches.set(dir, ok ? r.stdout.trim() : null);
      }
      return branches.get(dir) ?? why('cannot tell the current branch (detached HEAD, unborn branch, git error): name an explicit refspec');
    },
    // The push config that maps a push of the current branch: remap — any remote.<name>.push or .mirror (no refspec, HEAD,
    // @); pushDefault — push.default upstream / tracking / matching (no refspec only). An unknown directory or a git error → no shape.
    pushConfig(dir) {
      if (dir === null) why('the push goes to an unknown repository: name an explicit <src>:<dst> refspec');
      if (!pushConfigs.has(dir)) {
        if (++spawns > LIMIT.spawns) throw new Error('too many git calls');
        const left = deadline - performance.now();
        if (left <= 0) throw new Error('analysis over its time budget');
        const r = runGit(['-C', dir, 'config', '--get-regexp', '^(remote\\..*\\.(push|mirror)|push\\.default)$'], { env, timeoutMs: Math.max(1, Math.floor(Math.min(2000, left))) });
        if (r.error || (r.status !== 0 && r.status !== 1)) why('cannot read the push config of the repository: name an explicit <src>:<dst> refspec');
        const lines = r.status === 0 ? r.stdout.trim().split('\n') : [];
        pushConfigs.set(dir, { remap: lines.some((l) => /^remote\.\S+\.push\s/i.test(l) || /^remote\.\S+\.mirror\s+(true|yes|on|1)\s*$/i.test(l)),
          pushDefault: lines.some((l) => /^push\.default\s+(upstream|tracking|matching)\s*$/i.test(l)) });
      }
      return pushConfigs.get(dir);
    },
    // The real top level of the repository holding dir, or null outside one (lib/guard/protect.mjs, removals).
    repoTop(dir) {
      if (!tops.has(dir)) {
        const r = gitRun(dir, ['rev-parse', '--show-toplevel']);
        let top = null;
        if (r.status === 0 && r.stdout.trim()) { try { top = realpathSync.native(r.stdout.trim()); } catch { top = null; } }
        tops.set(dir, top);
      }
      return tops.get(dir);
    },
    // The top-level directories in HEAD's tree (none before the first commit); another git error → no shape.
    trackedRoots(top) {
      if (!roots.has(top)) {
        const r = gitRun(top, ['ls-tree', '-d', '--name-only', '-z', 'HEAD']);
        if (r.status === 0) roots.set(top, new Set(r.stdout.split('\0').filter(Boolean)));
        else if (gitRun(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).status !== 0) roots.set(top, new Set());
        else why('cannot list the tracked directories of the repository');
      }
      return roots.get(top);
    },
    // Team mode through the injected reader; an error or any answer other than solo / team → no shape.
    teamMode() {
      if (mode === undefined) { try { mode = readProjectMode?.(); } catch { mode = null; } }
      return TEAM_MODES.has(mode) ? mode : why('cannot read the team mode (solo or team)');
    },
  };
  return ctx;
}

// The whole line: plain syntax, then the shape of each simple command in order (effects of cd / switch for the next ones).
function checkLine(src, ctx) {
  const cmds = parse(src, { tick: ctx.tick, limit: LIMIT.cmd });
  for (const c of cmds) if (ctx.simple.length < LIMIT.simple) ctx.simple.push(c.words.map((x) => x.text).join(' '));
  for (const c of cmds) {
    // a cd after && moved the cwd only along its && chain: a command after ; or a newline may run where the line began
    if (ctx.cwdConditional && c.before !== '&&') { ctx.cwd = null; ctx.cwdConditional = false; ctx.unsure = true; }
    const v = shape(c, ctx);
    if (v) return v;
    effects(c, c.words.map((x) => x.text), ctx);
  }
  return null;
}

// The prescan literals of the state (lowercase, like the token variants): the text that names its directory (when it is
// known; else the in-repo directory name `name` of an unknown state, findings-r2 A-I1) and the names of the owned files.
const stateLiterals = (state) => [...(state?.dir ? [stateText(state)] : state?.name ? [state.name.toLowerCase()] : []), ...OWNED_NAMES];
// A path with a segment named `name` (any case).
const hasSegment = (path, name) => path.toLowerCase().split('/').includes(name.toLowerCase());
// The command names the state: a literal, a glob or brace that can reach its directory, a git subcommand that rewrites
// paths (its pathspec may be `.`; the subcommand is the first word after git and its global options, each of which may
// take one value word, never a word of the arguments, findings-r2 A-m2), or the command runs inside the state directory
// (without a known directory: under a segment with its name).
const GIT_REWRITE = /(^|[\s/;&|(])git(\s+-\S*(\s+[^\s-]\S*)?)*\s+(checkout|restore|clean|rm|mv)(\s|$)/;
function namesState(command, state, cwd) {
  const dirName = state.dir ? realPath(state.dir).split('/').pop() : state.name ?? null;
  if (typeof cwd === 'string') {
    const here = realPath(resolve(cwd));
    if (state.dir ? inside(state.dir, here) !== null : dirName !== null && hasSegment(here, dirName)) return true;
  }
  const vs = variants(command);
  if (stateLiterals(state).some((l) => vs.some((v) => v.includes(l)))) return true;
  if (dirName !== null && globReaches(caseVariants(command)[0], dirName)) return true;
  return vs.some((v) => GIT_REWRITE.test(v));
}

// The verdict for one command: { deny: reason } or { own: subcommand | null }, plus warnings (project rules skipped).
// opts: cwd, env, deadline, readProjectMode, readGuardExtra() → the guard-extra.txt text or null, state ({ dir, repo }
// active · { unknown, dir, repo, name } cannot be resolved: a command that names it is blocked (C3; name = the in-repo
// directory name, used when dir is null) · null).
export function evaluate(command, opts = {}) {
  const warnings = [];
  let hits = new Set();
  try {
    let text = null;
    try { text = opts.readGuardExtra?.() ?? null; } catch (e) {
      // project rules cannot be read: a token blocks, no token passes
      return prescan(command).size ? { deny: MSG.shape(`cannot read guard-extra.txt (${e.code ?? e.message})`), warnings } : { own: null, warnings };
    }
    const { rules, warnings: w } = loadRules(text);
    warnings.push(...w);
    const st = opts.state ?? null;
    const stateHit = st !== null && namesState(command, st, opts.cwd);
    if (st?.unknown && stateHit) return { deny: MSG.stateUnknown(String(st.unknown).slice(0, 60), BIN), warnings };
    const state = st?.unknown ? null : st;
    const literals = [...rules.flatMap((r) => r.literals), ...(state ? stateLiterals(state) : [])];
    hits = prescan(command, literals);
    if (state && stateHit) hits.add('names the state directory');
    const ctx = context({ ...opts, literals, state, stateHit: state !== null && stateHit });
    // project rules: first on the text (the project message wins), after parsing on the simple commands
    const applyRules = (inputs) => {
      for (const r of rules) {
        let hit;
        try { hit = ruleMatches(r.rx, inputs, { limit: LIMIT.cmd }); } catch { return MSG.ruleTimeout(r.line, r.msg); }
        if (hit) return MSG.rule(r.line, r.msg);
      }
      return null;
    };
    const textRule = rules.length ? applyRules([command, ...caseVariants(command.slice(0, LIMIT.cmd))]) : null;
    if (textRule) return { deny: textRule, warnings };
    if (hits.size) {
      ctx.tick();
      if (command.length > LIMIT.cmd) why(`a command longer than ${LIMIT.cmd} characters`);
      const verdict = checkLine(command, ctx);
      if (verdict) return { deny: verdict, warnings };
      const simpleRule = applyRules(ctx.simple);
      if (simpleRule) return { deny: simpleRule, warnings };
    }
    return { own: ownCommand(command), warnings };
  } catch (e) {
    if (!hits.size) return { own: null, warnings };
    const timeUp = /time budget/.test(e?.message ?? '');
    return { deny: timeUp ? MSG.timeout : MSG.shape(e instanceof NotPlain ? e.message : `analysis error: ${short(String(e?.message ?? e), 80)}`), warnings };
  }
}

// A raw text (a handler that failed or answered too late) holds a guarded token, names a command-owned state file, or
// names the state directory `stateName` (the in-repo directory name) as a literal or a glob that reaches it (A-I1).
export function hasToken(text, stateName = null) {
  if (prescan(text, [...OWNED_NAMES, ...(stateName ? [stateName.toLowerCase()] : [])]).size > 0) return true;
  return Boolean(stateName) && globReaches(caseVariants(text)[0], stateName);
}
