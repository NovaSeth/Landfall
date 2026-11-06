// Secret paths (SEC-13, D3, D-MG-81): a subagent reads no transcript and no plugin data file. Roots (real paths and as written): the
// transcripts directory (transcript_path, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects) and the plugin data directory
// ($CLAUDE_PLUGIN_DATA, else <config dir>/plugins/data). secretDeny → the reason or null for Read|Grep|Glob and Bash. Main → null.
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { caseVariants, prescan } from '../guard/tokens.mjs';
import { LIMIT } from '../guard/index.mjs';
import { globReaches, globRe, inside, realPath } from '../guard/protect.mjs';
import { expandLiterals, parse } from '../guard/tokenizer.mjs';
import { loadNames } from './loop-state.mjs';
const names = loadNames();
const SECRET_REASON = "SEC-13: blocked: a subagent does not read Claude Code transcripts or the plugin's data files. Instead work from your brief and the repository.";
const HOME = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
const READERS = { find: /./, rg: /./, ag: /./, fd: /./, tar: /./, zip: /./, rsync: /./, du: /./, grep: /^-[a-zA-Z]*[rR]|^--(dereference-)?recursive$|^-d=?recurse/, cp: /^-[a-zA-Z]*[rRa]/, ls: /^-[a-zA-Z]*R/ };
const dirs = (p) => [...new Set([p, realPath(p)])];
function roots(input, env) { // D-MG-81: local/ holds no secret (hashes, records) and is no root; role-tokens-store-invariant.test.mjs guards it
  const home = env.HOME || homedir();
  const cfg = isAbsolute(env.CLAUDE_CONFIG_DIR ?? '') ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  const seg = isAbsolute(input.transcript_path ?? '') ? input.transcript_path.split('/') : [];
  const k = seg.lastIndexOf('projects', -2);
  const list = [k > 0 ? seg.slice(0, k + 1).join('/') : seg.length ? dirname(dirname(input.transcript_path)) : null, join(cfg, 'projects'),
    isAbsolute(env.CLAUDE_PLUGIN_DATA ?? '') ? env.CLAUDE_PLUGIN_DATA : join(cfg, 'plugins', 'data')];
  return { list: [...new Set(list.filter(Boolean).flatMap(dirs))], home, cwd: input.cwd, root: env.CLAUDE_PLUGIN_ROOT ?? '' };
}
function touches(p, R, ancestors) {
  const forms = dirs(p);
  return R.list.some((r) => forms.some((f) => inside(r, f) !== null || (ancestors && inside(f, r) !== null)));
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
const reaches = (text, name) => text.split(/\s+/).some((w) => /(^|\/)[.[]|\{/.test(w) && globReaches(w, name));
const SHELLS = /^(ba|z|da|k)?sh$|^eval$/; const GLOBBY = /[*?[]/; const HOME_VAR = /\$\{HOME\}|\$HOME\b/g;
const WRAP = /^(env|nice|nohup|timeout|command|builtin|exec|stdbuf|xargs|sudo)$/;
// T-MG-203: only the CLI (bare name or the plugin's absolute bin path) may receive a token through printf %s and --token -.
const RECORD = new RegExp(String.raw`^printf %s lf1_[A-Za-z0-9_-]{43} \| (\/[\w.\/-]*\/)?${names.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (review record|task set)( [\w.:@%+=,\/-]+)* --token -$`);
function recordCmd(command, R) {
  const m = RECORD.exec(command);
  if (!m || command.match(/lf1_/gi).length !== 1) return false;
  return (!m[1] || (isAbsolute(R.root) && realPath(`${m[1]}${names.bin}`) === realPath(join(R.root, 'bin', names.bin)))) ? m : false;
}
const INTERP = /^(python3?|node|perl|ruby)$/;
function bare(w) { let i = 0; while (WRAP.test(basename(w[i] ?? ''))) { i++; while (/^-|^\w+=|^\d+[smhd]?$/.test(w[i] ?? '')) i++; } return w.slice(i); }
const values = (t) => (t.startsWith('-') ? [] : [t]).concat(t.includes('=') ? [t.slice(t.indexOf('=') + 1)] : []);
// every word and redirection target of every simple command, in each directory a cd chain may have reached; shell bodies too
function walk(cmds, R, dirsNow, depth) {
  for (const c of cmds) {
    const w = c.words.map((x) => x.text);
    const reader = w.find((x) => Object.hasOwn(READERS, basename(x)));
    const anc = reader !== undefined && w.some((x) => READERS[basename(reader)].test(x));
    const words = [...w, ...c.redirs.map((r) => r.target)];
    for (const d of dirsNow) {
      for (const v of (d === null ? words.slice(1) : words).flatMap(values)) { // d null: unknown directory, a relative word hits
        const abs = target(v, R, d);
        if (abs === null ? d === null : GLOBBY.test(v) ? globHit(abs, R, anc) : touches(abs, R, anc)) return true;
      }
      if (anc && touches(target('.', R, d) ?? '/', R, true) && target('.', R, d) !== null) return true;
    }
    const a = bare(w); const b = basename(a[0] ?? '');
    if (/^(cd|pushd)$/.test(b)) { // options and -- skipped; no target, `-` or a computed one: the directory is unknown (null)
      const t = (a.includes('--') ? a.slice(a.indexOf('--') + 1) : a.slice(1).filter((x) => !x.startsWith('-')))[0];
      dirsNow = [...dirsNow, ...dirsNow.map((d) => (!t || /[$`*?[{]/.test(t) || d === null ? null : target(t, R, d)))];
    }
    if (INTERP.test(b)) { const code = a[a.findIndex((x) => /^-[ecp]$/.test(x)) + 1] ?? ''; if (/\.claude/i.test(code)) return true; }
    if (!SHELLS.test(b)) continue;
    const body = b === 'eval' ? a.slice(1).join(' ') : a[a.findIndex((x) => /^-[a-z]*c$/.test(x)) + 1];
    if (typeof body !== 'string' || body === '') continue;
    let inner = null;
    try { inner = parse(expandLiterals(body).replace(HOME_VAR, R.home), { limit: LIMIT.cmd }); } catch { /* not reducible */ }
    if (depth > 3 || inner === null ? /\.claude/i.test(body) : walk(inner, R, dirsNow, depth + 1)) return true;
  }
  return false;
}
function bashDeny(command, R) {
  const record = recordCmd(command, R);
  // Scan only the verified program operand as its bare name; identical paths in arguments still go through every floor.
  if (record && record[1]) command = command.replace(`| ${record[1]}${names.bin} `, `| ${names.bin} `);
  let expanded = command; let cmds = null;
  try { expanded = expandLiterals(command).replace(HOME_VAR, R.home); cmds = parse(expanded, { limit: LIMIT.cmd }); } catch { /* not reducible */ }
  const texts = expanded === command ? [command] : [command, expanded];
  const flat = texts.map((t) => t.toLowerCase().replace(/\/(\.?\/)+/g, '/')); // floor: a word naming local/ or the transcripts, any spelling
  if (flat.some((t) => ['.claude/projects', ...R.list.map((l) => l.toLowerCase())].some((n) => t.includes(n)))) return true;
  const lits = [...(record ? [] : ['lf1_']), '$claude_config_dir', '${claude_config_dir}', ...R.list, ...['~', '$home', '${home}', R.home].map((h) => `${h}/.claude`)].map((l) => l.toLowerCase());
  if (texts.some((t) => [...prescan(t, lits)].some((h) => h.startsWith('project rule literal')))) return true;
  if (texts.some((t) => reaches(caseVariants(t)[0], '.claude'))) return true;
  if (cmds === null) return texts.some((t) => /\.claude|\b(cd|pushd)\b/i.test(t)); // unparseable: unknown dir
  return walk(cmds, R, [R.cwd], 0);
}
export function secretDeny(input, { env = process.env } = {}) {
  if (typeof input?.agent_type !== 'string' || !input.agent_type || !input.tool_input || typeof input.tool_input !== 'object') return null;
  const R = roots(input, env);
  const { tool_name: tool } = input; const { command } = input.tool_input;
  const hit = tool === 'Bash' ? typeof command === 'string' && command !== '' && bashDeny(command, R) : /^(Read|Grep|Glob)$/.test(tool) && readDeny(input, R);
  return hit ? SECRET_REASON : null;
}
// The `guard-read` row: Read, Grep, Glob.
export const guardRead = (input, opts) => {
  const reason = secretDeny(input, opts);
  return { stdout: reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) : '' };
};
