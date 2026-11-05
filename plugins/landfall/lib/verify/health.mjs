// Code health (T-MG-188): verify judges the change, not the history. Each changed source file is compared with its
// version at the task base: no baseline file, no bootstrap, no global state. Any language: the file's lines; JS and
// TS also the length of each named function (a brace heuristic over the text with comments and strings blanked).
//   fail  a file that crossed file.hard lines in this change · a function that crossed fn.hard
//   warn  (over) a file or function already over its hard limit at the base that grew: split it first
//   warn  a file that grew past file.warn lines · a new or grown function over fn.warn lines
// A file that shrinks is never flagged; tests (router testPath), generated files (the owner's light paths, as for the
// router: D-MG-31 replaced in-file markers), vendored and built paths and non-source files are exempt. The limits are
// threshold data (`config set thresholds.health.<path>` with a decision, like the router's).
import { lightMatcher } from '../router/classify.mjs';
import { routerThresholds, testPath, thresholdsWithOverrides } from '../router/index.mjs';
import { SKIP_DIRS, blankComments } from './scan.mjs';

export const THRESHOLDS = Object.freeze({ schema: 1, file: Object.freeze({ warn: 500, hard: 800 }), fn: Object.freeze({ warn: 80, hard: 120 }) });

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kts?|swift|rb|php|c|h|cc|cpp|hpp|cs|scala|sh|bash|lua|dart|vue|svelte|exs?|m|mm)$/i;
const BRACES = /\.(?:[cm]?[jt]sx?)$/i;
const BUILT = /(?:^|\/)(?:dist|build)\/|\.min\.[cm]?js$/i;
const JS_LEX = { line: '//', block: true, quotes: '"\'`', keepStrings: false, triple: false };
// function name( · name = (…) => · name: async x => · a method `name(…) {` at the start of a line
const START = /\bfunction\b\s*\*?\s*([\w$]+)\s*\(|([\w$]+)\s*[:=]\s*(?:async\s+)?(?:\([^)]*\)?|[\w$]+\s*=>)|^\s*(?:(?:async|static|get|set)\s+)*([\w$]+)\s*\(/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function']);

const exempt = (path) => !SOURCE.test(path) || testPath(path) || SKIP_DIRS.test(path) || BUILT.test(path);
export const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// The line of the body's closing brace of a function starting on line `i` at column `col`, or -1: braces count only
// outside parentheses and after the parameters closed; an expression body (`=> (`, `;`, `,`) is no body.
function bodyEnd(lines, i, col, bare) {
  let paren = 0;
  let depth = 0;
  let closed = bare;
  for (let j = i; j < lines.length; j++) {
    const s = j === i ? lines[j].slice(col) : lines[j];
    for (const c of s) {
      if (c === '(') { if (closed && depth === 0) return -1; paren++; }
      else if (c === ')') { paren--; if (paren === 0) closed = true; if (paren < 0) return -1; }
      else if (paren === 0 && c === '{' && closed) depth++;
      else if (paren === 0 && c === '}' && depth > 0) { if (--depth === 0) return j; }
      else if (paren === 0 && depth === 0 && closed && (c === ';' || c === ',' || c === '}')) return -1;
    }
  }
  return -1;
}

// name → the length in lines of its longest body (JS and TS).
export function functionsOf(text) {
  const lines = blankComments(text, JS_LEX).split('\n');
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i]);
    const name = m && (m[1] || m[2] || m[3]);
    if (!name || KEYWORDS.has(name)) continue;
    const end = bodyEnd(lines, i, m.index, !m[0].includes('('));
    if (end > i) out.set(name, Math.max(out.get(name) ?? 0, end - i + 1));
  }
  return out;
}

// files: [{ path, before (text at the base; null: new; undefined: unreadable), after (text now, or null) }] → the
// offenders [{ level: fail | warn, path, name?, lines, was, limit }]. light(path): a generated path of the owner.
export function healthOf(files, t = THRESHOLDS, light = () => false) {
  const out = [];
  for (const { path, before, after } of files) {
    if (typeof after !== 'string' || before === undefined || exempt(path) || light(path)) continue;
    const now = lineCount(after);
    const was = before === null ? 0 : lineCount(before);
    // D-MG-68: offenders warn until split
    if (now > was && now > t.file.hard) out.push({ level: was > t.file.hard ? 'warn' : 'fail', over: was > t.file.hard, path, lines: now, was, limit: t.file.hard });
    else if (now > was && now > t.file.warn && was <= t.file.warn) out.push({ level: 'warn', path, lines: now, was, limit: t.file.warn });
    if (!BRACES.test(path)) continue;
    const old = before === null ? new Map() : functionsOf(before);
    for (const [name, n] of functionsOf(after)) {
      const prior = old.get(name) ?? 0;
      if (n <= prior || n <= t.fn.warn) continue;
      const over = prior > t.fn.hard;
      out.push({ level: n > t.fn.hard && !over ? 'fail' : 'warn', over, path, name, lines: n, was: prior, limit: n > t.fn.hard ? t.fn.hard : t.fn.warn });
    }
  }
  return out;
}

// The `code health:` line of verify's output, or null without offenders.
export function healthLine(offenders) {
  if (offenders.length === 0) return null;
  const one = (o) => `${o.level} ${o.path}${o.name ? ` ${o.name}()` : ''} ${o.lines} lines (${o.was ? `was ${o.was}` : 'new'}; over ${o.limit}${o.over ? '; already over the limit at the base: split it first (D-MG-68)' : ''})`;
  return `code health: ${offenders.map(one).join('; ')}: split or refactor ${[...new Set(offenders.map((o) => o.path))].join(', ')}`;
}

// verify's check of the change `paths` since `base`, with growth past a hard limit said as a `code-health` failure:
// git(args) → { status, stdout }; read(path) → the text now or null (at most `max` bytes). The text at the base: null
// for a new path, undefined (skipped) when larger or unreadable. Called once, by verify's evaluate (run.mjs).
export function codeHealth({ store, say, paths, base, git, read, max = 1024 * 1024 }) {
  const show = (p) => {
    const size = git(['cat-file', '-s', `${base}:${p}`]);
    if (size.status !== 0) return null;
    const r = Number(size.stdout) <= max ? git(['show', `${base}:${p}`]) : null;
    return r?.status === 0 ? r.stdout : undefined;
  };
  const light = lightMatcher(routerThresholds(store));
  const files = paths.filter((p) => !exempt(p) && !light(p)).map((path) => ({ path, before: show(path), after: read(path) }));
  const t = thresholdsWithOverrides('health', THRESHOLDS, store);
  const offenders = healthOf(files, t, light);
  const hint = `a file over ${t.file.hard} lines or a function over ${t.fn.hard} lines may not cross it: split or refactor the module named`;
  if (offenders.some((o) => o.level === 'fail')) say('fail', 'code-health', healthLine(offenders), hint);
  return { offenders };
}
