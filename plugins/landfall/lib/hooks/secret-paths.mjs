// Secret paths (SEC-13, spec 2026-11-05 D3): a subagent reads no transcript, token or session file. Roots, as real paths and as
// written: the transcripts directory (transcript_path, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects),
// <state>/local/session/ and <state>/local/token.json. secretDeny → the reason or null for Read|Grep|Glob and Bash. An
// ancestor inside the project's repository is no hit for the state roots (an in-repo state directory). Main session → null.
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { caseVariants, prescan } from '../guard/tokens.mjs';
import { LIMIT } from '../guard/index.mjs';
import { globReaches, inside, realPath } from '../guard/protect.mjs';
import { expandLiterals, parse } from '../guard/tokenizer.mjs';
import { stateDirName } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const SECRET_REASON = "SEC-13: blocked: a subagent does not read Claude Code transcripts or the plugin's token and session files. Instead work from your brief and the repository.";
const HOME = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
const READERS = { find: /./, rg: /./, ag: /./, fd: /./, tar: /./, zip: /./, rsync: /./, du: /./, grep: /^-[a-zA-Z]*[rR]|^--(dereference-)?recursive$|^-d=?recurse/, cp: /^-[a-zA-Z]*[rRa]/, ls: /^-[a-zA-Z]*R/ };
const dirs = (p) => [...new Set([p, realPath(p)])];

function roots(input, env, deadline, names) {
  const home = env.HOME || homedir();
  const tp = typeof input.transcript_path === 'string' && isAbsolute(input.transcript_path) ? dirname(dirname(input.transcript_path))
    : join(isAbsolute(env.CLAUDE_CONFIG_DIR ?? '') ? env.CLAUDE_CONFIG_DIR : join(home, '.claude'), 'projects');
  const cwd = [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d)) ?? null;
  const s = cwd ? stateOf(cwd, env, deadline) : {};
  const w = s.where ?? s.fallback ?? null;
  const list = dirs(tp).map((p) => ({ p, state: false }));
  for (const d of w ? [w.dir, w.copy].filter(Boolean) : []) for (const p of dirs(join(d, 'local', 'session')).concat(dirs(join(d, 'local', 'token.json')))) list.push({ p, state: true });
  return { list, home, cwd: input.cwd, name: stateDirName(names).toLowerCase(), repos: w ? [w.repo, w.worktree].map(realPath) : [] };
}
function touches(p, R, ancestors) {
  const forms = dirs(p);
  const own = ancestors && forms.some((f) => R.repos.some((r) => inside(r, f) !== null));
  return R.list.some((r) => forms.some((f) => inside(r.p, f) !== null || (ancestors && !(r.state && own) && inside(f, r.p) !== null)));
}
const target = (word, R) => {
  const w = word.replace(HOME, R.home);
  return isAbsolute(w) ? resolve(w) : R.cwd && isAbsolute(R.cwd) ? resolve(R.cwd, w) : null;
};

function readDeny(input, R) {
  const ti = input.tool_input;
  const tool = input.tool_name;
  let t = [ti.file_path, ti.path].find((v) => typeof v === 'string' && v);
  if (tool === 'Read' && !t) return false;
  if (tool !== 'Read') t ??= R.cwd;
  if (tool === 'Glob' && typeof ti.pattern === 'string') { // the pattern's literal prefix, below the path unless it is absolute
    const segs = ti.pattern.split('/');
    const k = segs.findIndex((x) => /[*?[{]/.test(x));
    const prefix = (k < 0 ? segs : segs.slice(0, k)).join('/');
    t = isAbsolute(ti.pattern) ? prefix || '/' : join(typeof t === 'string' ? t : '', prefix);
  }
  if (typeof t !== 'string' || t.includes('\0')) return false;
  const abs = target(t, R);
  return abs === null || touches(abs, R, tool !== 'Read');
}

const reaches = (text, name) => text.split(/\s+/).some((w) => (/(^|\/)[.[]|\{/.test(w) || w.toLowerCase().includes(name)) && globReaches(w, name));
function bashDeny(command, R) {
  let expanded = command; let cmds = null;
  try { expanded = expandLiterals(command).replace(/\$\{HOME\}|\$HOME\b/g, R.home); cmds = parse(expanded, { limit: LIMIT.cmd }); } catch { /* not reducible */ }
  const texts = expanded === command ? [command] : [command, expanded];
  const lits = ['lf1_', 'local/token.json', 'local/session', '$claude_config_dir', '${claude_config_dir}', ...R.list.map((r) => r.p), ...['~', '$home', '${home}', R.home].flatMap((h) => ['.claude', R.name].map((n) => `${h}/${n}`))].map((l) => l.toLowerCase());
  if (texts.some((t) => [...prescan(t, lits)].some((h) => h.startsWith('project rule literal')))) return true;
  if (texts.some((t) => reaches(caseVariants(t)[0], '.claude'))) return true;
  if (cmds === null) return texts.some((t) => /\.claude/i.test(t) || t.toLowerCase().includes(R.name));
  return cmds.some((c) => {
    const w = c.words.map((x) => x.text);
    const reader = w.find((x) => Object.hasOwn(READERS, basename(x)));
    if (reader === undefined || !w.some((x) => READERS[basename(reader)].test(x))) return false;
    return [...w.filter((x) => !x.startsWith('-')), R.cwd].some((x) => { const abs = typeof x === 'string' ? target(x, R) : null; return abs !== null && touches(abs, R, true); });
  });
}

export function secretDeny(input, { env = process.env, deadline = Infinity } = {}) {
  if (typeof input?.agent_type !== 'string' || !input.agent_type || !input.tool_input || typeof input.tool_input !== 'object') return null;
  const R = roots(input, env, deadline, loadNames());
  const tool = input.tool_name;
  const command = input.tool_input.command;
  const hit = tool === 'Bash' ? typeof command === 'string' && command !== '' && bashDeny(command, R) : /^(Read|Grep|Glob)$/.test(tool) && readDeny(input, R);
  return hit ? SECRET_REASON : null;
}

// The `guard-read` row: Read, Grep, Glob.
export const guardRead = (input, opts) => {
  const reason = secretDeny(input, opts);
  return { stdout: reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) : '' };
};
