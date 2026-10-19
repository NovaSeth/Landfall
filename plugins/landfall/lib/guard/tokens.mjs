// Guarded tokens (spec §7.13, SD-29, SEC-3): the single source of what makes the Bash guard look closer. A command whose
// normalized text holds none of these tokens passes without analysis (prescan); a command that holds one must have a
// recognized simple form (shapes.mjs). Also the single lists of outcome-gate commands (a pipe after one is blocked:
// TRP-2, SEC-6) and of environment variables whose value a shell, git or the loader runs (G152 r3 b).
import { readFileSync } from 'node:fs';
import { configKey } from './config-keys.mjs';
import { GIT_ARG, GIT_BUILTINS } from './git-options.mjs';

// The plugin's own command (argv[0] of its CLI), from lib/name.json.
export const BIN = JSON.parse(readFileSync(new URL('../name.json', import.meta.url), 'utf8')).bin;
const binRe = BIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase();

export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
export const CODE_RUNNERS = new Set([...SHELLS, 'eval', 'source', '.', 'python', 'python2', 'python3', 'node', 'nodejs', 'perl', 'ruby', 'php',
  'osascript', 'lua', 'pwsh', 'deno']);
export const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'esac', 'function', 'coproc', 'for', 'select', 'case', 'time']);
// Wrappers that run the following words as a command (for the prescan: the command name after the wrapper).
const WRAP = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'setsid', 'chronic', 'unbuffer', 'stdbuf', 'caffeinate', 'env', 'sudo', 'doas',
  'nice', 'ionice', 'timeout', 'xargs', 'npx', 'pnpx', 'bunx', 'busybox', 'toybox']);
export const base = (w) => w.slice(w.lastIndexOf('/') + 1);

// Environment variables whose value a shell, git or the dynamic loader runs or reads as configuration (G152 r3 b).
export const ENV_EXEC = /^(BASH_ENV|ENV|BASH_FUNC_\S*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|GIT_CONFIG\w*|GIT_SSH\w*|GIT_EXEC_PATH|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_TEMPLATE_DIR|PAGER|EDITOR|VISUAL|SSH_ASKPASS|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w*|NODE_OPTIONS)$/i;
// The same names as words in a command (not as an expansion $NAME / ${NAME}, which only reads them).
const ENV_WORD = /(?<![\w${])(BASH_ENV|ENV|BASH_FUNC_\w*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|GIT_CONFIG\w*|GIT_SSH\w*|GIT_EXEC_PATH|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_TEMPLATE_DIR|PAGER|EDITOR|VISUAL|SSH_ASKPASS|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w*|NODE_OPTIONS)(?!\w)/;

// Outcome-gate commands (lesson 2026-10-15 04:09, TRP-2, SEC-6): a pipe after one reports the exit code of the last
// command. script — a gate script run as the program; sub — a subcommand path of the plugin CLI; pmScript — a package
// script name; text — the gate named in a package.json script body (lowercase). Test runs are no gate (ruling R60: verify
// re-runs the gates itself and reads their exit codes).
export const GATES = Object.freeze([
  { id: 'secrets scan', rule: 'SEC-6', script: /check-secrets\.sh$/, sub: ['secrets'], pmScript: /^check-secrets(:|$)/, text: /check-secrets/ },
  { id: 'machine budget', rule: 'TRP-2', script: /(^|\/)budget\.sh$/, text: /budget\.sh/ },
  { id: 'slot admission', rule: 'TRP-2', sub: ['slot acquire', 'heavy'], text: new RegExp(`(^|[\\s/])${binRe}\\s+(slot\\s+acquire|heavy)(\\s|$)`) },
  { id: 'verify', rule: 'TRP-2', sub: ['verify'], text: new RegExp(`(^|[\\s/])${binRe}\\s+verify(\\s|$)`) },
]);
export const gateById = (id) => GATES.find((g) => g.id === id);
// A segment with a pipe that names a gate command, a package manager or the plugin's gate subcommands.
const GATE_LINE = new RegExp(`(^|[\\s/])(check-secrets|budget\\.sh|npm|pnpm|yarn|bun)(\\s|$|\\.|:)|(^|[\\s/])${binRe}\\s(.*\\s)?(secrets|verify|slot|heavy)(\\s|$)`);

// The first command word of a segment (after assignments, keywords and wrappers).
function commandWord(seg) {
  const ws = seg.trim().split(' ');
  let k = 0;
  while (k < ws.length) {
    const w = ws[k].replace(/^[({!]+/, '');
    if (!w || /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w) || KEYWORDS.has(w)) { k++; continue; }
    if (WRAP.has(base(w))) { k++; while (k < ws.length && ws[k].startsWith('-')) k++; continue; }
    return w;
  }
  return '';
}
const GIT = /(^|[\s/])git(\s|$)/;
// `git <word>` where the word is no builtin: maybe an alias from the repository config (content outside the command text).
function gitAliasCandidate(seg) {
  const ws = seg.split(' ');
  for (let k = 0; k < ws.length; k++) {
    if (!/^(?:.*\/)?git$/.test(ws[k])) continue;
    let j = k + 1;
    while (j < ws.length && ws[j].startsWith('-')) j += GIT_ARG.has(ws[j]) ? 2 : 1;
    if (j < ws.length && /^[\w-]+$/.test(ws[j]) && !GIT_BUILTINS.has(ws[j])) return true;
  }
  return false;
}
// git config naming a key from the one list, or renaming a section (which may become a listed section).
const gitConfigKey = (s) => /(^|[\s/])git(-config)?(\s|$)/.test(s) && /(^|[\s/-])config(\s|$)/.test(s)
  && s.split(' ').some((w) => configKey(w.split('=')[0]) !== null || /^(--ren|rename-section)/.test(w));

// operators glued to the command (a|rm, a;rm, a&&rm) count: the leading class holds | ; & ( / and whitespace
const RM_RECURSIVE = /(^|[\s/(|;&])rm\s(.*\s)?(-[a-z]*r[a-z]*|--r[a-z]*)(\s|$)/;
const FIND_DELETE = /(^|[\s/(|;&])find(\s.*)?\s(-delete|-(exec|execdir|ok|okdir)\s+(\S*\/)?rm)(\s|$)/;

// The tokens. Checked on the normalized variants of the text: word — a word anywhere (lowercase); cased — a word with its
// case kept; line — a construct on a segment between ; and & that may build a guarded operation from content outside
// the command text; text — a construct on the whole variant (a pipe after a gate: 2>&1 before the pipe holds a &).
export const GUARDED = Object.freeze([
  { id: 'stash', word: /stash/ },
  { id: 'push', word: /push/ },
  { id: '--no-verify', word: /no-ver/ },
  { id: 'hooksPath', word: /hookspath/ },
  { id: 'include.path', word: /include[^\s=]*\.path/ },
  { id: 'check-secrets', word: /check-secrets/ },
  { id: 'hook files', word: /\.githooks|\.husky|\.git\/hooks|(^|[\s/=])\.git\/?($|\s)/ },
  { id: 'commit', word: /commit/ },
  { id: 'alias', word: /alias/ },
  { id: 'eval', word: /(^|[^\w-])eval($|[^\w-])/ },
  { id: 'exec env var', cased: ENV_WORD },
  { id: 'git -c', line: (s) => GIT.test(s) && /\s-c/.test(s) },
  // the same config on the sibling paths: --config-env, clone / fetch / pull -c (also in a cluster), --config and
  // clone / init --template (also abbreviated)
  { id: 'git config or template', line: (s) => GIT.test(s) && (/\s--(co(n(f(i(g(-env)?)?)?)?)?|te(m(p(l(a(t(e)?)?)?)?)?)?)(=|\s|$)/.test(s)
    || (/\s(clone|fetch|pull)(\s|$)/.test(s) && /\s-[a-zA-Z]*c/.test(s))) },
  { id: 'git config key', line: gitConfigKey },
  { id: 'git alias from config', line: gitAliasCandidate },
  { id: 'ext transport', line: (s) => GIT.test(s) && s.includes('ext::') }, // ext::<command> runs the command
  // git config with the core section (also --rem / --rena, which cannot be listed as fixed text)
  { id: 'core section', line: (s) => (/(rename|remove)-section/.test(s) || /(^|[\s/-])config(\s|$)/.test(s)) && /(^|\s)core(\s|$|\.)/.test(s) },
  { id: '--no-verify abbreviation', line: (s) => GIT.test(s) && /\s--no-ve?(\s|=|$)/.test(s) },
  { id: 'package manager in a pipe', line: (s) => /(^|[\s/])(npm|pnpm|yarn|bun)(\s|$)/.test(s) && s.includes('|') },
  { id: 'gate in a pipe', text: (v) => v.split(/;|&&|\|\|/).some((s) => /(^|[^|])\|(?!\|)/.test(s) && GATE_LINE.test(s)) },
  { id: 'command name from an expansion', line: (s) => s.split('|').some((p) => /[$`]/.test(commandWord(p))) },
  { id: 'git with an expansion', line: (s) => s.split('|').some((p) => { const g = p.search(/(^|[\s/(])git(\s|$)/); return g >= 0 && /[$`]/.test(p.slice(g)); }) },
  { id: 'code from an expansion', line: (s) => s.split('|').some((p) => { const ws = p.split(' '); const k = ws.findIndex((x) => CODE_RUNNERS.has(base(x))); return k >= 0 && /[$`]|<\(/.test(ws.slice(k + 1).join(' ')); }) },
  { id: 'pipe to a shell or interpreter', line: (s) => s.split('|').slice(1).some((p) => CODE_RUNNERS.has(base(commandWord(p)))) },
  { id: 'xargs to code or git', line: (s) => s.split('|').some((p) => { const ws = p.split(' ').map(base); const k = ws.indexOf('xargs'); return k >= 0 && ws.slice(k + 1).some((x) => x === 'git' || CODE_RUNNERS.has(x)); }) },
  // a recursive removal (rm -r / -R / --recursive in any spelling, find … -delete): its target may be a tracked top-level
  // directory or the repository itself (spec §7.13, lib/guard/protect.mjs)
  { id: 'recursive remove', line: (s) => RM_RECURSIVE.test(s) || FIND_DELETE.test(s) },
]);

// ---------- normalization ----------
const decodeEscapes = (s) => s.replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{4})|([0-7]{1,3}))/g,
  (_, x, u, o) => String.fromCharCode(parseInt(x ?? u ?? o, o === undefined ? 16 : 8)));
function ansiC(s) {
  const esc = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  let out = ''; let j = 0;
  while (j < s.length && s[j] !== "'") {
    if (s[j] !== '\\') { out += s[j++]; continue; }
    const c = s[j + 1]; let m;
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2, j + 4)))) { out += String.fromCharCode(parseInt(m[0], 16)); j += 2 + m[0].length; }
    else if ((m = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4)))) { out += String.fromCharCode(parseInt(m[0], 8)); j += 1 + m[0].length; }
    else { out += esc[c] ?? `\\${c ?? ''}`; j += 2; }
  }
  return out;
}
const ansiDecoded = (text) => text.replace(/\$'((?:[^'\\]|\\[\s\S])*)'?/g, (_, b) => ansiC(`${b}'`)).replace(/\$"/g, '"');
const flat = (s) => s.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '').replace(/\s+/g, ' ');
// Variants with the case kept (project rules, cased tokens): no quotes and backslashes, $'…' and \xHH decoded.
export const caseVariants = (text) => { const a = ansiDecoded(text); return [flat(a), flat(decodeEscapes(a))]; };
// Variants for the tokens (lowercase): also ${X:-default} → default, no $X / $(…) / `…`, and no {,}.
export function variants(text) {
  const [v1, v2] = caseVariants(text).map((s) => s.toLowerCase());
  const v3 = v2.replace(/\$\{[#!]?\w*(?:\[[^\]]*\])?(?::?[-=+?#%/^,]+([^}]*))?\}/g, '$1').replace(/\$(?:\w+|[@*#?$!-])/g, '').replace(/[`$()]/g, '');
  return [v1, v2, v3, v3.replace(/[{},]/g, '')];
}

// A text longer than this gets a coarse prescan in linear time: the word tokens on the same variants as below (raw
// and decoded, without expansions, without braces), and any trigger of a line token (git, a pipe, $, a backtick, <(,
// xargs, config, rm, -delete) counts as a hit. Such a text is blocked when it has a hit (too long to analyze) and allowed otherwise.
export const LONG_TEXT = 65536;
const ROUGH = /(^|[\s/])git|\||[$`]|<\(|xargs|config|-section|(^|[\s/(;&])rm\s|\s-delete/;
function coarse(text, literals) {
  const strip = (s) => s.replace(/\\\r?\n|['"\\]/g, '');
  const a = ansiDecoded(text); const c1 = strip(a); const c2 = strip(decodeEscapes(a));
  const v3 = c2.toLowerCase().replace(/\$\{[#!]?\w*(?:\[[^\]]*\])?(?::?[-=+?#%/^,]+([^}]*))?\}/g, '$1').replace(/\$(?:\w+|[@*#?$!-])/g, '').replace(/[`$()]/g, '');
  const vs = [c1.toLowerCase(), c2.toLowerCase(), v3, v3.replace(/[{},]/g, '')]; const cs = [c1, c2]; const hits = new Set();
  for (const g of GUARDED) if ((g.word && vs.some((v) => g.word.test(v))) || (g.cased && cs.some((v) => g.cased.test(v)))) hits.add(g.id);
  if (vs.some((v) => ROUGH.test(v))) hits.add('a line-token trigger in a long text');
  for (const l of literals) if (vs.some((v) => v.includes(l))) hits.add(`project rule literal "${l}"`);
  return hits;
}
// Prescan: the tokens (and the literals of project rules) present in a command.
export function prescan(text, literals = []) {
  if (text.length > LONG_TEXT) return coarse(text, literals);
  const vs = variants(text); const hits = new Set(); let cs = null;
  for (const g of GUARDED) {
    if (g.word && vs.some((v) => g.word.test(v))) hits.add(g.id);
    if (g.cased && (cs ??= caseVariants(text)).some((v) => g.cased.test(v))) hits.add(g.id);
    if (g.line && vs.some((v) => v.split(/[;&]/).some(g.line))) hits.add(g.id);
    if (g.text && vs.some(g.text)) hits.add(g.id);
  }
  for (const l of literals) if (vs.some((v) => v.includes(l))) hits.add(`project rule literal "${l}"`);
  return hits;
}
// A word that holds a word token (or a cased one): data only where the shape says so.
export function wordTok(t) {
  const vs = variants(t); let cs = null;
  return GUARDED.some((g) => (g.word && vs.some((v) => g.word.test(v))) || (g.cased && (cs ??= caseVariants(t)).some((v) => g.cased.test(v))));
}
