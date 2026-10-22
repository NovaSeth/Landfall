// Test renames (retro 2026-10 §4.2; COD-3): a test that verify sees removed by its title, whose normalized body is
// present in the same file under a title the run sees added, changed its name, not its assertions, and needs no
// decision. The title is the reporter's full title (`describe > test`, as the jest/vitest and node:test collectors
// build it); the body is the sha256 of the test call's arguments after the title with every whitespace removed, read
// from the source at the anchor commit (git show) and in the working tree. A parametrized test (`it.each(table)('title
// %s', fn)`) keeps a template title; its cases are matched against the template with each placeholder (%s %d %i %f %j
// %o %O %p %#, $name, $name.path) standing for any text, and its body includes the table, so a changed table is no
// rename. A test file that moved pairs by title and body across files; within a file the body alone pairs. Only JS and
// TS sources are read (the collectors that build full titles). Pairing is one to one: the n-th removed case of a
// template pairs with the n-th added one, so a table that lost a case still shows that case as removed. The skip, only
// and todo markers belong to the body, whitespace inside a string literal counts, and the caller offers only running
// tests as targets, so a rename never hides a skip or a changed expectation.
// Limits: titles built at run time, tests declared in loops, a regular-expression literal holding a quote, and
// template literals with nested braces are not read; such a test stays removed and needs the decision it needs today.
import { createHash } from 'node:crypto';
import { blankComments } from './scan.mjs';

const JS = { line: '//', block: true, quotes: '"\'`', keepStrings: true, triple: false };
export const JS_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const CALL = /(?<![\w$.])(x?(?:it|test|describe|suite)|f(?:it|describe))((?:\.(?:skip|only|todo|concurrent|serial|failing|fails|sequential|each|for))*)\s*\(/g;
const SUITE = /^(?:x?(?:describe|suite)|fdescribe)$/;
const TITLE = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/;
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// The end of the string literal opening at i (escapes skipped; a one-line string ends at its line end).
function skipString(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === q) return j;
    if (q !== '`' && text[j] === '\n') return j;
  }
  return text.length;
}

// The text without whitespace outside string literals: a space inside an expected string still counts.
function normalize(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { const e = skipString(text, i); out += text.slice(i, e + 1); i = e; continue; }
    if (!/\s/.test(c)) out += c;
  }
  return out;
}

// The index of the bracket closing the one at `open` (strings skipped), or -1.
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// [{ title (full, ancestors joined by ' > '), template (a parametrized title or ancestor), body (hash) }] of a JS/TS
// source; describe blocks are the ancestors of the tests inside their call.
export function jsTestBodies(text) {
  const src = blankComments(String(text), JS);
  const out = [];
  const frames = []; // { title, template, end }
  for (const m of src.matchAll(CALL)) {
    const start = m.index;
    let at = m.index + m[0].length - 1; // the '(' of the call
    const each = /\.(?:each|for)\b/.test(m[2]);
    let table = '';
    if (each) { // it.each(table)('title', fn): the table call comes first
      const close = closeOf(src, at);
      if (close < 0) continue;
      table = src.slice(at, close + 1);
      const next = src.indexOf('(', close + 1);
      if (next < 0 || src.slice(close + 1, next).trim() !== '') continue;
      at = next;
    }
    const close = closeOf(src, at);
    if (close < 0) continue;
    const args = src.slice(at + 1, close);
    const t = TITLE.exec(args);
    if (!t) continue;
    while (frames.length && frames[frames.length - 1].end < start) frames.pop();
    const title = [...frames.map((f) => f.title), t[2]].join(' > ');
    const template = each || frames.some((f) => f.template);
    if (SUITE.test(m[1])) { frames.push({ title: t[2], template, end: close }); continue; }
    // the skip, only and todo markers are part of the body: it.skip('new', fn) is no rename of it('old', fn)
    const mark = (m[1][0] === 'x' || m[1][0] === 'f' ? m[1][0] : '') + m[2].replace(/\.(?:each|for)\b/g, '');
    out.push({ title, template, body: hash(normalize(mark + table + args.slice(t[0].length))) });
  }
  return out;
}

// The regular expression a parametrized full title formats into: placeholders stand for any text.
export function templateRegex(title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(/%%/g, '%').replace(/%[sdifjoOp#]/g, '.+?').replace(/\\\$\w+(?:\\\.\w+)*/g, '.+?');
  return new RegExp(`^${re}$`, 's');
}

const parseId = (id) => {
  try {
    const v = JSON.parse(id);
    return Array.isArray(v) && v.length === 3 ? { id, file: String(v[0]), title: String(v[1]) } : null;
  } catch {
    return null;
  }
};
// The reporter's file of an ID against a repository path ('' when the reporter names none: any file).
const sameFile = (x, p) => x.file === '' || x.file === p || p.endsWith(`/${x.file}`) || x.file.endsWith(`/${p}`);
// The files the removed IDs name (the reporter's paths), to read next to the changed files.
export const idFiles = (ids) => [...new Set(ids.map(parseId).filter((x) => x && x.file !== '').map((x) => x.file))];

// [{ from, to }]: removed IDs paired with added IDs of the same body. files: the repository paths to read (the files the
// change touches); readAt(path) → the source at the anchor or null; readNow(path) → the working-tree source or null.
export function detectRenames({ removed, added, files, readAt, readNow }) {
  const rem = removed.map(parseId).filter(Boolean);
  const add = added.map(parseId).filter(Boolean);
  if (!rem.length || !add.length) return [];
  const before = new Map();
  const after = new Map();
  for (const p of [...new Set(files)].filter((f) => JS_SOURCE.test(f))) {
    const a = readAt(p);
    if (a !== null) before.set(p, jsTestBodies(a));
    const n = readNow(p);
    if (n !== null) after.set(p, jsTestBodies(n));
  }
  if (!before.size || !after.size) return [];
  const taken = new Set();
  const pairs = [];
  for (const r of rem) {
    let hit = null;
    for (const [p, bodies] of before) {
      if (!sameFile(r, p)) continue;
      const exact = bodies.filter((b) => !b.template && b.title === r.title).map((b) => b.body);
      const templated = bodies.filter((b) => b.template && templateRegex(b.title).test(r.title)).map((b) => b.body);
      for (const body of [...exact, ...templated]) {
        // the same body at HEAD: in the same file under any added title, in another changed file under the same title
        const order = [...after].sort((x, y) => (x[0] === p ? -1 : y[0] === p ? 1 : 0));
        for (const [q, now] of order) {
          for (const c of now.filter((b) => b.body === body)) {
            const matches = (x) => (c.template ? templateRegex(c.title).test(x.title) : x.title === c.title);
            const a = add.find((x) => !taken.has(x.id) && sameFile(x, q) && matches(x) && (q === p || x.title === r.title));
            if (a) { hit = a; break; }
          }
          if (hit) break;
        }
        if (hit) break;
      }
      if (hit) break;
    }
    if (hit) { taken.add(hit.id); pairs.push({ from: r.id, to: hit.id }); }
  }
  return pairs;
}
