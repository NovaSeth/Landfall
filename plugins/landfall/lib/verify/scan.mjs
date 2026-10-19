// Generic collector (spec §7.6 step 3, SD-16): a static scan of test files for test declarations and skip markers,
// used when a test gate's output is not a report a reporter collector reads (verify marks such a gate weak). Pure
// over file text; the files come from the collector context (repository files, plain files of at most 1 MB).
// Comments are blanked by a small lexer first (line and block comments anywhere on a line, strings kept), so a test
// commented out inline is a removed test (review r1 #6).
//   JS/TS   *.test.*, *.spec.*, files under test/, tests/ or __tests__/: it/test/describe/suite calls with a literal
//           title; skipped: an x-prefixed call (xit, xtest, xdescribe), .skip/.todo/.failing/.fails, a { skip | todo }
//           option, and a skip()/todo() call on any object (t, ctx, context, this, …) below it; focused: .only, fit,
//           fdescribe (other tests do not run)
//   Python  test_*.py, *_test.py: def test*/async def test* at module level or in classes, title `<Class>::<name>`;
//           skipped: @pytest.mark.skip/skipif/xfail or @unittest.skip/skipIf/skipUnless/expectedFailure on the def or
//           an enclosing class, pytestmark with one of those marks, pytest.skip()/pytest.xfail()/self.skipTest();
//           comments and string contents are blanked (code inside a docstring is not code)
//   Go      *_test.go: func TestX(t *testing.T); skipped: <t>.Skip/Skipf/SkipNow in its body
//   Rust    *.rs: a fn under #[test] or #[<path>::test]; skipped: #[ignore]
// Known limits: titles built at run time, tests generated in loops and declarations split over lines are not seen;
// a regular expression literal holding a quote can hide the rest of its line.
import { builder } from './inventory.mjs';

const JS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const JS_TEST = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$/;
const PY_TEST = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;
const GO_TEST = /_test\.go$/;
const RS_FILE = /\.rs$/;
export const SKIP_DIRS = /(?:^|\/)(?:node_modules|vendor|target)\//;

// JS: the call, its modifiers, an optional argument list (test.each(table)), then the literal title.
const JS_DECL = /(?<![\w$.])(x?(?:it|test|describe|suite)|f(?:it|describe))((?:\.(?:skip|only|todo|concurrent|serial|failing|fails|sequential|each|for))*)\s*(?:\((?:[^()'"`]|'[^']*'|"[^"]*"|\([^()]*\))*\)\s*)?\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
const JS_DECL_NAME = /^(?:x?(?:it|test|describe|suite)|f(?:it|describe))$/;
const JS_SKIP_MODIFIER = /\.(?:skip|todo|failing|fails)\b/;
const JS_SKIP_OPTION = /^\s*,\s*\{[^}]*\b(?:skip|todo)\s*:\s*(?!false\b)[^\s,}]/;
const JS_RUNTIME_SKIP = /(?<![\w$.])([A-Za-z_$][\w$]*)\.(?:skip|todo)\s*\(/g;

const PY_SKIP_DECORATOR = /^@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure))\b/;
const PY_SKIP_MARK = /\bpytest\.mark\.(?:skip|skipif|xfail)\b/;
const PY_RUNTIME_SKIP = /\b(?:pytest\.(?:skip|xfail)|self\.skipTest)\s*\(/;

const LEX = Object.freeze({
  js: { line: '//', block: true, quotes: '"\'`', keepStrings: true, triple: false },
  go: { line: '//', block: true, quotes: '"\'`', keepStrings: true, triple: false },
  rust: { line: '//', block: true, quotes: '"', keepStrings: true, triple: false }, // ' starts a lifetime, not a string
  python: { line: '#', block: false, quotes: '"\'', keepStrings: false, triple: true },
});

// `text` with comments (and, unless keepStrings, string contents) replaced by spaces; line breaks stay, so line
// numbers do not move. A one-line string ends at its line end even when unterminated.
export function blankComments(text, { line, block, quotes, keepStrings, triple }) {
  const n = text.length;
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  let out = '';
  let i = 0;
  while (i < n) {
    if (text.startsWith(line, i)) {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (block && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out += blank(text[i]);
      continue;
    }
    if (quotes.includes(text[i])) {
      const delim = triple && text.startsWith(text[i].repeat(3), i) ? text[i].repeat(3) : text[i];
      out += delim;
      i += delim.length;
      while (i < n && !text.startsWith(delim, i)) {
        if (text[i] === '\n' && delim.length === 1 && delim !== '`') break;
        const step = text[i] === '\\' && i + 1 < n ? 2 : 1;
        const part = text.slice(i, i + step);
        out += keepStrings ? part : [...part].map(blank).join('');
        i += step;
      }
      if (text.startsWith(delim, i)) { out += delim; i += delim.length; }
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

export function jsTests(text) {
  const tests = [];
  for (const line of blankComments(text, LEX.js).split('\n')) {
    for (const m of line.matchAll(JS_DECL)) {
      const rest = line.slice(m.index + m[0].length);
      tests.push({
        name: m[4],
        skipped: m[1].startsWith('x') || JS_SKIP_MODIFIER.test(m[2]) || JS_SKIP_OPTION.test(rest),
        focused: m[1].startsWith('f') || /\.only\b/.test(m[2]),
      });
    }
    for (const m of line.matchAll(JS_RUNTIME_SKIP)) if (!JS_DECL_NAME.test(m[1]) && tests.length) tests[tests.length - 1].skipped = true;
  }
  return tests;
}

// Python tests with their spans: start (first decorator line), line (def line), end (the line before the next test).
export function pythonTests(text) {
  const lines = blankComments(text, LEX.python).split('\n');
  const found = [];
  const stack = []; // { indent, kind: 'class' | 'def', name, skipped, test }
  let decorators = [];
  let decoratedAt = null;
  let moduleSkipped = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (t.startsWith('@')) {
      if (!decorators.length) decoratedAt = i + 1;
      decorators.push(t);
      continue;
    }
    const skipped = decorators.some((d) => PY_SKIP_DECORATOR.test(d));
    const start = decoratedAt ?? i + 1;
    decorators = [];
    decoratedAt = null;
    let m = /^class\s+(\w+)/.exec(t);
    if (m) {
      stack.push({ indent, kind: 'class', name: m[1], skipped });
      continue;
    }
    m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(t);
    if (m) {
      const test = m[1].startsWith('test') && !stack.some((s) => s.kind === 'def') ? { name: m[1], classes: stack.filter((s) => s.kind === 'class'), skipped, start, line: i + 1 } : null;
      if (test) found.push(test);
      stack.push({ indent, kind: 'def', test });
      continue;
    }
    if (/^pytestmark\s*=/.test(t) && PY_SKIP_MARK.test(t)) {
      if (!stack.length) moduleSkipped = true;
      else if (stack[stack.length - 1].kind === 'class') stack[stack.length - 1].skipped = true;
      continue;
    }
    if (PY_RUNTIME_SKIP.test(t)) {
      const def = [...stack].reverse().find((s) => s.kind === 'def');
      if (def?.test) def.test.skipped = true;
    }
  }
  return found.map((x, k) => ({
    name: [...x.classes.map((c) => c.name), x.name].join('::'),
    skipped: moduleSkipped || x.skipped || x.classes.some((c) => c.skipped),
    start: x.start,
    line: x.line,
    end: k + 1 < found.length ? found[k + 1].start - 1 : lines.length,
  }));
}

export function goTests(text) {
  const tests = [];
  let current = null;
  for (const line of blankComments(text, LEX.go).split('\n')) {
    if (/^func\b/.test(line)) {
      const m = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(line);
      current = m ? { name: m[1], skipped: false } : null;
      if (current) tests.push(current);
      continue;
    }
    if (current && /\b\w+\.Skip(?:f|Now)?\s*\(/.test(line)) current.skipped = true;
  }
  return tests;
}

export function rustTests(text) {
  const tests = [];
  let attributes = [];
  for (const line of blankComments(text, LEX.rust).split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const a = /^#\[(.*)\]$/.exec(t);
    if (a) {
      attributes.push(a[1].trim());
      continue;
    }
    const f = /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/.exec(t);
    if (f && attributes.some((x) => /^(?:\w+::)*test\b(?!_)/.test(x))) tests.push({ name: f[1], skipped: attributes.some((x) => /^ignore\b/.test(x)) });
    attributes = [];
  }
  return tests;
}

// The scanner of a repository-relative path, or null when the file is not a test source.
export function scannerOf(path) {
  if (SKIP_DIRS.test(path)) return null;
  if (JS_FILE.test(path) && JS_TEST.test(path)) return jsTests;
  if (PY_TEST.test(path)) return pythonTests;
  if (GO_TEST.test(path)) return goTests;
  if (RS_FILE.test(path)) return rustTests;
  return null;
}

// The inventory entries of one file: [{ id, file, skipped, focused? }].
export function scanSource(path, text) {
  const scan = scannerOf(path);
  if (!scan) return [];
  const inv = builder();
  for (const t of scan(String(text))) inv.add(path, t.name, { skipped: t.skipped, focused: t.focused });
  return inv.done('generic').tests;
}

// The generic inventory of the repository files in the collector context.
export function scanRepo(ctx) {
  const tests = [];
  for (const path of ctx.files()) {
    if (!scannerOf(path)) continue;
    const text = ctx.read(path);
    if (text !== null) tests.push(...scanSource(path, text));
  }
  return { collector: 'generic', tests, failing: [], failCount: null };
}
