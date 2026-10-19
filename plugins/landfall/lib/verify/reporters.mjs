// Reporter collectors (spec §7.6 step 3, SD-16): the test inventory read from the test gate's own output (stdout and
// stderr merged in order), so no second run is needed. Each parser returns null when the output is not its format;
// parseReport tries them in this order and the first that reads the output is the collector:
//   jest       Jest or Vitest JSON (--json, --reporter=json): testResults[]; file and `describe > test` titles
//   go         go test -json events; package and Test name
//   node-test  node:test TAP (a `TAP version` line) or spec-reporter lines (✔ ✖ ﹣ ▶ up to the `ℹ tests` summary);
//              title `suite > test` (the reporter names no file for a passing test)
//   cargo      cargo test result lines (`test x ... ok|FAILED|ignored`) or `-- --list` lines (`x: test`) with the
//              #[ignore] scan of the repository's .rs files; title = the test path
//   pytest     -v result lines (`path::id STATUS`), --collect-only -q lines (`path::id`) and -rA summary lines;
//              skipped from the statuses, the static decorator scan and -rs locations (`SKIPPED [n] path:line`)
// Output with none of these (a runner's human format) is no report: the generic scan collects instead.
// Skipped: skip, todo, pending, disabled, ignored, xfail (a test that cannot fail checks nothing).
// Failures (review r1 #5, #10): every failed result, including suites and parent tests (their own IDs), with the
// location and the whole message the reporter gives (TAP: error, expected, actual, operator); failCount: the
// reporter's own failure count (node-test, jest, cargo, pytest), so a failure no parser saw is never excused.
import { isAbsolute, relative, sep } from 'node:path';
import { forTerminal } from '../text/clean.mjs';
import { builder } from './inventory.mjs';
import { pythonTests, rustTests } from './scan.mjs';

// ---- node:test ----

const SPEC_RESULT = /^( *)([\u2714\u2716\uFE63]) (.*) \((\d+(?:\.\d+)?)ms\)(?: # (.*))?$/u;
const SPEC_OPEN = /^( *)\u25B6 (.*)$/u;
const SPEC_SUMMARY = /^\u2139 tests \d+\s*$/u;
const FAIL = '\u2716';
const SKIP = '\uFE63';

// The failing-tests list after the spec summary: "test at <location>", "✖ <name> (<n>ms)", then the error block.
function specFailures(lines, from) {
  const byName = new Map();
  let location = '';
  let current = null;
  const close = () => {
    if (!current) return;
    if (!byName.has(current.name)) byName.set(current.name, []);
    byName.get(current.name).push({ location: current.location, message: current.lines.join('\n') });
    current = null;
  };
  for (let i = from; i < lines.length; i++) {
    const at = /^test at (.+)$/.exec(lines[i]);
    if (at) { close(); location = at[1]; continue; }
    const head = /^\u2716 (.*) \(\d+(?:\.\d+)?ms\)/u.exec(lines[i]);
    if (head) { close(); current = { name: head[1], location, lines: [] }; location = ''; continue; }
    if (current) current.lines.push(lines[i]);
  }
  close();
  return byName;
}

function nodeSpec(text, ctx) {
  const lines = text.split('\n');
  const end = lines.findIndex((l) => SPEC_SUMMARY.test(l));
  if (end < 0) return null;
  const inv = builder(ctx.repo);
  const stack = [];
  const failed = [];
  for (const line of lines.slice(0, end)) {
    const open = SPEC_OPEN.exec(line);
    if (open) {
      const indent = open[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: open[2] });
      continue;
    }
    const m = SPEC_RESULT.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const top = stack[stack.length - 1];
    const todo = /^TODO\b/i.test(m[5] ?? '');
    if (top && top.indent === indent && top.name === m[3]) { // a suite or a test with subtests ends
      stack.pop();
      if (m[2] === FAIL && !todo) failed.push({ id: inv.container('', [...stack.map((s) => s.name), m[3]].join(' > ')), name: m[3] });
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const id = inv.add('', [...stack.map((s) => s.name), m[3]].join(' > '), { skipped: m[2] === SKIP || todo || /^SKIP\b/i.test(m[5] ?? '') });
    if (m[2] === FAIL && !todo) failed.push({ id, name: m[3] });
  }
  const count = lines.slice(end).map((l) => /^\u2139 fail (\d+)\s*$/u.exec(l)).find(Boolean);
  if (count) inv.count(Number(count[1]));
  const list = lines.findIndex((l, i) => i > end && /^\u2716 failing tests:/u.test(l));
  const details = list < 0 ? new Map() : specFailures(lines, list + 1);
  for (const f of failed) inv.fail(f.id, details.get(f.name)?.shift() ?? {});
  return inv.done('node-test');
}

// TAP: "# Subtest: <name>" opens a level (4 spaces each); "ok|not ok <n> - <desc> # SKIP|TODO" ends it. A level that
// had results under it is a suite or a parent test: not an inventory entry, but its failure is one.
const TAP_RESULT = /^( *)(not ok|ok)\b(?: \d+)?(?: -)?(?: (.*))?$/;
const TAP_SUBTEST = /^( *)# Subtest: (.*)$/;
const indentOf = (line) => line.length - line.trimStart().length;

function splitDirective(rest) {
  let desc = '';
  let i = 0;
  for (; i < rest.length; i++) {
    if (rest[i] === '\\' && i + 1 < rest.length) { desc += rest[++i]; continue; }
    if (rest[i] === '#') break;
    desc += rest[i];
  }
  return { desc: desc.trim(), directive: rest.slice(i + 1).trim() };
}

// { location, message } of a YAML diagnostic block starting at lines[start]: error (or message), expected, actual,
// operator, name and code; block scalars read whole.
function yamlFailure(lines, start) {
  if (start >= lines.length || lines[start].trim() !== '---') return {};
  const pad = indentOf(lines[start]);
  const fields = {};
  for (let i = start + 1; i < lines.length && lines[i].trim() !== '...'; i++) {
    const m = /^(\s*)([A-Za-z_]+):\s?(.*)$/.exec(lines[i]);
    if (!m || m[1].length !== pad) continue;
    let v = m[3].trim();
    if (/^[|>][-+]?$/.test(v)) {
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '...' && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > pad)) body.push(lines[++i]);
      v = body.join('\n');
    }
    fields[m[2]] = v.replace(/^'([\s\S]*)'$/, '$1');
  }
  const parts = ['error', 'message', 'expected', 'actual', 'operator', 'name', 'code'].filter((k) => fields[k] !== undefined);
  return { location: fields.location ?? '', message: parts.map((k) => (k === 'error' || k === 'message' ? fields[k] : `${k}: ${fields[k]}`)).join('\n') };
}

function tap(text, ctx) {
  if (!/^TAP version \d+\s*$/m.test(text)) return null;
  const lines = text.split('\n');
  const inv = builder(ctx.repo);
  const open = [];
  for (let i = 0; i < lines.length; i++) {
    const sub = TAP_SUBTEST.exec(lines[i]);
    if (sub) {
      const level = Math.floor(sub[1].length / 4);
      open.length = level;
      open[level] = { name: sub[2].trim(), children: false };
      if (level > 0 && open[level - 1]) open[level - 1].children = true;
      continue;
    }
    const m = TAP_RESULT.exec(lines[i]);
    if (!m) continue;
    const level = Math.floor(m[1].length / 4);
    const { desc, directive } = splitDirective(m[3] ?? '');
    const title = [...open.slice(0, level).filter(Boolean).map((n) => n.name), desc].join(' > ');
    const todo = /^TODO\b/i.test(directive);
    const failed = m[2] === 'not ok' && !todo;
    if (open[level]?.children) {
      open.length = level;
      if (failed) inv.fail(inv.container('', title), yamlFailure(lines, i + 1));
      continue;
    }
    if (level > 0 && open[level - 1]) open[level - 1].children = true;
    open.length = level;
    const id = inv.add('', title, { skipped: todo || /^SKIP\b/i.test(directive) });
    if (failed) inv.fail(id, yamlFailure(lines, i + 1));
  }
  const count = /^# fail (\d+)\s*$/m.exec(text);
  if (count) inv.count(Number(count[1]));
  return inv.done('node-test');
}

const nodeTest = (text, ctx) => tap(text, ctx) ?? nodeSpec(text, ctx);

// ---- Jest / Vitest ----

const JEST_SKIPPED = new Set(['pending', 'skipped', 'todo', 'disabled']);

// The first JSON object in the output that `accept`s: a whole line, or a pretty-printed block from a line "{" to the
// last line starting with "}".
function findJson(text, accept) {
  const parse = (s) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === 'object' && !Array.isArray(o) && accept(o) ? o : null;
    } catch {
      return null;
    }
  };
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('{"') && t.endsWith('}')) {
      const o = parse(t);
      if (o) return o;
    }
  }
  const starts = lines.flatMap((l, i) => (l.trim() === '{' ? [i] : [])).slice(0, 20);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].startsWith('}')) last--;
  for (const i of starts) {
    if (i >= last) break;
    const o = parse(lines.slice(i, last + 1).join('\n'));
    if (o) return o;
  }
  return null;
}

const relativeTo = (repo, file) => {
  if (!repo || !isAbsolute(file)) return file;
  const rel = relative(repo, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : file;
};

function jest(text, ctx) {
  const doc = findJson(text, (o) => Array.isArray(o.testResults));
  if (!doc) return null;
  const inv = builder(ctx.repo);
  for (const file of doc.testResults) {
    if (!file || typeof file !== 'object') continue;
    const rel = relativeTo(ctx.repo, String(file.name ?? file.testFilePath ?? ''));
    let failedHere = 0;
    for (const a of Array.isArray(file.assertionResults) ? file.assertionResults : []) {
      if (!a || typeof a !== 'object') continue;
      const titles = [...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles : []), a.title].map(String);
      const id = inv.add(rel, titles.join(' > '), { skipped: JEST_SKIPPED.has(a.status) });
      if (a.status !== 'failed') continue;
      failedHere++;
      inv.fail(id, { message: Array.isArray(a.failureMessages) ? a.failureMessages.map(String).join('\n') : '' });
    }
    // A file that failed outside its tests (a hook, a load error): a failure of its own.
    const own = file.testExecError?.message ?? (file.status === 'failed' && failedHere === 0 ? file.message ?? file.failureMessage : null);
    if (own) inv.fail(inv.container(rel, '(file)'), { message: String(own) });
  }
  if (Number.isInteger(doc.numFailedTests)) inv.count(doc.numFailedTests + (Number.isInteger(doc.numRuntimeErrorTestSuites) ? doc.numRuntimeErrorTestSuites : 0));
  return inv.done('jest');
}

// ---- go test -json ----

const GO_NOISE = /^\s*(?:=== (?:RUN|PAUSE|CONT|NAME)|--- (?:PASS|FAIL|SKIP):)/;

function go(text, ctx) {
  const tests = new Map();
  const packages = new Map();
  let events = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.Action !== 'string' || typeof e.Package !== 'string') continue;
    events++;
    const single = typeof e.Test === 'string' && e.Test !== '';
    const map = single ? tests : packages;
    const key = single ? JSON.stringify([e.Package, e.Test]) : e.Package;
    if (!map.has(key)) map.set(key, { pkg: e.Package, test: e.Test, action: null, output: [] });
    const t = map.get(key);
    if (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip') t.action = e.Action;
    else if (e.Action === 'output' && typeof e.Output === 'string') t.output.push(e.Output);
  }
  if (events === 0) return null;
  const inv = builder(ctx.repo);
  const message = (out) => out.join('').split('\n').filter((l) => !GO_NOISE.test(l)).join('\n');
  const failedPackages = new Set();
  for (const t of tests.values()) {
    const id = inv.add(t.pkg, t.test, { skipped: t.action === 'skip' });
    if (t.action === 'fail') { failedPackages.add(t.pkg); inv.fail(id, { message: message(t.output) }); }
  }
  // A package that failed without a failing test (build error, TestMain): a failure of its own.
  for (const p of packages.values()) if (p.action === 'fail' && !failedPackages.has(p.pkg)) inv.fail(inv.container(p.pkg, '(package)'), { message: message(p.output) });
  return inv.done('go');
}

// ---- cargo test ----

const CARGO_RESULT = /^test (.+?) \.\.\. (ok|FAILED|ignored(?:, .*)?)$/;
const CARGO_LIST = /^(.+): (test|bench)$/;

// Names of the functions marked #[ignore] in the repository's Rust files.
function ignoredFunctions(ctx) {
  const names = new Set();
  for (const path of ctx.files()) {
    if (!path.endsWith('.rs')) continue;
    const text = ctx.read(path);
    if (text !== null) for (const t of rustTests(text)) if (t.skipped) names.add(t.name);
  }
  return names;
}

// The panic output of each failed test: the lines after "---- <name> stdout ----" up to the next section.
function cargoPanics(lines) {
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^---- (.+) stdout ----$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !/^----.*----$/.test(lines[j]) && lines[j] !== 'failures:'; j++) {
      if (!/^note: run with/.test(lines[j])) body.push(lines[j]);
    }
    out.set(m[1], body.join('\n'));
  }
  return out;
}

function cargo(text, ctx) {
  const results = /^running \d+ tests?$/m.test(text);
  const listed = /^\d+ tests?, \d+ benchmarks?$/m.test(text);
  if (!results && !listed) return null;
  const lines = text.split('\n');
  const inv = builder(ctx.repo);
  const failed = [];
  let ignored = null;
  for (const line of lines) {
    const r = CARGO_RESULT.exec(line);
    if (r) {
      const id = inv.add('', r[1], { skipped: r[2].startsWith('ignored') });
      if (r[2] === 'FAILED') failed.push({ id, name: r[1] });
      continue;
    }
    const l = listed ? CARGO_LIST.exec(line) : null;
    if (l && l[2] === 'test') {
      ignored ??= ignoredFunctions(ctx);
      inv.add('', l[1], { skipped: ignored.has(l[1].split('::').pop()) });
    }
  }
  const panics = cargoPanics(lines);
  for (const f of failed) inv.fail(f.id, { message: panics.get(f.name) ?? '' });
  const counts = [...text.matchAll(/^test result: \w+\. \d+ passed; (\d+) failed/gm)];
  if (counts.length) inv.count(counts.reduce((n, m) => n + Number(m[1]), 0));
  return inv.done('cargo');
}

// ---- pytest ----

const PY_VERBOSE = /^(\S+?\.py)::(.+?) (PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)(?:\s|$)/;
const PY_SUMMARY = /^(PASSED|FAILED|XFAIL|XPASS|ERROR) (\S+?\.py)::(\S.*?)(?: - (.*))?$/;
const PY_COLLECTED = /^(\S+?\.py)::(\S.*)$/;
const PY_SKIPPED_AT = /^SKIPPED \[\d+\] (\S+?\.py):(\d+):/;
const PY_TOTALS = /^=*\s*(\d+ [a-z]+(?:, \d+ [a-z]+)* in [\d.]+s)\b/;

function pytest(text, ctx) {
  const tests = new Map(); // JSON [file, name] → { file, name, skipped, failed, message }
  const skipsAt = [];
  let listed = false;
  let failCount = null;
  const see = (file, name) => {
    const key = JSON.stringify([file, name]);
    if (!tests.has(key)) tests.set(key, { file, name, skipped: false, failed: false, message: '' });
    return tests.get(key);
  };
  const status = (t, s) => {
    if (s === 'SKIPPED' || s === 'XFAIL') t.skipped = true;
    if (s === 'FAILED' || s === 'ERROR') t.failed = true;
  };
  for (const line of text.split('\n')) {
    let m = PY_VERBOSE.exec(line);
    if (m) { listed = true; status(see(m[1], m[2]), m[3]); continue; }
    m = PY_SUMMARY.exec(line);
    if (m) {
      if (m[1] === 'PASSED') listed = true;
      const t = see(m[2], m[3]);
      status(t, m[1]);
      if (m[4] && !t.message) t.message = m[4];
      continue;
    }
    m = PY_SKIPPED_AT.exec(line);
    if (m) { skipsAt.push({ file: m[1], line: Number(m[2]) }); continue; }
    m = PY_COLLECTED.exec(line);
    if (m) { listed = true; see(m[1], m[2]); continue; }
    m = PY_TOTALS.exec(line);
    if (m) {
      const n = (re) => Number(re.exec(m[1])?.[1] ?? 0);
      failCount = n(/(\d+) failed/) + n(/(\d+) errors?/);
    }
  }
  if (!listed) return null; // only a failure summary: no inventory
  // Static skips: the decorator scan of each test's file, and -rs locations inside a test's span.
  const statics = new Map();
  const staticOf = (file) => {
    if (!statics.has(file)) {
      const src = ctx.read(file);
      statics.set(file, src === null ? [] : pythonTests(src));
    }
    return statics.get(file);
  };
  const skippedBase = new Set();
  for (const { file } of tests.values()) for (const s of staticOf(file)) if (s.skipped) skippedBase.add(JSON.stringify([file, s.name]));
  for (const at of skipsAt) {
    const hit = staticOf(at.file).find((s) => at.line >= s.start && at.line <= s.end);
    if (hit) skippedBase.add(JSON.stringify([at.file, hit.name]));
  }
  const inv = builder(ctx.repo);
  for (const t of tests.values()) {
    const id = inv.add(t.file, t.name, { skipped: t.skipped || skippedBase.has(JSON.stringify([t.file, t.name.replace(/\[.*\]$/, '')])) });
    if (t.failed) inv.fail(id, { message: t.message });
  }
  if (failCount !== null) inv.count(failCount);
  return inv.done('pytest');
}

// ---- detection ----

export const REPORTERS = Object.freeze(['jest', 'go', 'node-test', 'cargo', 'pytest']);
const PARSERS = Object.freeze({ jest, go, 'node-test': nodeTest, cargo, pytest });

// The inventory of a test gate's output, or null when no reporter collector reads it. ctx: { repo, files(), read(path) }.
export function parseReport(output, ctx) {
  const text = forTerminal(output);
  for (const name of REPORTERS) {
    const inv = PARSERS[name](text, ctx);
    if (inv) return inv;
  }
  return null;
}
