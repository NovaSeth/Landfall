// Secret paths (SEC-13, spec 2026-11-05 D3): a subagent reads no transcript, token or session file. Roots, as real paths and as
// written: the transcripts directory (transcript_path, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects),
// <state>/local/session/ and <state>/local/token.json. secretDeny → the reason or null for Read|Grep|Glob and Bash. An
// ancestor inside the project's repository is no hit for the state roots (an in-repo state directory). Main session → null.
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { caseVariants, prescan } from '../guard/tokens.mjs';
import { LIMIT } from '../guard/index.mjs';
import { globReaches, globRe, inside, realPath } from '../guard/protect.mjs';
import { expandLiterals, parse } from '../guard/tokenizer.mjs';
import { stateDirName } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const SECRET_REASON = "SEC-13: blocked: a subagent does not read Claude Code transcripts or the plugin's token and session files. Instead work from your brief and the repository.";
const HOME = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
const READERS = { find: /./, rg: /./, ag: /./, fd: /./, tar: /./, zip: /./, rsync: /./, du: /./, grep: /^-[a-zA-Z]*[rR]|^--(dereference-)?recursive$|^-d=?recurse/, cp: /^-[a-zA-Z]*[rRa]/, ls: /^-[a-zA-Z]*R/ };
const dirs = (p) => [...new Set([p, realPath(p)])];

function roots(input, env, deadline, names) {
  const home = env.HOME || homedir();
  const name = stateDirName(names);
  const seg = isAbsolute(input.transcript_path ?? '') ? input.transcript_path.split('/') : [];
  const k = seg.lastIndexOf('projects', -2);
  const list = [k > 0 ? seg.slice(0, k + 1).join('/') : seg.length ? dirname(dirname(input.transcript_path)) : null,
    join(isAbsolute(env.CLAUDE_CONFIG_DIR ?? '') ? env.CLAUDE_CONFIG_DIR : join(home, '.claude'), 'projects')];
  const repos = [];
  for (const c of new Set([input.cwd, env.CLAUDE_PROJECT_DIR].filter((d) => typeof d === 'string' && isAbsolute(d)))) {
    const s = stateOf(c, env, deadline);
    const w = s.where ?? s.fallback;
    list.push(join(c, name, 'local'), ...(w ? [w.dir, w.copy].filter(Boolean).map((d) => join(d, 'local')) : []));
    if (w) repos.push(...[w.repo, w.worktree].map(realPath));
  }
  return { list: [...new Set(list.filter(Boolean).flatMap(dirs))], home, cwd: input.cwd, name: name.toLowerCase(), repos };
}
function touches(p, R, ancestors) {
  const forms = dirs(p);
  const anc = ancestors && !forms.some((f) => R.repos.some((r) => inside(r, f) !== null));
  return R.list.some((r) => forms.some((f) => inside(r, f) !== null || (anc && inside(f, r) !== null)));
}
const target = (word, R, d = R.cwd) => {
  const w = word.replace(HOME, R.home);
  return isAbsolute(w) ? resolve(w) : isAbsolute(d ?? '') ? resolve(d, w) : null;
};
const segMatch = (g, n) => { try { return n === undefined || g.includes('**') || g.includes('{') || globRe(g, { dots: true })(n); } catch { return true; } };
// a glob word reaches a root when its fixed part is inside one, or its segments match the root's leading segments
function globHit(abs, R, ancestors) {
  const parts = abs.split('/');
  const rest = parts.slice(parts.findIndex((s) => /[*?[]/.test(s)));
  return dirs(parts.slice(0, parts.length - rest.length).join('/') || '/').some((f) => R.list.some((r) => {
    const rel = inside(f, r);
    if (inside(r, f) !== null) return true;
    if (rel === null || (!ancestors && rest.length < rel.split('/').length)) return false;
    return rest.every((g, i) => segMatch(g, rel.split('/')[i]));
  }));
}

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
const SHELLS = /^(ba|z|da|k)?sh$|^eval$/;
const HOME_VAR = /\$\{HOME\}|\$HOME\b/g;
const GLOBBY = /[*?[]/;
const values = (t) => (t.startsWith('-') ? [] : [t]).concat(t.includes('=') ? [t.slice(t.indexOf('=') + 1)] : []);
// every word and redirection target of every simple command, resolved in each directory a cd chain may have reached;
// literal shell bodies (bash -c, eval) are walked the same way
function walk(cmds, R, dirsNow, depth) {
  for (const c of cmds) {
    const w = c.words.map((x) => x.text);
    const reader = w.find((x) => Object.hasOwn(READERS, basename(x)));
    const anc = reader !== undefined && w.some((x) => READERS[basename(reader)].test(x));
    const words = [...w, ...c.redirs.map((r) => r.target)];
    for (const d of dirsNow) {
      for (const v of words.flatMap(values)) {
        const abs = target(v, R, d);
        if (abs !== null && (GLOBBY.test(v) ? globHit(abs, R, anc) : touches(abs, R, anc))) return true;
      }
      if (anc && touches(target('.', R, d) ?? '/', R, true) && target('.', R, d) !== null) return true;
    }
    const b = basename(w[0] ?? '');
    if (b === 'cd' && w[1] && !w[1].startsWith('-')) dirsNow = [...dirsNow, ...dirsNow.map((d) => target(w[1], R, d)).filter(Boolean)];
    if (!SHELLS.test(b)) continue;
    const body = b === 'eval' ? w.slice(1).join(' ') : w[w.findIndex((x) => /^-[a-z]*c$/.test(x)) + 1];
    if (typeof body !== 'string' || body === '') continue;
    let inner = null;
    try { inner = parse(expandLiterals(body).replace(HOME_VAR, R.home), { limit: LIMIT.cmd }); } catch { /* not reducible */ }
    if (depth > 3 || inner === null ? /\.claude/i.test(body) || body.toLowerCase().includes(R.name) : walk(inner, R, dirsNow, depth + 1)) return true;
  }
  return false;
}
function bashDeny(command, R) {
  let expanded = command; let cmds = null;
  try { expanded = expandLiterals(command).replace(HOME_VAR, R.home); cmds = parse(expanded, { limit: LIMIT.cmd }); } catch { /* not reducible */ }
  const texts = expanded === command ? [command] : [command, expanded];
  const lits = ['lf1_', 'local/token.json', 'local/session', '$claude_config_dir', '${claude_config_dir}', ...R.list, ...['~', '$home', '${home}', R.home].flatMap((h) => ['.claude', R.name].map((n) => `${h}/${n}`))].map((l) => l.toLowerCase());
  if (texts.some((t) => [...prescan(t, lits)].some((h) => h.startsWith('project rule literal')))) return true;
  if (texts.some((t) => reaches(caseVariants(t)[0], '.claude'))) return true;
  if (cmds === null) return texts.some((t) => /\.claude/i.test(t) || t.toLowerCase().includes(R.name));
  return walk(cmds, R, [R.cwd], 0);
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
