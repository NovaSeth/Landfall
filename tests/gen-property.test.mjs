// Generated files, lossless regeneration (spec §7.14, §7.14a, SC9, REV-57, GC9).
// Part 1, the merge core: the line diff is checked against an independent dynamic-programming LCS (patch round
// trip and minimal edit count), the 3-way merge goes through `git merge-file`, and the hunk-survival check accepts
// every merge that keeps the user's hunks and rejects every merge that drops, reverts or splits one.
// Part 2, SC9: seeded random sequences install → user edit → new version → update → update, shrunk on failure.
// Tier A uses unique lines, so a correct result has exactly one alignment and an alignment-free oracle (not the
// implementation's diff) checks it: user lines kept, user deletions honoured, order and contiguity kept, template
// changes applied. Tier B uses the real templates (repeated lines, CRLF, whitespace) and checks line multisets.
// In both, a conflict leaves the user's file byte-identical with the new version in the side file, and the second
// update writes nothing (bytes, inodes and mtimes of every file and directory, the state directory included).
// Part 3, lifecycle (ported from the 1.x GC1 lifecycle test): files on target paths before the first run, a lost
// manifest, side files the user edits or removes, crash windows, links, newer state, dry run.
// Part 4, the commands; Part 5, the reproductions of review round 1 (findings-r1), one deterministic test each.
// This file never spells the codename: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// git (through lib/git) runs with a throwaway HOME and global config, without the calling session.
isolateProcessEnv();
// The same git, found in its own exec path first: on macOS /usr/bin/git is an xcrun shim that adds ~20 ms to each
// of the ~1,000 merges below; elsewhere this is the binary PATH already finds.
{
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', env: process.env }).stdout.trim();
  if (execPath && existsSync(join(execPath, 'git'))) process.env.PATH = `${execPath}${delimiter}${process.env.PATH}`;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function locate() {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return { pluginDir: join(plugins, hits[0]), names: JSON.parse(readFileSync(join(plugins, hits[0], 'lib', 'name.json'), 'utf8')) };
}
const { pluginDir, names } = locate();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);

// Seeded PRNG (mulberry32): every random case is reproducible from its seed.
function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)] };
}

// Independent reference: LCS length by dynamic programming.
function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

function applyHunks(a, b, hunks) {
  const out = [];
  let i = 0;
  for (const h of hunks) {
    out.push(...a.slice(i, h.aStart), ...b.slice(h.bStart, h.bEnd));
    i = h.aEnd;
  }
  return [...out, ...a.slice(i)];
}

test('splitLines keeps every terminator: joining the lines gives the text back (CRLF and a missing final newline too)', async () => {
  const { splitLines } = await lib('gen/diff.mjs');
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\n'), ['a\n']);
  assert.deepEqual(splitLines('a\r\nb\n\nc'), ['a\r\n', 'b\n', '\n', 'c']);
  for (const text of ['x\n\n\ny', '\n', '\r\n\r\n', 'only']) assert.equal(splitLines(text).join(''), text);
});

test('diffLines: hunks turn a into b, and their edit count is minimal (checked against a DP LCS on 3000 random pairs)', async () => {
  const { diffLines } = await lib('gen/diff.mjs');
  const r = rng(0x5eed1);
  for (let n = 0; n < 3000; n++) {
    const alphabet = ['a', 'b', 'c', 'd', '', ' a'].slice(0, 2 + r.int(5));
    const a = Array.from({ length: r.int(14) }, () => r.pick(alphabet));
    const b = Array.from({ length: r.int(14) }, () => r.pick(alphabet));
    const hunks = diffLines(a, b);
    assert.deepEqual(applyHunks(a, b, hunks), b, `patch round trip: ${JSON.stringify({ a, b, hunks })}`);
    const edits = hunks.reduce((s, h) => s + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0);
    assert.equal(edits, a.length + b.length - 2 * lcsLength(a, b), `minimal: ${JSON.stringify({ a, b })}`);
    for (let k = 1; k < hunks.length; k++) assert.ok(hunks[k].aStart > hunks[k - 1].aEnd, 'hunks are separated by at least one equal line');
  }
  assert.deepEqual(diffLines(['x'], ['x']), []);
  assert.deepEqual(diffLines([], ['x', 'y']), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
  assert.equal(diffLines(Array.from({ length: 50 }, (_, i) => `a${i}`), Array.from({ length: 50 }, (_, i) => `b${i}`), { maxEdits: 10 }), null, 'over the edit budget → null (caller treats it as not verified)');
});

test('survives: every user hunk of diff(base, ours) must be in the result, in order', async () => {
  const { survives } = await lib('gen/diff.mjs');
  const base = 'a\nb\nc\nd\ne\n';
  const ours = 'a\nUSER\nb\nc\ne\n'; // inserted USER after a, deleted d
  assert.equal(survives(base, ours, 'a\nUSER\nb\nc\ne\nTHEIRS\n').ok, true, 'both user hunks kept, theirs appended');
  assert.equal(survives(base, ours, 'T0\na\nUSER\nb\nc\ne\n').ok, true, 'theirs prepended');
  assert.equal(survives(base, ours, 'a\nb\nc\ne\n').ok, false, 'user insertion dropped');
  assert.equal(survives(base, ours, 'a\nUSER\nb\nc\nd\ne\n').ok, false, 'user deletion undone');
  assert.equal(survives(base, 'a\nb\nd\ne\n', 'a\nb\nc\nd\ne\nTHEIRS\n').ok, false, 'user deletion undone while a later theirs hunk exists');
  assert.equal(survives(base, ours, 'a\nUS\nb\nc\ne\n').ok, false, 'user line changed');
  assert.equal(survives(base, 'a\nU1\nU2\nb\nc\nd\ne\n', 'a\nU1\nX\nU2\nb\nc\nd\ne\n').ok, false, 'a user hunk split by foreign lines');
  assert.equal(survives(base, 'a\nU1\nb\nc\nd\nU2\ne\n', 'a\nU2\nb\nc\nd\nU1\ne\n').ok, false, 'user hunks out of order');
  assert.equal(survives(base, base, 'anything\n').ok, true, 'no user hunks: nothing to keep');
  assert.equal(survives(base, 'a\nb\nc\nd\ne', 'a\nb\nc\nd\ne\n').ok, false, 'a removed final newline is a user hunk too');
  assert.equal(survives(base, 'a\r\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\n').ok, false, 'a CRLF line is a user hunk');
  const lost = survives(base, ours, 'a\nb\nc\ne\n');
  assert.deepEqual(lost.hunk, { aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }, 'the first lost hunk is reported');
});

test('merge3: git merge-file merges disjoint edits, reports overlapping ones as conflicts and never spawns for trivial cases', async () => {
  const { merge3 } = await lib('gen/merge.mjs');
  const base = 'one\ntwo\nthree\nfour\nfive\nsix\n';
  const ours = 'one\nUSER\ntwo\nthree\nfour\nfive\nsix\n';
  const theirs = 'one\ntwo\nthree\nfour\nfive\nsix\nTHEIRS\n';
  assert.deepEqual(merge3({ ours, base, theirs }), { status: 'clean', text: 'one\nUSER\ntwo\nthree\nfour\nfive\nsix\nTHEIRS\n' });
  assert.equal(merge3({ ours: 'one\nUSER\nthree\nfour\nfive\nsix\n', base, theirs: 'one\nTHEIRS\nthree\nfour\nfive\nsix\n' }).status, 'conflict');
  assert.deepEqual(merge3({ ours: theirs, base, theirs }), { status: 'clean', text: theirs }, 'identical change');
  // Trivial cases are decided without git (an empty PATH would make a spawn fail).
  const env = { PATH: '' };
  assert.deepEqual(merge3({ ours: base, base, theirs, env }), { status: 'clean', text: theirs });
  assert.deepEqual(merge3({ ours, base, theirs: base, env }), { status: 'clean', text: ours });
  assert.equal(merge3({ ours, base, theirs, env }).status, 'error', 'git missing → error, never a guess');
  // Content git cannot merge as text is an error, not a clean merge.
  assert.equal(merge3({ ours: 'one\0\ntwo\n', base, theirs }).status, 'error');
  // A final line without a newline is kept as the user left it.
  assert.deepEqual(merge3({ ours: 'one\ntwo\nthree\nfour\nfive\nsix', base, theirs: 'ZERO\none\ntwo\nthree\nfour\nfive\nsix\n' }), { status: 'clean', text: 'ZERO\none\ntwo\nthree\nfour\nfive\nsix' });
});

test('mergeChecked: a clean merge is accepted only when every user hunk survives', async () => {
  const { mergeChecked } = await lib('gen/merge.mjs');
  const base = 'a\nb\nc\nd\ne\nf\ng\n';
  const clean = mergeChecked({ ours: 'a\nUSER\nb\nc\nd\ne\nf\ng\n', base, theirs: 'a\nb\nc\nd\ne\nf\ng\nTHEIRS\n' });
  assert.deepEqual(clean, { status: 'clean', text: 'a\nUSER\nb\nc\nd\ne\nf\ng\nTHEIRS\n' });
  // A merge function that drops the user's hunk is caught by the survival check (the check, not git, decides).
  const dropping = () => ({ status: 'clean', text: 'a\nb\nc\nd\ne\nf\ng\nTHEIRS\n' });
  assert.equal(mergeChecked({ ours: 'a\nUSER\nb\nc\nd\ne\nf\ng\n', base, theirs: 'a\nb\nc\nd\ne\nf\ng\nTHEIRS\n', merge: dropping }).status, 'lost-hunk');
  assert.equal(mergeChecked({ ours: 'a\nX\nc\nd\ne\nf\ng\n', base, theirs: 'a\nY\nc\nd\ne\nf\ng\n' }).status, 'conflict');
});

// ---------------------------------------------------------------------------------------------------------------
// Part 2: SC9 property — install → user edit → new version → update → update.

const gen = await import(pathToFileURL(join(pluginDir, 'lib', 'gen', 'index.mjs')).href);
const VERSION = '2.0.0';
const SIDE = gen.sideSuffix(names);
const FILE_T = { id: 'prop-file', template: 'test/file', mode: 'file', fileMode: 0o644 };
const BLOCK_T = { id: 'prop-block', template: 'test/block', mode: 'block', comment: '#', fileMode: 0o644 };
const PATHS = { 'prop-file': 'gen/file.txt', 'prop-block': 'gen/OWNERS' };
const MARK = { begin: `# ${names.codename}:begin\n`, end: `# ${names.codename}:end\n` };
// The marker lines of a real block target (CODEOWNERS: "#" comments, AGENTS.md: HTML comments).
const marksOf = (target) => {
  const { begin, end } = gen.blockMarkers(target, names);
  return { begin: `${begin}\n`, end: `${end}\n` };
};
const markOf = (c) => (c.tier === 'B' ? marksOf(c.target) : MARK);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const lines = (s) => (s === '' ? [] : s.match(/[^\n]*\n|[^\n]+$/g));
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 15, 0, 0, 0, tick++)).toISOString();

function workspace(parent) {
  const root = mkdtempSync(join(parent, 'ws-'));
  const store = gen.openStore(join(root, names.stateDir), names);
  store.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: now() });
  return { root, store };
}
const applyIn = (ws, items, extra = {}) => gen.applyGen({ root: ws.root, store: ws.store, names, version: VERSION, items, now, ...extra });
const manifestEntry = (ws, path) => gen.readManifest(ws.store).files[path];

// Every file and directory under dir: bytes, inode, mtime, mode. A write of any kind changes it.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      const st = lstatSync(p, { bigint: true });
      const key = relative(dir, p);
      out[key] = `${st.ino}:${st.mtimeNs}:${st.mode}:${st.size}`;
      if (st.isDirectory()) walk(p);
      else out[key] += `:${readFileSync(p).toString('base64')}`;
    }
  };
  walk(dir);
  return out;
}

// Line edits. Positions are fractions, so an edit stays applicable when the shrinker removes others.
function applyOps(input, ops) {
  const out = [...input];
  for (const o of ops) {
    const at = Math.min(out.length, Math.floor(o.at * (out.length + 1)));
    const idx = Math.min(out.length - 1, Math.floor(o.at * out.length));
    if (o.kind === 'insert') out.splice(at, 0, ...o.lines);
    else if (out.length === 0) continue;
    else if (o.kind === 'delete') { if (out.length > 1) out.splice(idx, 1); }
    else if (o.kind === 'replace') out[idx] = o.lines[0];
    else if (o.kind === 'crlf') { if (/[^\r]\n$|^\n$/.test(out[idx])) out[idx] = `${out[idx].slice(0, -1)}\r\n`; }
    else if (o.kind === 'space') out[idx] = out[idx].replace(/(\r?\n)?$/, (m) => ` ${m}`);
    else if (o.kind === 'dup') out.splice(idx, 0, out[idx].endsWith('\n') ? out[idx] : `${out[idx]}\n`);
    else if (o.kind === 'eof') { const last = out.length - 1; out[last] = out[last].replace(/\r?\n$/, ''); }
    else if (o.kind === 'move') { const [l] = out.splice(idx, 1); out.splice(Math.min(out.length, Math.floor(o.to * (out.length + 1))), 0, l); }
  }
  return out;
}

const WORDS = ['run: npm test', 'name: step', '  - item', '# note', 'key: "value"', '', '    indented', '*  @org/team'];
function makeOps(r, tag, count, kinds) {
  let n = 0;
  const fresh = () => `${tag}${n++} ${r.pick(WORDS)}\n`;
  return Array.from({ length: count }, () => {
    const kind = r.pick(kinds);
    const o = { kind, at: r.next() };
    if (kind === 'move') o.to = r.next();
    if (kind === 'insert') o.lines = Array.from({ length: 1 + r.int(3) }, fresh);
    if (kind === 'replace') o.lines = [fresh()];
    return o;
  });
}

// Tier A case: unique lines everywhere (every line carries a unique token).
function caseA(seed, dry = false) {
  const r = rng(seed);
  const tag = (t) => `${t}${seed.toString(36)}.`;
  const block = r.next() < 0.3;
  let n = 0;
  const v1 = Array.from({ length: 2 + r.int(20) }, () => `${tag('b')}${n++} ${r.pick(WORDS)}\n`);
  const userKinds = block ? ['insert', 'delete', 'replace', 'crlf', 'space', 'move'] : ['insert', 'delete', 'replace', 'crlf', 'space', 'eof', 'move'];
  return {
    seed, tier: 'A', block, v1,
    userOps: makeOps(r, tag('u'), 1 + r.int(4), userKinds),
    templateOps: makeOps(r, tag('t'), 1 + r.int(4), ['insert', 'delete', 'replace', 'move']),
    before: block ? Array.from({ length: r.int(3) }, (_, i) => `${tag('ob')}${i} user line\n`) : [],
    after: block ? Array.from({ length: r.int(3) }, (_, i) => `${tag('oa')}${i} user line\n`) : [],
    dropFinalNewline: block && r.next() < 0.2,
    dry,
    resolve: seed % 3 === 0,
  };
}

// Tier B case: the real templates (repeated lines), new version from other options and edits, duplicates.
function caseB(seed, dry = false) {
  const r = rng(seed);
  const tag = (t) => `${t}${seed.toString(36)}.`;
  const target = r.pick(gen.TARGETS);
  const gateSets = [[], [{ name: 'test', cmd: 'npm test' }], [{ name: 'lint', cmd: 'npm run lint' }, { name: 'test', cmd: 'npm test' }]];
  const opts = () => ({ gates: r.pick(gateSets), owners: r.pick([[], ['@org/team'], ['@a', '@b']]), branch: r.pick(['main', 'trunk']) });
  return {
    seed, tier: 'B', block: target.mode === 'block', target, o1: opts(), o2: opts(),
    userOps: makeOps(r, tag('u'), 1 + r.int(4), ['insert', 'delete', 'replace', 'crlf', 'space', 'dup']),
    templateOps: makeOps(r, tag('t'), r.int(3), ['insert', 'delete', 'replace', 'dup']),
    before: target.mode === 'block' ? Array.from({ length: r.int(3) }, (_, i) => `/docs/${i}/  @user${i}\n`) : [],
    after: target.mode === 'block' ? ['/src/  @dev\n'] : [],
    dropFinalNewline: false, dry, resolve: seed % 3 === 0,
  };
}

function texts(c) {
  const v1 = c.tier === 'A' ? c.v1.join('') : gen.render(c.target, c.o1, names);
  const v2 = c.tier === 'A' ? applyOps(c.v1, c.templateOps).join('') : applyOps(lines(gen.render(c.target, c.o2, names)), c.templateOps).join('');
  const userUnit = applyOps(lines(v1), c.userOps).join('');
  const mark = markOf(c);
  const wrap = (unit) => `${c.before.join('')}${mark.begin}${unit}${mark.end}${c.after.join('')}`;
  let userFile = c.block ? wrap(userUnit) : userUnit;
  if (c.dropFinalNewline && userFile.endsWith('\n')) userFile = userFile.slice(0, -1);
  return { v1, v2, userUnit, userFile, proposal: c.block ? (c.dropFinalNewline ? wrap(v2).slice(0, -1) : wrap(v2)) : v2 };
}

// The managed unit of a file (the whole text, or the text between the marker lines) and what lies outside it.
function unitOf(c, text) {
  if (!c.block) return { unit: text, outside: '' };
  const mark = markOf(c);
  const b = text.indexOf(mark.begin);
  const e = text.indexOf(mark.end.slice(0, -1), b); // the end marker may be the last line, without a newline
  assert.ok(b >= 0 && e > b, 'markers kept');
  return { unit: text.slice(b + mark.begin.length, e), outside: text.slice(0, b + mark.begin.length) + text.slice(e) };
}

// Lines of b (unique lines) that a moved relative to the others: the common lines outside one longest common
// subsequence (dynamic programming).
function moved(a, b) {
  const inA = new Set(a);
  const B = b.filter((l) => inA.has(l));
  const A = a.filter((l) => B.includes(l));
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    if (A[i] === B[j]) { keep.add(A[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return new Set(B.filter((l) => !keep.has(l)));
}

// Tier A oracle (unique lines): user lines kept, user deletions honoured, the user's order (moves included) and
// contiguous runs kept except for lines the template moved, template changes applied, no line duplicated.
function oracleA(base, ours, theirs, result) {
  const B = lines(base); const O = lines(ours); const T = lines(theirs); const R = lines(result);
  const has = (xs) => new Set(xs);
  const [inB, inO, inT, inR] = [has(B), has(O), has(T), has(R)];
  assert.equal(inR.size, R.length, 'no line duplicated');
  for (const l of O) if (!inB.has(l)) assert.ok(inR.has(l), `user line lost: ${JSON.stringify(l)}`);
  for (const l of B) if (!inO.has(l)) assert.ok(!inR.has(l), `user deletion undone: ${JSON.stringify(l)}`);
  const byTemplate = moved(B, T);
  const ordered = (xs, inOther) => xs.filter((l) => inOther.has(l) && !byTemplate.has(l));
  assert.deepEqual(ordered(R, inO), ordered(O, inR), 'user order kept');
  let run = [];
  const flush = () => {
    if (run.length > 1) { const at = R.indexOf(run[0]); assert.deepEqual(R.slice(at, at + run.length), run, 'user run contiguous'); }
    run = [];
  };
  for (const l of O) { if (inB.has(l)) flush(); else run.push(l); }
  flush();
  for (const l of T) if (!inB.has(l)) assert.ok(inR.has(l), `template line not applied: ${JSON.stringify(l)}`);
  for (const l of B) if (!inT.has(l) && inO.has(l)) assert.ok(!inR.has(l), `template deletion not applied: ${JSON.stringify(l)}`);
}

// Tier B oracle (repeated lines): line counts. User additions are present; user deletions stay deleted except for
// copies the new version adds.
function oracleB(base, ours, theirs, result) {
  const count = (s) => lines(s).reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const [B, O, T, R] = [count(base), count(ours), count(theirs), count(result)];
  for (const l of new Set([...B.keys(), ...O.keys(), ...T.keys(), ...R.keys()])) {
    const [b, o, t, r] = [B.get(l) ?? 0, O.get(l) ?? 0, T.get(l) ?? 0, R.get(l) ?? 0];
    assert.ok(r >= o - b, `user copies of ${JSON.stringify(l)} lost: ${r} < ${o} - ${b}`);
    assert.ok(r <= o + Math.max(0, t - b), `user deletion of ${JSON.stringify(l)} undone: ${r} > ${o} + new copies`);
  }
}

// Sequences run in batches: one workspace, one path per sequence, one apply per phase for the whole batch (the
// generator handles many targets per run; locks and record writes are shared, every check stays per sequence).
// runBatch returns per-seed failure messages and the actions reached; a failing sequence is replayed alone and
// shrunk (the shrinker needs values, not throws).
function prepare(c) {
  const target = c.tier === 'A' ? (c.block ? BLOCK_T : FILE_T) : c.target;
  const path = c.tier === 'A' ? `cases/${c.seed}/${PATHS[target.id]}` : `cases/${c.seed}/${target.path(names)}`;
  return { c, target, path, ...texts(c) };
}

function runBatch(cases, parent) {
  const failures = new Map();
  const actions = [];
  const P = cases.map(prepare);
  const fail = (p, err) => { if (!failures.has(p.c.seed)) failures.set(p.c.seed, err?.message ?? String(err)); };
  const each = (fn) => P.forEach((p, i) => { if (failures.has(p.c.seed)) return; try { fn(p, i); } catch (err) { fail(p, err); } });
  const all = (fn) => { try { fn(); } catch (err) { P.forEach((p) => fail(p, err)); } };
  const items = (key) => P.map((p) => ({ target: p.target, path: p.path, theirs: p[key] }));
  try {
    const ws = workspace(parent);
    const file = (p) => join(ws.root, p.path);
    const side = (p) => `${file(p)}${SIDE}`;
    let r = applyIn(ws, items('v1'));
    each((p, i) => assert.equal(r.results[i].action, 'create', 'install creates the file'));
    each((p) => writeFileSync(file(p), p.userFile)); // the user's edit

    let predicted = null;
    if (cases[0].dry) {
      const before = snapshot(ws.root);
      const d = applyIn(ws, items('v2'), { dryRun: true });
      all(() => assert.deepEqual(snapshot(ws.root), before, 'dry run writes nothing'));
      predicted = d.results;
    }
    r = applyIn(ws, items('v2'));
    each((p, i) => {
      const res = r.results[i];
      actions.push(`${p.c.block ? 'block' : 'file'}:${res.action}`);
      if (predicted) assert.deepEqual([res.action, res.written, res.removed], [predicted[i].action, predicted[i].written, predicted[i].removed], 'dry run predicts the update');
      const now1 = readFileSync(file(p), 'utf8');
      const entry = manifestEntry(ws, p.path);
      if (res.action === 'conflict' || res.action === 'lost-hunk') {
        assert.equal(now1, p.userFile, `${res.action}: the user's file is untouched`);
        assert.equal(readFileSync(side(p), 'utf8'), p.proposal, 'the side file holds the new version');
        assert.equal(entry.side.fileSha256, sha(p.proposal), 'the side file hash is recorded');
        assert.equal(entry.base.join('\n'), p.v1, 'base stays the installed version');
        assert.equal(res.ok, false);
      } else {
        assert.ok(['merge', 'update', 'unchanged'].includes(res.action), `unexpected action ${res.action}`);
        const was = unitOf(p.c, p.userFile);
        const got = unitOf(p.c, now1);
        assert.equal(got.outside, was.outside, 'every byte outside the block is the user\'s');
        (p.c.tier === 'A' ? oracleA : oracleB)(p.v1, p.userUnit, p.v2, got.unit);
        assert.equal(entry.base.join('\n'), res.action === 'unchanged' ? p.v1 : p.v2, 'the base moves only with the file');
        assert.equal(entry.side, null);
        assert.ok(!existsSync(side(p)), 'no side file');
      }
    });

    // Second update: nothing written, not even the lock.
    const settled = snapshot(ws.root);
    const again = applyIn(ws, items('v2'));
    each((p, i) => assert.deepEqual([again.results[i].written, again.results[i].removed], [[], []], 'second update reports no write'));
    all(() => assert.deepEqual([again.manifest, snapshot(ws.root)], [false, settled], 'second update writes 0 files'));

    // The user merges by hand and deletes the side file: the proposal becomes the base, the file stays theirs.
    const resolving = P.filter((p) => p.c.resolve && !failures.has(p.c.seed) && existsSync(side(p)));
    if (resolving.length) {
      for (const p of resolving) unlinkSync(side(p));
      const resolved = applyIn(ws, items('v2'));
      each((p, i) => {
        if (!resolving.includes(p)) return;
        assert.deepEqual([resolved.results[i].action, resolved.results[i].ok], ['unchanged', true], 'resolution');
        assert.equal(readFileSync(file(p), 'utf8'), p.userFile, 'resolving writes nothing into the file');
        assert.equal(manifestEntry(ws, p.path).base.join('\n'), p.v2);
      });
      const quiet = snapshot(ws.root);
      applyIn(ws, items('v2'));
      all(() => assert.deepEqual(snapshot(ws.root), quiet, 'after resolving, an update writes 0 files'));
    }
  } catch (err) {
    P.forEach((p) => fail(p, err));
  }
  return { failures, actions };
}

const runOne = (c, parent) => runBatch([c], parent).failures.get(c.seed) ?? null;

// Greedy shrinking: drop edits while the case still fails.
function shrink(c, parent) {
  let cur = c;
  for (let changed = true; changed;) {
    changed = false;
    for (const key of ['userOps', 'templateOps', 'before', 'after']) {
      for (let i = 0; i < cur[key].length; i++) {
        const next = { ...cur, [key]: cur[key].filter((_, k) => k !== i) };
        if (runOne(next, parent) !== null) { cur = next; changed = true; i--; }
      }
    }
  }
  return cur;
}

const BATCH = 40; // ≤ the manifest's 64 entries
function property(t, tier, make, count, base) {
  const parent = mkdtempSync(join(tmpdir(), `gen-prop-${tier}-`));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const actions = new Set();
  for (let start = 0; start < count; start += BATCH) {
    const cases = Array.from({ length: Math.min(BATCH, count - start) }, (_, k) => make(base + start + k, (start / BATCH) % 4 === 0));
    const batch = runBatch(cases, parent);
    batch.actions.forEach((a) => actions.add(a));
    for (const c of cases) {
      if (!batch.failures.has(c.seed)) continue;
      const alone = runOne(c, parent) ?? batch.failures.get(c.seed);
      const small = shrink(c, parent);
      assert.fail(`tier ${tier} seed ${c.seed}: ${runOne(small, parent) ?? alone}\nshrunk case: ${JSON.stringify({ ...small, target: small.target?.id }, null, 1)}\nreplay: GEN_SEED=${c.seed}`);
    }
  }
  return actions;
}

const SEED = Number(process.env.GEN_SEED ?? 0x9e11);

test('SC9 tier A: 520 random sequences on unique lines lose no user hunk; the second update writes 0 files', (t) => {
  const actions = property(t, 'A', caseA, 520, SEED);
  // Not vacuous: clean merges and conflicts both occur, for whole files and for blocks.
  for (const a of ['file:merge', 'file:conflict', 'block:merge', 'block:conflict']) assert.ok(actions.has(a), `${a} reached: ${[...actions]}`);
  assert.ok([...actions].some((a) => a.endsWith(':lost-hunk')), `a clean merge refused by the line counts is reached: ${[...actions]}`);
});

test('SC9 tier B: 130 random sequences on the real templates (repeated lines, CRLF, whitespace) lose no user line', (t) => {
  const actions = property(t, 'B', caseB, 130, SEED + 100000);
  assert.ok([...actions].some((a) => a.endsWith(':merge')) && [...actions].some((a) => a.endsWith(':conflict')), `merges and conflicts reached: ${[...actions]}`);
});

test('the oracles are not vacuous: a result that drops a user line is rejected by both', () => {
  assert.throws(() => oracleA('a\nb\n', 'a\nU\nb\n', 'a\nb\nT\n', 'a\nb\nT\n'), /user line lost/);
  assert.throws(() => oracleA('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\nT\n', 'a\nb\nc\nT\n'), /user deletion undone/);
  assert.throws(() => oracleA('a\nb\n', 'a\nU\nV\nb\n', 'a\nb\n', 'a\nU\nX\nV\nb\n'), /contiguous/);
  assert.throws(() => oracleA('d\na\nb\n', 'a\nb\n', 'a\nd\nb\n', 'a\nd\nb\n'), /user deletion undone/, 'r1-1 is caught by the oracle');
  assert.throws(() => oracleA('a\nb\nc\n', 'c\na\nb\n', 'a\nb\nc\n', 'a\nb\nc\n'), /user order kept/, 'an undone user move is caught');
  assert.doesNotThrow(() => oracleA('a\nb\nc\n', 'a\nb\nc\nU\n', 'c\na\nb\n', 'c\na\nb\nU\n'), 'a template move is not a user loss');
  assert.throws(() => oracleB('a\nb\n', 'a\nU\nb\n', 'a\nb\nT\n', 'a\nb\nT\n'), /lost/);
  assert.throws(() => oracleB('a\na\nb\n', 'a\nb\n', 'a\na\nb\nT\n', 'a\na\nb\nT\n'), /undone/);
});

// ---------------------------------------------------------------------------------------------------------------
// Part 3: lifecycle (the 1.x GC1 lifecycle ideas on v2 targets), crash windows, links, newer and corrupt state.

const REAL = (id) => gen.TARGETS.find((x) => x.id === id);
const OPTS = (gates = []) => ({ ...gen.DEFAULT_OPTIONS, gates });
function scratchWs(t) {
  const parent = mkdtempSync(join(tmpdir(), 'gen-life-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, ws: workspace(parent) };
}
const itemsFor = (ws, options, ids = gen.TARGETS.map((x) => x.id)) => gen.targetItems({ root: ws.root, store: ws.store, names, options, targets: ids.map(REAL) });
const read = (ws, rel) => readFileSync(join(ws.root, rel), 'utf8');
const put = (ws, rel, text) => { mkdirSync(dirname(join(ws.root, rel)), { recursive: true }); writeFileSync(join(ws.root, rel), text); };
const actionsOf = (r) => Object.fromEntries(r.results.map((x) => [x.id, x.action]));

test('files on target paths before the first run stay byte-identical; the new version goes beside them (REV-57)', (t) => {
  const { ws } = scratchWs(t);
  const mine = { ci: 'name: mine\n', 'pre-push': '#!/bin/sh\necho mine\n', codeowners: '/src/  @me\n', 'pr-template': '# Mine\n', 'agents-md': '# Agents\n\nMy notes.\n' };
  for (const x of gen.TARGETS) put(ws, x.path(names), mine[x.id]);
  let r = applyIn(ws, itemsFor(ws, OPTS()));
  assert.deepEqual(actionsOf(r), { ci: 'unknown-origin', 'pre-push': 'unknown-origin', codeowners: 'unknown-origin', 'pr-template': 'unknown-origin', 'agents-md': 'unknown-origin' });
  assert.equal(r.ok, false);
  for (const x of gen.TARGETS) {
    const rel = x.path(names);
    assert.equal(read(ws, rel), mine[x.id], `${rel} untouched`);
    const theirs = gen.render(x, OPTS(), names);
    const proposal = x.mode === 'block' ? `${mine[x.id]}${gen.wrapBlock(x, names, theirs)}` : theirs;
    assert.equal(read(ws, `${rel}${SIDE}`), proposal, `${rel}${SIDE} holds the new version`);
    const e = manifestEntry(ws, rel);
    assert.deepEqual([e.base, e.baseSha256, e.side.fileSha256], [null, null, sha(proposal)], `${rel}: side file hash recorded, no base`);
  }
  const quiet = snapshot(ws.root);
  applyIn(ws, itemsFor(ws, OPTS()));
  assert.deepEqual(snapshot(ws.root), quiet, 'the second run writes nothing');

  // Deleting a side file adopts the proposal as the base; the user's file stays.
  unlinkSync(join(ws.root, `.github/pull_request_template.md${SIDE}`));
  r = applyIn(ws, itemsFor(ws, OPTS()));
  assert.equal(actionsOf(r)['pr-template'], 'unchanged');
  assert.equal(read(ws, '.github/pull_request_template.md'), mine['pr-template']);
  assert.equal(manifestEntry(ws, '.github/pull_request_template.md').base.join('\n'), gen.render(REAL('pr-template'), OPTS(), names));
  // A later version never overwrites the adopted file without the user's lines.
  r = applyIn(ws, itemsFor(ws, OPTS([{ name: 'test', cmd: 'npm test' }]), ['pr-template']));
  const pr = read(ws, '.github/pull_request_template.md');
  if (r.results[0].action === 'conflict') assert.equal(pr, mine['pr-template']);
  else oracleB(gen.render(REAL('pr-template'), OPTS(), names), mine['pr-template'], gen.render(REAL('pr-template'), OPTS([{ name: 'test', cmd: 'npm test' }]), names), pr);
});

test('a file already equal to the generated version is not adopted: no record, nothing written (findings-r1 3)', (t) => {
  const { ws } = scratchWs(t);
  const theirs = gen.render(REAL('ci'), OPTS(), names);
  put(ws, REAL('ci').path(names), theirs);
  const r = applyIn(ws, itemsFor(ws, OPTS(), ['ci']));
  assert.deepEqual([r.results[0].action, r.results[0].ok, r.written, r.manifest], ['unknown-origin-identical', true, [], false]);
  assert.ok(!existsSync(join(ws.root, `${REAL('ci').path(names)}${SIDE}`)));
  assert.equal(manifestEntry(ws, REAL('ci').path(names)), undefined);
});

test('a lost manifest: nothing is overwritten; every file that differs from the new version gets a side file', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, itemsFor(ws, OPTS()));
  put(ws, '.githooks/pre-push', `${read(ws, '.githooks/pre-push')}# mine\n`);
  const files = Object.fromEntries(gen.TARGETS.map((x) => [x.id, read(ws, x.path(names))]));
  rmSync(join(ws.root, names.stateDir, 'generated', 'manifest.json'));
  const next = OPTS([{ name: 'test', cmd: 'npm test' }]);
  const r = applyIn(ws, itemsFor(ws, next));
  for (const x of gen.TARGETS) {
    assert.equal(read(ws, x.path(names)), files[x.id], `${x.id}: untouched`);
    const same = x.mode === 'file' ? files[x.id] === gen.render(x, next, names) : files[x.id].includes(gen.render(x, next, names));
    assert.equal(actionsOf(r)[x.id], same ? 'unknown-origin-identical' : 'unknown-origin', x.id);
  }
});

test('lifecycle of one file: update in place, merge, conflict to a side file, edited side file, resolution', (t) => {
  const { ws } = scratchWs(t);
  const it = (theirs) => [{ target: FILE_T, path: PATHS['prop-file'], theirs }];
  const file = join(ws.root, PATHS['prop-file']);
  const side = `${file}${SIDE}`;
  applyIn(ws, it('a\nb\nc\nd\ne\n'));
  // Unchanged file + new version → replaced in place.
  let r = applyIn(ws, it('a\nb\nc\nd\ne\nf\n'));
  assert.deepEqual([r.results[0].action, r.written], ['update', [PATHS['prop-file']]]);
  // Edited file + disjoint new version → merged.
  writeFileSync(file, 'USER\na\nb\nc\nd\ne\nf\n');
  r = applyIn(ws, it('a\nb\nc\nd\ne\nf\ng\n'));
  assert.equal(r.results[0].action, 'merge');
  assert.equal(readFileSync(file, 'utf8'), 'USER\na\nb\nc\nd\ne\nf\ng\n');
  // Overlapping edit → the file stays, the new version goes to the side file.
  writeFileSync(file, 'USER\na\nB-USER\nc\nd\ne\nf\ng\n');
  r = applyIn(ws, it('a\nB-NEW\nc\nd\ne\nf\ng\n'));
  assert.deepEqual([r.results[0].action, r.ok, r.results[0].sideFile], ['conflict', false, `${PATHS['prop-file']}${SIDE}`]);
  assert.equal(readFileSync(file, 'utf8'), 'USER\na\nB-USER\nc\nd\ne\nf\ng\n');
  assert.equal(readFileSync(side, 'utf8'), 'a\nB-NEW\nc\nd\ne\nf\ng\n');
  // The user edits the side file: neither file is touched, the run fails.
  writeFileSync(side, 'a\nB-MERGING\n');
  const busy = snapshot(ws.root);
  r = applyIn(ws, it('a\nB-NEW\nc\nd\ne\nf\ng\nh\n'));
  assert.deepEqual([r.results[0].action, r.ok], ['side-modified', false]);
  assert.deepEqual(snapshot(ws.root), busy, 'an edited side file stops every write for its target');
  // The user finishes and deletes the side file: the version they saw becomes the base, nothing is rewritten.
  writeFileSync(file, 'USER\na\nB-USER and B-NEW\nc\nd\ne\nf\ng\n');
  unlinkSync(side);
  r = applyIn(ws, it('a\nB-NEW\nc\nd\ne\nf\ng\n'));
  assert.deepEqual([r.results[0].action, r.written, r.manifest], ['unchanged', [], true]);
  assert.equal(manifestEntry(ws, PATHS['prop-file']).base.join('\n'), 'a\nB-NEW\nc\nd\ne\nf\ng\n');
  // A later version merges against that base and keeps the resolution.
  r = applyIn(ws, it('a\nB-NEW\nc\nd\ne\nf\ng\nh\n'));
  assert.equal(r.results[0].action, 'merge');
  assert.equal(readFileSync(file, 'utf8'), 'USER\na\nB-USER and B-NEW\nc\nd\ne\nf\ng\nh\n');
});

test('a merge that would lose a user hunk is refused: the file stays, the new version goes to the side file', (t) => {
  const { ws } = scratchWs(t);
  const it = (theirs) => [{ target: FILE_T, path: PATHS['prop-file'], theirs }];
  applyIn(ws, it('a\nb\nc\n'));
  writeFileSync(join(ws.root, PATHS['prop-file']), 'a\nUSER\nb\nc\n');
  const lossy = ({ theirs }) => ({ status: 'clean', text: theirs });
  const r = applyIn(ws, it('a\nb\nc\nd\n'), { merge: lossy });
  assert.deepEqual([r.results[0].action, r.ok], ['lost-hunk', false]);
  assert.equal(readFileSync(join(ws.root, PATHS['prop-file']), 'utf8'), 'a\nUSER\nb\nc\n');
  assert.equal(readFileSync(join(ws.root, `${PATHS['prop-file']}${SIDE}`), 'utf8'), 'a\nb\nc\nd\n');
});

test('a side file nobody recorded stops its target, even one equal to the proposal (findings-r1 2)', (t) => {
  const { ws } = scratchWs(t);
  const rel = PATHS['prop-file'];
  put(ws, rel, 'mine\n');
  for (const text of ['also mine\n', 'generated\n']) {
    put(ws, `${rel}${SIDE}`, text);
    const before = snapshot(ws.root);
    const r = applyIn(ws, [{ target: FILE_T, path: rel, theirs: 'generated\n' }]);
    assert.deepEqual([r.results[0].action, r.ok], ['side-foreign', false], text);
    assert.deepEqual(snapshot(ws.root), before, 'nothing written');
    assert.equal(manifestEntry(ws, rel), undefined, 'never registered');
  }
});

test('symbolic links on a target path are refused; nothing is written through them', (t) => {
  const { parent, ws } = scratchWs(t);
  const outside = mkdtempSync(join(parent, 'outside-'));
  symlinkSync(outside, join(ws.root, '.github'));
  put(ws, '.githooks/real', 'x\n');
  symlinkSync(join(ws.root, '.githooks', 'real'), join(ws.root, '.githooks', 'pre-push'));
  const r = applyIn(ws, itemsFor(ws, OPTS(), ['ci', 'pre-push', 'pr-template']));
  assert.deepEqual(actionsOf(r), { ci: 'unsafe', 'pre-push': 'unsafe', 'pr-template': 'unsafe' });
  assert.deepEqual(readdirSync(outside), [], 'nothing written outside the repository');
  assert.equal(read(ws, '.githooks/real'), 'x\n');
  // A link in place of the side file is refused as well.
  const rel = PATHS['prop-file'];
  put(ws, rel, 'mine\n');
  symlinkSync(join(outside, 'target'), join(ws.root, `${rel}${SIDE}`));
  assert.equal(applyIn(ws, [{ target: FILE_T, path: rel, theirs: 'x\n' }]).results[0].action, 'unsafe');
  assert.deepEqual(readdirSync(outside), []);
});

test('managed block: bytes outside stay; broken markers stop the run; removed markers are respected until a new version', (t) => {
  const { ws } = scratchWs(t);
  const rel = PATHS['prop-block'];
  const it = (theirs) => [{ target: BLOCK_T, path: rel, theirs }];
  applyIn(ws, it('r1\n'));
  assert.equal(read(ws, rel), `${MARK.begin}r1\n${MARK.end}`);
  put(ws, rel, `head\r\n${MARK.begin}r1\nmine\n${MARK.end}tail without newline`);
  let r = applyIn(ws, it('r0\nr1\n'));
  assert.equal(r.results[0].action, 'merge');
  assert.equal(read(ws, rel), `head\r\n${MARK.begin}r0\nr1\nmine\n${MARK.end}tail without newline`);
  // Broken markers: nothing is written.
  put(ws, rel, `${MARK.begin}r0\n${MARK.begin}`);
  const before = snapshot(ws.root);
  r = applyIn(ws, it('r0\nr1\nr2\n'));
  assert.deepEqual([r.results[0].action, r.ok], ['block-malformed', false]);
  assert.deepEqual(snapshot(ws.root), before);
  // Markers removed: kept removed while the version is the same; a new version is proposed in the side file.
  put(ws, rel, 'only my lines\n');
  r = applyIn(ws, it('r0\nr1\n'));
  assert.deepEqual([r.results[0].action, r.written], ['unchanged', []]);
  r = applyIn(ws, it('r0\nr1\nr2\n'));
  assert.equal(r.results[0].action, 'conflict');
  assert.equal(read(ws, rel), 'only my lines\n');
  assert.equal(read(ws, `${rel}${SIDE}`), `only my lines\n${MARK.begin}r0\nr1\nr2\n${MARK.end}`);
});

test('crash windows (findings-r1 5): a cut run is finished from its write-ahead intent or redone, never applied twice', (t) => {
  const { ws } = scratchWs(t);
  const rel = PATHS['prop-file'];
  const file = join(ws.root, rel);
  const side = `${file}${SIDE}`;
  const it = (theirs) => [{ target: FILE_T, path: rel, theirs }];
  const cut = (watch, theirs) => assert.throws(() => applyIn({ ...ws, store: crashingStore(ws.store, watch) }, it(theirs)), (err) => err.code === 'ECRASH');
  // (1) a created file whose record was not committed: finished, not reported as unknown origin.
  cut([file], 'a\nb\nc\nd\n');
  assert.equal(manifestEntry(ws, rel).pending.resultSha256, sha('a\nb\nc\nd\n'), 'the intent is recorded');
  const created = statSync(file, { bigint: true }).ino;
  let r = applyIn(ws, it('a\nb\nc\nd\n'));
  assert.deepEqual([r.results[0].action, r.written], ['unchanged', []]);
  assert.equal(statSync(file, { bigint: true }).ino, created);
  assert.equal(manifestEntry(ws, rel).base.join('\n'), 'a\nb\nc\nd\n');
  assert.equal(manifestEntry(ws, rel).pending, undefined);
  // (2) a side file written, its record not committed: recorded, not rewritten, not called foreign.
  writeFileSync(file, 'a\nX\nc\nd\n');
  cut([side], 'a\nY\nc\nd\n');
  const proposal = statSync(side, { bigint: true }).ino;
  r = applyIn(ws, it('a\nY\nc\nd\n'));
  assert.deepEqual([r.results[0].action, r.written], ['conflict', []]);
  assert.equal(statSync(side, { bigint: true }).ino, proposal);
  assert.equal(manifestEntry(ws, rel).side.fileSha256, sha('a\nY\nc\nd\n'));
  // (3) cut before the write landed (the directory refused it): the run is redone once.
  writeFileSync(file, 'a\nb\nc\nd\n'); // pristine again, the side file still pending
  chmodSync(dirname(file), 0o555);
  try { assert.throws(() => applyIn(ws, it('a\nb\nc\nd\ne\n'))); } finally { chmodSync(dirname(file), 0o755); }
  assert.ok(manifestEntry(ws, rel).pending, 'the intent outlives the failed write');
  r = applyIn(ws, it('a\nb\nc\nd\ne\n'));
  assert.deepEqual(r.results[0].action, 'update');
  assert.equal(read(ws, rel), 'a\nb\nc\nd\ne\n');
  assert.ok(!existsSync(side), 'our side file removed');
  // (4) cut between the target write and the removal of our side file: the leftover is removed, nothing else.
  writeFileSync(file, 'a\nX\nc\nd\ne\n');
  applyIn(ws, it('a\nY\nc\nd\ne\n')); // conflict: side file recorded
  const sideText = readFileSync(side, 'utf8');
  writeFileSync(file, 'a\nb\nc\nd\ne\n'); // the user restores the pristine file
  cut([file], 'a\nb\nc\nd\ne\nf\n');
  writeFileSync(side, sideText); // as if the cut came before the removal
  r = applyIn(ws, it('a\nb\nc\nd\ne\nf\n'));
  assert.deepEqual([r.results[0].action, r.results[0].removed, r.written], ['unchanged', [`${rel}${SIDE}`], []]);
  assert.equal(read(ws, rel), 'a\nb\nc\nd\ne\nf\n', 'applied once');
  assert.deepEqual([manifestEntry(ws, rel).side, manifestEntry(ws, rel).pending], [null, undefined]);
  const quiet = snapshot(ws.root);
  applyIn(ws, it('a\nb\nc\nd\ne\nf\n'));
  assert.deepEqual(snapshot(ws.root), quiet);
});

test('newer or corrupt records: a newer schema refuses before any write; a base that fails its hash is unknown origin', (t) => {
  const { ws } = scratchWs(t);
  const rel = PATHS['prop-file'];
  applyIn(ws, [{ target: FILE_T, path: rel, theirs: 'a\n' }]);
  writeFileSync(join(ws.root, rel), 'a\nmine\n');
  const good = gen.readManifest(ws.store);
  const bad = structuredClone(good);
  bad.files[rel].base = ['tampered', ''];
  ws.store.write('generated', null, bad);
  let r = applyIn(ws, [{ target: FILE_T, path: rel, theirs: 'a\nb\n' }]);
  assert.equal(r.results[0].action, 'unknown-origin', 'a base that does not match its hash is no base');
  assert.equal(read(ws, rel), 'a\nmine\n');
  const manifestFile = join(ws.root, names.stateDir, 'generated', 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify({ ...good, schema: 2 }));
  const before = snapshot(ws.root);
  assert.throws(() => applyIn(ws, [{ target: FILE_T, path: rel, theirs: 'a\nc\n' }]), (err) => err.code === 'schema-newer' && err.exit === 'REFUSED');
  assert.throws(() => applyIn(ws, [{ target: FILE_T, path: rel, theirs: 'a\nc\n' }], { dryRun: true }), (err) => err.code === 'schema-newer');
  assert.deepEqual(snapshot(ws.root), before, 'nothing written');
});

test('file modes: the hook is created executable and a mode the user set is kept on update', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, itemsFor(ws, OPTS(), ['pre-push']));
  const hook = join(ws.root, '.githooks/pre-push');
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  chmodSync(hook, 0o700);
  const r = applyIn(ws, itemsFor(ws, OPTS([{ name: 'test', cmd: 'npm test' }]), ['pre-push']));
  assert.equal(r.results[0].action, 'update');
  assert.equal(statSync(hook).mode & 0o777, 0o700);
});

test('CODEOWNERS: an existing file in a location GitHub reads first is the target; a recorded location wins', (t) => {
  const { ws } = scratchWs(t);
  assert.equal(itemsFor(ws, OPTS(), ['codeowners'])[0].path, 'CODEOWNERS', 'default location');
  put(ws, 'docs/CODEOWNERS', '/docs/ @d\n');
  assert.equal(itemsFor(ws, OPTS(), ['codeowners'])[0].path, 'docs/CODEOWNERS');
  put(ws, '.github/CODEOWNERS', '* @g\n');
  assert.equal(itemsFor(ws, OPTS(), ['codeowners'])[0].path, '.github/CODEOWNERS', 'GitHub reads .github/ first');
  applyIn(ws, itemsFor(ws, OPTS(), ['codeowners']));
  rmSync(join(ws.root, '.github/CODEOWNERS'));
  assert.equal(itemsFor(ws, OPTS(), ['codeowners'])[0].path, '.github/CODEOWNERS', 'the recorded location stays the target');
});

test('the JSON record parses and holds each base exactly, for every option combination (REV-56)', (t) => {
  const { parent } = scratchWs(t);
  const combos = [[], [{ name: 'test', cmd: 'npm test' }], [{ name: 'q "x"', cmd: "echo 'y' \\ z" }]].flatMap((gates) => [[], ['@o/t']].map((owners) => ({ ...gen.DEFAULT_OPTIONS, gates, owners })));
  for (const o of combos) {
    const ws = workspace(parent);
    const r = applyIn(ws, itemsFor(ws, o));
    assert.ok(r.ok, JSON.stringify(o));
    const doc = JSON.parse(readFileSync(join(ws.root, names.stateDir, 'generated', 'manifest.json'), 'utf8'));
    assert.equal(doc.schema, 1);
    for (const x of gen.TARGETS) {
      const e = doc.files[x.path(names)];
      const theirs = gen.render(x, o, names);
      assert.deepEqual([e.target, e.template, e.templateVersion, e.side], [x.id, x.template, VERSION, null]);
      assert.equal(e.base.join('\n'), theirs);
      assert.equal(e.baseSha256, sha(theirs));
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Part 4: the commands. `gen apply [--dry-run]` and `gen plan` through the launcher, one JSON envelope each;
// `doctor` fails when a generated side file is tracked (spec §7.14a).

const LAUNCHER = join(pluginDir, 'bin', names.bin);
// The options of the commands in a repository without a profile: no gates, the npx spec of this plugin version.
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const CLI_OPTIONS = { ...gen.DEFAULT_OPTIONS, package: gen.packageSpec(names, PLUGIN_VERSION) };
const cli = (args, opts = {}) => spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', timeout: 60000, env: process.env, ...opts });
const show = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
function envelope(r) {
  assert.equal(r.stderr, '', `--json keeps stderr empty\n${show(r)}`);
  const all = r.stdout.trim().split('\n');
  assert.equal(all.length, 1, `one envelope line\n${show(r)}`);
  const e = JSON.parse(all[0]);
  assert.equal(e.code, r.status);
  for (const x of e.errors) assert.ok(x.message.length <= 300 && x.hint.length <= 200 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.code), JSON.stringify(x));
  return e;
}
function gitRepo(t, { active = true, flags = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, env: process.env }).status, 0);
  if (active) {
    const store = gen.openStore(join(dir, names.stateDir), names);
    store.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: now() });
    if (Object.keys(flags).length) store.write('config', null, { flags });
  }
  return dir;
}

test('gen apply / gen plan: targets by name, by capability flag, or already generated; one envelope; exit codes', (t) => {
  const repo = gitRepo(t, { flags: { 'pre-push': 'on' } });
  const ci = REAL('ci').path(names);
  let r = cli(['gen', 'plan', '--json'], { cwd: repo });
  assert.equal(r.status, 0, show(r));
  let e = envelope(r);
  assert.deepEqual(e.data.targets.map((x) => [x.id, x.action]), [['pre-push', 'create']], 'only the enabled target');
  assert.ok(!existsSync(join(repo, '.githooks')), 'plan writes nothing');

  r = cli(['gen', 'apply', 'ci', '--yes', '--json'], { cwd: repo });
  e = envelope(r);
  assert.deepEqual([r.status, e.data.targets.map((x) => [x.id, x.action]), e.data.written], [0, [['ci', 'create']], [ci]]);
  assert.equal(readFileSync(join(repo, ci), 'utf8'), gen.render(REAL('ci'), CLI_OPTIONS, names));

  r = cli(['gen', 'apply', '--yes', '--json'], { cwd: repo });
  e = envelope(r);
  assert.deepEqual(e.data.targets.map((x) => [x.id, x.action]), [['ci', 'unchanged'], ['pre-push', 'create']], 'enabled and already generated');
  assert.equal(statSync(join(repo, '.githooks/pre-push')).mode & 0o111, 0o111);

  // Human output: one row per target; a second run writes nothing.
  r = cli(['gen', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.status, 0, show(r));
  assert.match(r.stdout, new RegExp(`^ {2}unchanged +${ci.replace(/\./g, '\\.')}$`, 'm'));

  // Conflict: exit 1 with the side file named in the error; --dry-run and plan predict it and write nothing.
  writeFileSync(join(repo, ci), readFileSync(join(repo, ci), 'utf8').replace('runs-on: ubuntu-latest', 'runs-on: macos-latest'));
  gen.openStore(join(repo, names.stateDir), names).update('generated', null, (doc) => {
    const entry = doc.files[ci];
    const base = entry.base.join('\n').replace('runs-on: ubuntu-latest', 'runs-on: windows-latest');
    return { ...doc, files: { ...doc.files, [ci]: { ...entry, base: base.split('\n'), baseSha256: sha(base) } } };
  });
  const before = snapshot(repo);
  for (const args of [['gen', 'plan', '--json'], ['gen', 'apply', '--dry-run', '--yes', '--json']]) {
    r = cli(args, { cwd: repo });
    e = envelope(r);
    assert.equal(r.status, 1, show(r));
    assert.equal(e.data.dryRun, true);
    assert.deepEqual(e.errors.map((x) => x.code), ['conflict']);
    assert.match(e.errors[0].hint, new RegExp(`${ci.replace(/\./g, '\\.')}${SIDE.replace(/[.-]/g, '\\$&')}`));
    assert.deepEqual(snapshot(repo), before, `${args.join(' ')} writes nothing`);
  }
  r = cli(['gen', 'apply', '--yes', '--json'], { cwd: repo });
  assert.equal(r.status, 1, show(r));
  assert.ok(existsSync(join(repo, `${ci}${SIDE}`)));
});

test('gen commands refuse what they must: unknown target, no consent, inactive repository, newer state, not a repository', (t) => {
  const repo = gitRepo(t);
  let r = cli(['gen', 'apply', 'nope', '--yes', '--json'], { cwd: repo });
  assert.deepEqual([r.status, envelope(r).errors[0].code], [2, 'unknown-target']);
  r = cli(['gen', 'apply', 'ci', '--json'], { cwd: repo, input: '' });
  assert.deepEqual([r.status, envelope(r).errors[0].code], [7, 'consent-required'], 'apply changes files: a terminal or --yes');
  assert.equal(cli(['gen', 'plan', 'ci', '--json'], { cwd: repo }).status, 0, 'plan needs no consent');
  const dry = cli(['gen', 'apply', 'ci', '--dry-run', '--json'], { cwd: repo, input: '' });
  assert.deepEqual([dry.status, envelope(dry).data.dryRun], [0, true], 'consent per form (S2): apply --dry-run writes nothing, so it needs none');

  const idle = gitRepo(t, { active: false });
  const before = snapshot(idle);
  for (const args of [['gen', 'apply', 'ci', '--yes', '--json'], ['gen', 'plan', 'ci', '--json']]) {
    r = cli(args, { cwd: idle });
    assert.deepEqual([r.status, envelope(r).errors[0].code], [7, 'inactive'], args.join(' '));
  }
  assert.deepEqual(snapshot(idle), before, 'nothing written into an inactive repository');

  writeFileSync(join(repo, names.stateDir, 'state.json'), `${JSON.stringify({ schema: 99, codename: names.codename })}\n`);
  r = cli(['gen', 'apply', 'ci', '--yes', '--json'], { cwd: repo });
  assert.deepEqual([r.status, envelope(r).errors[0].code], [7, 'schema-newer']);
  assert.ok(!existsSync(join(repo, REAL('ci').path(names))));

  const plain = mkdtempSync(join(tmpdir(), 'gen-cli-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  r = cli(['gen', 'plan', '--json'], { cwd: plain });
  assert.equal(r.status, 8, show(r));
});

test('the command table names exactly the generator targets (one source, GC6)', async () => {
  const { COMMANDS } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);
  for (const name of ['gen apply', 'gen plan']) {
    const row = COMMANDS.find((x) => x.name === name);
    assert.ok(row, name);
    const listed = row.args[0].summary.match(/[a-z][a-z-]*[a-z]/g).filter((w) => gen.TARGETS.some((x) => x.id === w));
    assert.deepEqual(listed, gen.TARGETS.map((x) => x.id), `${name}: the target argument lists every target`);
  }
});

test('concurrent gen apply runs: one run creates each file, the others find it unchanged; no intent or side file is left', async (t) => {
  const repo = gitRepo(t);
  const once = () => new Promise((done) => {
    const child = spawn(process.execPath, [LAUNCHER, 'gen', 'apply', ...gen.TARGETS.map((x) => x.id), '--yes', '--json'], { cwd: repo, env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => done({ code, out, err }));
  });
  const runs = await Promise.all(Array.from({ length: 4 }, once));
  for (const r of runs) assert.equal(r.code, 0, `${r.out}${r.err}`);
  const envelopes = runs.map((r) => JSON.parse(r.out));
  const files = gen.readManifest(gen.openStore(join(repo, names.stateDir), names)).files;
  for (const x of gen.TARGETS) {
    const actions = envelopes.map((e) => e.data.targets.find((y) => y.id === x.id).action);
    assert.deepEqual(actions.filter((a) => a === 'create').length, 1, `${x.id} created once: ${actions}`);
    assert.ok(actions.every((a) => a === 'create' || a === 'unchanged'), `${x.id}: ${actions}`);
    const theirs = gen.render(x, CLI_OPTIONS, names);
    assert.equal(readFileSync(join(repo, x.path(names)), 'utf8'), x.mode === 'block' ? gen.wrapBlock(x, names, theirs) : theirs);
    assert.deepEqual([files[x.path(names)].baseSha256, files[x.path(names)].side, files[x.path(names)].pending], [sha(theirs), null, undefined]);
    assert.ok(!existsSync(join(repo, `${x.path(names)}${SIDE}`)));
  }
});

// A fake `claude` answering the three calls doctor makes (as in tests/cli-contract.test.mjs), on a PATH with only
// system directories besides it.
async function doctorEnv(t) {
  const bin = mkdtempSync(join(tmpdir(), 'gen-doctor-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  symlinkSync(process.execPath, join(bin, 'node'));
  const { HOOKS } = await import(pathToFileURL(join(pluginDir, 'lib', 'hooks', 'registry.mjs')).href);
  const events = [...new Set(HOOKS.map((h) => h.event))];
  const id = `${names.plugin}@${names.marketplace}`;
  const version = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const details = [`${names.plugin} ${version}`, '', 'Component inventory', `  Hooks (${events.length})  ${events.join(', ')}  (harness-only)`, '', 'Projected token cost', '  Always-on:   ~0 tok   added to every session', ''].join('\n');
  const answers = JSON.stringify({ list: JSON.stringify([{ id, version, scope: 'user', enabled: true }]), details, id });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2);
const o = ${answers};
if (a.length === 1 && a[0] === '--version') process.stdout.write('2.1.300 (Claude Code)\\n');
else if (a.join(' ') === 'plugin list --json') process.stdout.write(o.list);
else if (a[0] === 'plugin' && a[1] === 'details' && a[2] === o.id) process.stdout.write(o.details);
else process.exit(64);
`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { ...process.env, PATH: [bin, '/usr/bin', '/bin'].join(delimiter) };
}

test('doctor fails when a generated side file is tracked; an untracked one is fine (spec §7.14a)', async (t) => {
  const env = await doctorEnv(t);
  const repo = gitRepo(t);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env: process.env }).status, 0, args.join(' '));
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
  let r = cli(['doctor', '--json'], { cwd: repo, env });
  let e = envelope(r);
  assert.equal(r.status, 0, show(r));
  // A healthy report keeps the doctor v0 rows (tests/e2e/install.test.mjs pins them); the row appears on failure.
  assert.deepEqual(e.data.checks.map((c) => [c.id, c.ok]), [['claude-code', true], ['plugin', true], ['hooks', true]]);

  put({ root: repo }, `CODEOWNERS${SIDE}`, 'proposal\n');
  assert.equal(cli(['doctor', '--json'], { cwd: repo, env }).status, 0, 'an untracked side file is no failure');
  git('add', `CODEOWNERS${SIDE}`);
  r = cli(['doctor', '--json'], { cwd: repo, env });
  e = envelope(r);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(e.data.checks.find((c) => c.id === 'side-files').ok, false);
  const err = e.errors.find((x) => x.code === 'side-file-tracked');
  assert.ok(err && err.message.includes(`CODEOWNERS${SIDE}`), JSON.stringify(e.errors));
  r = cli(['doctor'], { cwd: repo, env });
  assert.match(r.stdout, /^ {2}FAIL {2}side-files/m);

  // Without claude, doctor still names the tracked side file (exit 8: the environment problem comes first).
  r = cli(['doctor', '--json'], { cwd: repo, env: { ...env, PATH: ['/usr/bin', '/bin'].join(delimiter) } });
  e = envelope(r);
  assert.equal(r.status, 8, show(r));
  assert.ok(e.errors.some((x) => x.code === 'side-file-tracked'));
});

// ---------------------------------------------------------------------------------------------------------------
// Part 5: review round 1 (Codex review-r1, findings-r1): each reproduction as a deterministic test.

const rel1 = PATHS['prop-file'];
const one = (theirs) => [{ target: FILE_T, path: rel1, theirs }];
const sideOf = (ws) => join(ws.root, `${rel1}${SIDE}`);

// A store whose manifest write fails once a watched file has changed: the run is cut after its file writes and
// before its record is committed, whatever the order of the writes inside the run (a crash at that point).
function crashingStore(store, files) {
  const at = () => files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null)).join('\0');
  const before = at();
  const crash = () => { if (at() !== before) throw Object.assign(new Error('simulated crash before the record is committed'), { code: 'ECRASH' }); };
  return new Proxy(store, {
    get(t, key) {
      if (key !== 'update') return typeof t[key] === 'function' ? t[key].bind(t) : t[key];
      return (name, k, fn) => { crash(); return t.update(name, k, (cur) => { const out = fn(cur); crash(); return out; }); };
    },
  });
}

test('r1-1: a template that moves a line the user deleted does not bring it back (line counts must add up)', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, one('d\na\nb\n'));
  writeFileSync(join(ws.root, rel1), 'a\nb\n');
  const r = applyIn(ws, one('a\nd\nb\n'));
  assert.ok(['conflict', 'lost-hunk'].includes(r.results[0].action), r.results[0].action);
  assert.equal(read(ws, rel1), 'a\nb\n', 'the file is byte-identical');
  assert.equal(readFileSync(sideOf(ws), 'utf8'), 'a\nd\nb\n');
});

test('r1-2: a side file is ours only by its record: equal content claims neither a foreign nor an edited one', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, one('v1\n'));
  writeFileSync(sideOf(ws), 'v2\n'); // created by the user, never recorded
  let r = applyIn(ws, one('v2\n'));
  assert.deepEqual([r.results[0].action, r.ok], ['side-foreign', false]);
  assert.equal(readFileSync(sideOf(ws), 'utf8'), 'v2\n', 'the foreign side file stays');
  assert.equal(read(ws, rel1), 'v1\n', 'nothing written for the target');

  const { ws: ws2 } = scratchWs(t);
  applyIn(ws2, one('a\nb\nc\n'));
  writeFileSync(join(ws2.root, rel1), 'a\nB-USER\nc\n');
  applyIn(ws2, one('a\nB1\nc\n')); // conflict: side file recorded with the B1 proposal
  writeFileSync(sideOf(ws2), 'a\nB2\nc\n'); // the user edits it to what the next version will propose
  r = applyIn(ws2, one('a\nB2\nc\n'));
  assert.deepEqual([r.results[0].action, r.ok], ['side-modified', false], 'never re-registered by equality');
  r = applyIn(ws2, one('a\nB3\nc\n'));
  assert.equal(r.results[0].action, 'side-modified');
  assert.equal(readFileSync(sideOf(ws2), 'utf8'), 'a\nB2\nc\n', 'the edited side file is never overwritten');
  assert.equal(read(ws2, rel1), 'a\nB-USER\nc\n');
});

test('r1-3: a file of unknown origin equal to the template is not adopted; a later version goes to a side file', (t) => {
  const { ws } = scratchWs(t);
  put(ws, rel1, 'v1\n');
  let r = applyIn(ws, one('v1\n'));
  assert.deepEqual([r.results[0].action, r.ok, r.written, r.manifest], ['unknown-origin-identical', true, [], false]);
  assert.equal(manifestEntry(ws, rel1), undefined, 'no record');
  r = applyIn(ws, one('v2\n'));
  assert.equal(r.results[0].action, 'unknown-origin');
  assert.equal(read(ws, rel1), 'v1\n', 'the user\'s file is untouched');
  assert.equal(readFileSync(sideOf(ws), 'utf8'), 'v2\n');
});

test('r1-4: a template that converges with a user edit keeps the base, so a later version cannot erase the edit', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, one('a\n'));
  writeFileSync(join(ws.root, rel1), 'a\nUSER\n');
  let r = applyIn(ws, one('a\nUSER\n'));
  assert.equal(r.results[0].action, 'unchanged');
  assert.equal(manifestEntry(ws, rel1).base.join('\n'), 'a\n', 'the base stays');
  r = applyIn(ws, one('a\n'));
  assert.ok(read(ws, rel1).includes('USER\n'), `the user's line survives (${r.results[0].action})`);
  // A clean merge that leaves the file as it is moves no base either (a merge keeping ours; theirs only reorders,
  // so the line counts add up).
  const { ws: w2 } = scratchWs(t);
  applyIn(w2, one('a\nb\nc\n'));
  writeFileSync(join(w2.root, rel1), 'a\nb\nc\nU\n');
  r = applyIn(w2, one('b\na\nc\n'), { merge: ({ ours }) => ({ status: 'clean', text: ours }) });
  assert.deepEqual([r.results[0].action, r.written], ['unchanged', []]);
  assert.equal(manifestEntry(w2, rel1).base.join('\n'), 'a\nb\nc\n', 'the base stays');
});

test('r1-5: a run cut after its file write and before its record replays without applying the merge twice', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, one('\nc\n'));
  writeFileSync(join(ws.root, rel1), 'U\nc\n');
  const cut = { ...ws, store: crashingStore(ws.store, [join(ws.root, rel1)]) };
  assert.throws(() => applyIn(cut, one('\nc\nc\n')), (err) => err.code === 'ECRASH');
  assert.equal(read(ws, rel1), 'U\nc\nc\n', 'the merge reached the file before the cut');
  const r = applyIn(ws, one('\nc\nc\n'));
  assert.equal(read(ws, rel1), 'U\nc\nc\n', `exactly one added c (${r.results[0].action})`);
  assert.equal(manifestEntry(ws, rel1).base.join('\n'), '\nc\nc\n', 'the interrupted run is committed');
  const quiet = snapshot(ws.root);
  applyIn(ws, one('\nc\nc\n'));
  assert.deepEqual(snapshot(ws.root), quiet, 'then nothing more is written');
});

// A store that runs `pause` once, right after the first manifest write of a run (its intent): another run and the
// user act while this one waits between recording what it will write and writing it (Codex rereview-r1).
function pausingStore(store, pause) {
  let calls = 0;
  return new Proxy(store, {
    get(t, key) {
      if (key !== 'update') return typeof t[key] === 'function' ? t[key].bind(t) : t[key];
      return (name, k, fn) => { const out = t.update(name, k, fn); if (++calls === 1) pause(); return out; };
    },
  });
}

test('rereview-r1: a run paused after its intent while another run commits and the user edits writes nothing stale', (t) => {
  const { ws } = scratchWs(t);
  applyIn(ws, one('v1\n'));
  let b = null;
  const paused = { ...ws, store: pausingStore(ws.store, () => {
    b = applyIn(ws, one('v2\n')); // run B: commits v2 while A waits
    writeFileSync(join(ws.root, rel1), 'v2\nUSER\n'); // the user saves after B returns
  }) };
  const a = applyIn(paused, one('v2\n')); // run A resumes
  assert.equal(b.results[0].action, 'update');
  assert.equal(read(ws, rel1), 'v2\nUSER\n', 'USER survives');
  assert.deepEqual([a.results[0].action, a.written], ['unchanged', []], 'A decides again from what is there now');
  const entry = manifestEntry(ws, rel1);
  assert.deepEqual([entry.base.join('\n'), entry.pending], ['v2\n', undefined]);
  assert.ok(!existsSync(sideOf(ws)));
});
