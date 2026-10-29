// Task classifier (spec §7.5, SD-14): trivial / standard / critical from the declared plan (paths, LOC estimate,
// risk flags) and risk globs, deterministic and pure (no file is read). Thresholds and the default risk globs are
// data (thresholds.json):
//   critical  a path matches a risk glob, or a flag in criticalFlags, or files > critical.overFiles, or
//             LOC > critical.overLoc
//   trivial   files <= trivial.maxFiles and LOC <= trivial.maxLoc and no flag at all (new-dependency included)
//   standard  otherwise
// `reasons` lists every reason of the resulting class; `all` lists every reason at every level with a stable key
// (code, plus the flag or the path hash), which the ratchet records on the task and an override waives.
// Paths are repository-relative POSIX paths: `./` and `..` are resolved and duplicates count once; a backslash is a
// file-name character, never a separator (Windows-native shells are out of scope). A path or glob with a control,
// line-terminator, zero-width or bidirectional character is refused (the set lib/state refuses in strings).
// Risk globs: `**` as a whole segment = any number of directories (none too), a trailing `/` or `/**` = the
// directory and everything in it, `*` and `?` stay inside one path segment; a glob without `/` matches a name at any
// depth, one with `/` is anchored at the repository root. Matching ignores case, so a doubtful path errs toward the
// higher class. Matching runs no regular expression: segments by dynamic programming, `*` by leftmost
// placement of the fixed-length parts between stars (correct without backtracking), so the cost is bounded by
// glob length x path length. The profile's risk globs add to the defaults, which stay single-sourced here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { LIMITS } from '../state/index.mjs';
import { usage } from './errors.mjs';

export const THRESHOLDS = Object.freeze(JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8')));
export const FLAGS = Object.freeze([...THRESHOLDS.flags]);
export const CRITICAL_FLAGS = Object.freeze([...THRESHOLDS.criticalFlags]);
export const DEFAULT_RISK_PATHS = Object.freeze([...THRESHOLDS.riskPaths]);
export const DEFAULT_LIGHT_PATHS = Object.freeze([...(THRESHOLDS.lightPaths ?? [])]);
// Input limits: paths per plan; risk globs per list (spec §5.1 profile riskPaths: <= 50 globs of <= 120 chars).
export const MAX_PATHS = 10000;
export const MAX_RISK_GLOBS = 50;
// Control (C0, C1, DEL), line and paragraph separators, zero-width, bidirectional controls, byte-order mark.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

// A repository-relative path in one spelling: no `./`, `..` resolved, no trailing slash ('' when nothing is left).
export function normalizePath(path) {
  const s = posix.normalize(String(path)).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

// ---- glob matcher ----

const GLOBSTAR = Object.freeze({ globstar: true });

// One glob segment: the fixed-length parts between runs of `*` (a single part when there is no star).
function segment(text) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*') cur += text[i];
    else if (text[i - 1] !== '*') { parts.push(cur); cur = ''; }
  }
  parts.push(cur);
  return { parts };
}

export function compileGlob(glob) {
  let g = String(glob).replace(/^(?:\.\/)+/, '');
  const dirOnly = g.length > 1 && g.endsWith('/');
  if (dirOnly) g = g.replace(/\/+$/, '');
  const segs = g.split('/').map((s) => (s === '**' ? GLOBSTAR : segment(s)));
  if (!g.includes('/')) segs.unshift(GLOBSTAR);
  if (dirOnly) segs.push(GLOBSTAR);
  return segs.filter((s, i) => !(s === GLOBSTAR && segs[i - 1] === GLOBSTAR));
}

const sameChar = (a, b) => a === b || a.toLowerCase() === b.toLowerCase();

// `part` (literal characters and `?`) matches `text` at `at`.
function partAt(part, text, at) {
  for (let k = 0; k < part.length; k++) {
    if (part[k] !== '?' && !sameChar(part[k], text[at + k])) return false;
  }
  return true;
}

function matchSegment({ parts }, text) {
  const first = parts[0];
  if (parts.length === 1) return text.length === first.length && partAt(first, text, 0);
  const last = parts[parts.length - 1];
  const end = text.length - last.length;
  if (end < first.length || !partAt(first, text, 0) || !partAt(last, text, end)) return false;
  // Leftmost placement of each middle part leaves the most room for the rest, so no choice is ever revisited.
  let pos = first.length;
  for (let k = 1; k < parts.length - 1; k++) {
    const part = parts[k];
    let at = pos;
    while (at + part.length <= end && !partAt(part, text, at)) at++;
    if (at + part.length > end) return false;
    pos = at + part.length;
  }
  return true;
}

// Compiled glob segments against path segments: ok[j] = "segments i.. of the glob match path segments j..".
function matchSegments(segs, names) {
  const n = names.length;
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let i = segs.length - 1; i >= 0; i--) {
    const cur = new Uint8Array(n + 1);
    if (segs[i] === GLOBSTAR) {
      cur[n] = next[n];
      for (let j = n - 1; j >= 0; j--) cur[j] = next[j] || cur[j + 1];
    } else {
      for (let j = 0; j < n; j++) cur[j] = next[j + 1] && matchSegment(segs[i], names[j]) ? 1 : 0;
    }
    next = cur;
  }
  return next[0] === 1;
}

export const globMatch = (glob, path) => matchSegments(compileGlob(glob), path.split('/'));

// ---- checks ----

const compile = (globs) => globs.map((glob) => ({ glob, segs: compileGlob(glob) }));
const DEFAULT_GLOBS = compile(DEFAULT_RISK_PATHS);
const DEFAULT_LIGHT = compile(DEFAULT_LIGHT_PATHS);

function checkPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw usage('missing-paths', 'name at least one path the plan touches', 'pass --paths <p,…> (repository-relative)');
  if (paths.length > MAX_PATHS) throw usage('limit-exceeded', `${paths.length} paths; the limit is ${MAX_PATHS}`, 'name the directories instead of every file');
  const unique = new Set();
  for (const p of paths) {
    if (typeof p !== 'string' || p.length > LIMITS.path) throw usage('invalid-path', `a path must be text of at most ${LIMITS.path} characters`);
    if (UNSAFE.test(p)) throw usage('invalid-path', `${JSON.stringify(p.slice(0, 80))} contains a control, line-terminator, zero-width or bidirectional character`, 'pass plain repository-relative file paths');
    const n = normalizePath(p);
    if (n === '') throw usage('invalid-path', `${JSON.stringify(p.slice(0, 80))} names no file`, 'pass repository-relative file paths');
    unique.add(n);
  }
  return [...unique];
}

function checkLoc(loc) {
  if (!Number.isSafeInteger(loc) || loc < 0) throw usage('invalid-loc', `the LOC estimate must be a whole number >= 0, got ${JSON.stringify(loc)}`, 'pass --loc <n>');
}

function checkFlags(flags) {
  if (!Array.isArray(flags)) throw usage('invalid-flag', 'flags must be a list');
  for (const f of flags) {
    if (!FLAGS.includes(f)) throw usage('invalid-flag', `unknown risk flag ${JSON.stringify(String(f).slice(0, 40))}`, `known flags: ${FLAGS.join(', ')}`);
  }
  return FLAGS.filter((f) => flags.includes(f));
}

// The default globs plus the profile's additions.
function checkGlobs(extra) {
  if (!Array.isArray(extra) || extra.length > MAX_RISK_GLOBS) throw usage('invalid-risk-paths', `profile risk globs must be a list of at most ${MAX_RISK_GLOBS}`);
  for (const g of extra) {
    if (typeof g !== 'string' || g.length === 0 || g.length > LIMITS.glob || UNSAFE.test(g)) throw usage('invalid-risk-paths', `a risk glob must be plain text of 1-${LIMITS.glob} characters`);
  }
  const added = extra.filter((g, i) => !DEFAULT_RISK_PATHS.includes(g) && extra.indexOf(g) === i);
  return added.length ? [...DEFAULT_GLOBS, ...compile(added)] : DEFAULT_GLOBS;
}

// The key of a path reason: a hash, so recorded keys stay short whatever the path length.
export const pathKey = (path) => `risk-path:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;

const strip = ({ code, text, path }) => (path === undefined ? { code, text } : { code, text, path });

// Weightless paths (retro 2026-10 §3.6, §4.3): documentation, images, media and fonts count for the risk globs and the
// flags, never for the size thresholds. In a 40-task project 37 tasks were critical by size alone, two of them a manual
// and its translation, one a batch of screenshots. A path is weightless by its extension alone (a script under docs/ is
// code; archives, executable formats, .txt manifests such as requirements.txt and .svg, which may carry script, never
// are: review r1 F4); a change made only of weightless paths is `docs-only`: size never raises it above standard.
const WEIGHTLESS_EXT = /\.(?:md|mdx|markdown|rst|adoc|asciidoc|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|mp[34]|mov|webm|ogg|wav|woff2?|ttf|otf|eot)$/i;
export const weightless = (path) => WEIGHTLESS_EXT.test(path);

// Light paths (incident 2026-10-27: a project whose only code was a throwaway UI prototype under mockups/ had every
// change over 400 LOC routed critical by size alone): globs from thresholds.json lightPaths, matched like risk globs.
// Like weightless paths they never count for the size thresholds, but risk globs and flags still apply to them. A
// change made only of weightless and light paths (at least one light) is `light-only`: trivial when small, else
// standard. In a mixed change only the other paths count for the file threshold; LOC is one estimate for the whole
// plan, so when any counted path exists the LOC rule stays as it is today.
// { class, reasons: [{ code, text, path? }], all: [{ code, text, path?, level, key }], files, loc, flags }.
// `riskPaths` are the profile's globs, added to the defaults; `thresholds` are the shipped ones with the repository's
// overrides (lib/config thresholdsOf), the shipped ones when omitted. Size thresholds count the paths that carry weight;
// a docs-only change (every path weightless, no flag) is trivial when small and standard otherwise.
export function classify({ paths, loc, flags = [], riskPaths = [], thresholds = THRESHOLDS } = {}) {
  const files = checkPaths(paths);
  checkLoc(loc);
  const declared = checkFlags(flags);
  const globs = checkGlobs(riskPaths);
  const { trivial, critical } = thresholds;
  const lights = Array.isArray(thresholds.lightPaths) ? (thresholds === THRESHOLDS ? DEFAULT_LIGHT : compile(thresholds.lightPaths)) : [];
  const light = (p) => { const names = p.split('/'); return lights.some((g) => matchSegments(g.segs, names)); };
  // A risk path is never weightless: a change to agent instructions (CLAUDE.md, SKILL.md, ...) is no docs-only change.
  const risky = (p) => { const names = p.split('/'); return globs.some((g) => matchSegments(g.segs, names)); };
  const sized = files.filter((p) => risky(p) || (!weightless(p) && !light(p)));
  const docsOnly = sized.length === 0;
  const lightOnly = docsOnly && files.some(light);

  const all = [];
  const add = (level, code, text, key, path) => all.push(path === undefined ? { code, text, level, key } : { code, text, path, level, key });
  for (const path of files) {
    const names = path.split('/');
    const hit = globs.find((g) => matchSegments(g.segs, names));
    if (hit) add('critical', 'risk-path', `matches risk glob ${hit.glob}`, pathKey(path), path);
  }
  for (const f of declared) if (CRITICAL_FLAGS.includes(f)) add('critical', 'risk-flag', `flag ${f}`, `risk-flag:${f}`);
  if (sized.length > critical.overFiles) add('critical', 'files-over', `${sized.length} files > ${critical.overFiles}`, 'files-over');
  if (!docsOnly && loc > critical.overLoc) add('critical', 'loc-over', `${loc} LOC > ${critical.overLoc}`, 'loc-over');
  const big = files.length > trivial.maxFiles || loc > trivial.maxLoc;
  if (lightOnly && big) add('standard', 'light-only', `${files.length} ${files.length === 1 ? 'file' : 'files'}, ${loc} LOC: size never raises prototype or mockup paths above standard`, 'light-only');
  else if (docsOnly && big) add('standard', 'docs-only', `${files.length} documentation or binary ${files.length === 1 ? 'file' : 'files'}, ${loc} LOC: size never raises docs above standard`, 'docs-only');
  if (!docsOnly && files.length > trivial.maxFiles) add('standard', 'files-over-trivial', `${files.length} files > ${trivial.maxFiles}`, 'files-over-trivial');
  if (!docsOnly && loc > trivial.maxLoc) add('standard', 'loc-over-trivial', `${loc} LOC > ${trivial.maxLoc}`, 'loc-over-trivial');
  for (const f of declared) if (!CRITICAL_FLAGS.includes(f)) add('standard', 'flag', `flag ${f}`, `flag:${f}`);

  const cls = all.some((r) => r.level === 'critical') ? 'critical' : all.length ? 'standard' : 'trivial';
  if (cls === 'trivial') add('trivial', 'small', `${files.length} ${files.length === 1 ? 'file' : 'files'} <= ${trivial.maxFiles}, ${loc} LOC <= ${trivial.maxLoc}, no flags`, 'small');
  return { class: cls, reasons: all.filter((r) => r.level === cls).map(strip), all, files: files.length, loc, flags: declared };
}

export const publicReasons = (reasons) => reasons.map(strip);
