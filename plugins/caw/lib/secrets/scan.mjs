// Secrets scanner (spec §8.2 `secrets`, §11, SD-29): finds the patterns of patterns.mjs and key files in one mode:
//   tree      what a commit takes and what `git add -A` would add: tracked files and untracked files that are not
//             ignored, as they are on disk, and the lines only the index holds (`git diff -R`: the index side of index →
//             working tree, so a secret staged and then fixed only on disk, or a staged file deleted on disk, is seen)
//   staged    the lines added in the index against HEAD (`git diff --cached`; on an unborn branch everything staged)
//   range     the lines added by every commit of the revisions (`git log -p`, merges `--cc`: also a secret added and
//             removed again, and the resolution of a merge), and key files added or renamed in them
//   artifact  every file under a built file or directory (ignored or not, links not followed); the synthetic marker
//             exempts nothing there, a build is no test fixture (SEC-11)
// Text is read as bytes (latin1, see patterns.mjs); binary files (a NUL in the first 8000 bytes, as git decides) are
// not read. Diffs come from git without colour, context, external diff drivers or text conversion.
// git writes diffs and logs into a private temporary directory (--output) that is read in chunks: an output captured
// by lib/git is capped at 16 MB, and a range can hold far more (the first push of a large history). git refuses
// --output for a combined diff, so the merges of a range are read from a captured `git log --merges --cc`: it holds
// only what no parent had (the resolution of a conflict), and beyond the cap the scan is invalid. Every failure (git
// missing or failing, a file or the pattern file unreadable, a pattern refused, a path that is not UTF-8) throws a
// StateError with exit ENV: the result is invalid, never clean.
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve as resolvePath } from 'node:path';
import { git } from '../git/index.mjs';
import { StateError, resolve } from '../state/index.mjs';
import { isKeyFile, isSynthetic, mask, matchLine, projectPatterns, skipsContent } from './patterns.mjs';

export const MODES = Object.freeze(['tree', 'staged', 'range', 'artifact']);
export const PATTERN_FILE = 'secrets-patterns.txt';
const PATTERN_FILE_MAX = 65536;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const CHUNK = 1 << 20;
const BINARY_PROBE = 8000; // git's own look-ahead for a NUL
const SHA_SHOWN = 12;
// Diff output: added lines only, no colour, external diff driver or text conversion, renames found, paths without
// a/ b/ prefixes (so `-R` changes nothing in them); no context lines at all, also between near hunks.
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--inter-hunk-context=0', '--no-prefix', '-M'];
// Options a range may hold besides revisions: they select commits and write nothing.
const RANGE_OPTIONS = new Set(['--not', '--all', '--branches', '--remotes', '--tags']);

const invalid = (code, message, hint) => new StateError(code, 'ENV', message, { hint });

// The words of a --range value, or { error }: revisions as git log takes them, and only the options above, so no
// option reaches git that changes what it does (an --output=<file> would write a file).
export function rangeWords(text) {
  const words = String(text ?? '').split(/[ \t\n]+/).filter(Boolean);
  if (!words.length) return { error: 'the range is empty' };
  const bad = words.find((w) => w.startsWith('-') && !RANGE_OPTIONS.has(w));
  if (bad !== undefined) return { error: `${bad} is not a revision; a range holds revisions and only ${[...RANGE_OPTIONS].join(', ')}` };
  return { words };
}

function runGit(ctx, args) {
  const r = git(['-c', 'core.quotePath=false', ...args], { cwd: ctx.repo, env: ctx.env, timeoutMs: GIT_TIMEOUT_MS });
  if (r.error === 'missing') throw invalid('git-missing', 'git is not on PATH', 'install git and put it on PATH');
  if (r.error || r.status !== 0) {
    const said = (r.stderr.trim().split('\n')[0] ?? '').slice(0, 160);
    throw invalid('git-failed', `git ${args[0]} failed (${r.error ?? r.signal ?? `exit ${r.status}`}${said ? `: ${said}` : ''})`, 'check the revisions and that git runs in this repository');
  }
  return r.stdout;
}
// git writing into a file of the temporary directory; the file's path. No file after a success is an empty output.
function gitToFile(ctx, [command, ...args]) {
  const file = join(ctx.tmp, `git-${ctx.outputs++}`);
  runGit(ctx, [command, `--output=${file}`, ...args]);
  return file;
}

// The whole output of a small listing (names), as UTF-8.
function readOutput(file) {
  try { return readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw invalid('output-unreadable', `cannot read the git output (${err.code ?? err.message})`, 'check the temporary directory (TMPDIR)');
  }
}
function forEachLine(file, fn) {
  let fd;
  try { fd = openSync(file, 'r'); } catch (err) {
    if (err.code === 'ENOENT') return;
    throw invalid('output-unreadable', `cannot read the git output (${err.code ?? err.message})`, 'check the temporary directory (TMPDIR)');
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    let rest = '';
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const parts = (rest + buf.toString('latin1', 0, n)).split('\n'); // latin1: a chunk boundary never splits a character
      rest = parts.pop();
      for (const line of parts) fn(line);
    }
    if (rest !== '') fn(rest);
  } finally {
    closeSync(fd);
  }
}

// A path as git prints it in a diff header: C-quoted when it holds special characters; bytes (latin1) → UTF-8.
const ESCAPES = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
function diffPath(text) {
  let raw = text;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, e) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : ESCAPES[e] ?? e));
  }
  return Buffer.from(raw, 'latin1').toString('utf8');
}

// The added lines of a diff, or of `git log -p` (--cc) with one --format=%x01%H line per commit, whose lines
// eachLine(fn) passes on: add(text, { commit, path, line }). In a combined diff of a merge every parent has a column;
// a line is new when each column holds "+".
const fileLines = (file) => (fn) => forEachLine(file, fn);
const textLines = (text) => (fn) => { const lines = Buffer.from(text, 'utf8').toString('latin1').split('\n'); if (lines[lines.length - 1] === '') lines.pop(); lines.forEach((l) => fn(l)); };
function addedLines(eachLine, add) {
  let commit = null;
  let path = '';
  let inHunk = false;
  let parents = 1;
  let line = 0;
  eachLine((l) => {
    if (l.charCodeAt(0) === 1) { commit = l.slice(1, 1 + SHA_SHOWN); inHunk = false; path = ''; return; }
    if (l.startsWith('diff ')) { inHunk = false; path = ''; return; }
    if (!inHunk && l.startsWith('+++ ')) { const p = diffPath(l.slice(4)); path = p === '/dev/null' ? '' : p; return; }
    if (l.startsWith('@@')) {
      parents = /^@+/.exec(l)[0].length - 1;
      const plus = l.split(' ').slice(1).find((w) => w.startsWith('+'));
      line = plus ? parseInt(plus.slice(1), 10) || 0 : 0;
      inHunk = true;
      return;
    }
    if (!inHunk || l.startsWith('\\')) return; // "\ No newline at end of file"
    const prefix = l.slice(0, parents);
    if (prefix.length < parents || !/^[-+ ]+$/.test(prefix)) { inHunk = false; return; }
    if (prefix.includes('-')) return;
    if (/^\++$/.test(prefix) && path !== '') add(l.slice(parents), { commit, path, line });
    line++;
  });
}

function unreadable(shown, err) {
  return invalid('file-unreadable', `cannot read ${shown} (${err.code ?? err.message})`, 'make it readable (or ignore it if it does not belong in the repository), then scan again');
}
// The text of a regular file (latin1), or null: gone, not a regular file (a link, a submodule), binary.
function readText(abs, shown, st) {
  let s = st;
  if (!s) {
    try { s = lstatSync(abs); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw unreadable(shown, err);
    }
  }
  if (!s.isFile()) return null;
  let buf;
  try { buf = readFileSync(abs); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw unreadable(shown, err);
  }
  if (buf.subarray(0, BINARY_PROBE).includes(0)) return null;
  return buf.toString('latin1');
}

function scanText(ctx, text, path, { marker }) {
  ctx.files++;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((l, k) => scanLine(ctx, l, { commit: null, path, line: k + 1 }, { marker }));
}
function scanLine(ctx, text, at, { marker = true } = {}) {
  ctx.lines++;
  const m = matchLine(text, ctx.extra);
  if (!m || (marker && isSynthetic(text))) return;
  ctx.add({ ...at, type: m.id, masked: Buffer.from(mask(m.text), 'latin1').toString('utf8') });
}
const keyFile = (ctx, path, commit = null) => ctx.add({ commit, path, line: null, type: 'key-file', masked: null });

// The project patterns of <state dir>/secrets-patterns.txt; none when the file is absent. Read directly (writes are
// lib/state's), never through a link.
function readPatterns(where) {
  const file = join(where.dir, PATTERN_FILE);
  const rel = relative(where.repo, file);
  const shown = rel && !rel.startsWith('..') ? rel.split('\\').join('/') : file;
  const refuse = (why) => invalid('patterns-unreadable', `cannot read the project patterns ${shown}: ${why}`, `fix ${shown} (one pattern per line) or remove it, then scan again`);
  let st;
  try { st = lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw refuse(err.code ?? err.message);
  }
  if (!st.isFile()) throw refuse(st.isSymbolicLink() ? 'a symbolic link' : 'not a regular file');
  if (st.size > PATTERN_FILE_MAX) throw refuse(`larger than ${PATTERN_FILE_MAX / 1024} KB`);
  let text;
  try { text = readFileSync(file, 'latin1'); } catch (err) { throw refuse(err.code ?? err.message); }
  const { patterns, errors } = projectPatterns(text);
  if (errors.length) throw invalid('bad-pattern', `${shown}:${errors[0].line}: ${errors[0].message}`, 'fix that pattern (a JS regular expression with POSIX classes, as in guard-extra.txt) or remove the line');
  return patterns;
}

function scanTree(ctx) {
  const listed = runGit(ctx, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = [...new Set(listed.split('\0').filter(Boolean))];
  const odd = paths.find((p) => p.includes('\ufffd'));
  if (odd !== undefined) throw invalid('path-not-utf8', `a file name is not UTF-8 (${odd}), so it cannot be read by its name`, 'rename it to a UTF-8 name, then scan again');
  for (const p of paths) if (isKeyFile(p)) keyFile(ctx, p);
  for (const p of paths) {
    if (skipsContent(p)) continue;
    const text = readText(join(ctx.repo, p), p);
    if (text !== null) scanText(ctx, text, p, { marker: true });
  }
  addedLines(fileLines(gitToFile(ctx, ['diff', '-R', ...DIFF, '--'])), (l, at) => { if (!skipsContent(at.path)) scanLine(ctx, l, at); });
}

function scanStaged(ctx) {
  const added = readOutput(gitToFile(ctx, ['diff', '--cached', '--name-only', '-z', '--diff-filter=AR', '-M', '--']));
  for (const p of added.split('\0')) if (p && isKeyFile(p)) keyFile(ctx, p);
  addedLines(fileLines(gitToFile(ctx, ['diff', '--cached', ...DIFF, '--'])), (l, at) => { if (!skipsContent(at.path)) scanLine(ctx, l, at); });
}

function scanRange(ctx, revs) {
  // -z: "\x01<sha>" ends with a NUL, then a newline and the NUL-terminated names of that commit.
  let commit = null;
  for (const token of readOutput(gitToFile(ctx, ['log', '--format=%x01%H', '--name-only', '-z', '--diff-filter=AR', '-M', '--root', ...revs, '--'])).split('\0')) {
    const t = token.startsWith('\n') ? token.slice(1) : token;
    if (t.charCodeAt(0) === 1) commit = t.slice(1, 1 + SHA_SHOWN);
    else if (t && isKeyFile(t)) keyFile(ctx, t, commit);
  }
  const scan = (l, at) => { if (!skipsContent(at.path)) scanLine(ctx, l, at); };
  addedLines(fileLines(gitToFile(ctx, ['log', '--no-merges', '--format=%x01%H', '-p', '--root', ...DIFF, ...revs, '--'])), scan);
  addedLines(textLines(runGit(ctx, ['log', '--merges', '--format=%x01%H', '--cc', ...DIFF, ...revs, '--'])), scan);
}

function scanArtifact(ctx, given) {
  const abs = resolvePath(ctx.cwd, given);
  const top = given.length > 1 ? given.replace(/\/+$/, '') : given;
  let st;
  try { st = statSync(abs); } catch (err) {
    throw invalid('artifact-missing', `cannot read the artifact ${given} (${err.code ?? err.message})`, 'build it first, or pass the path of a built file or directory');
  }
  const visit = (path, shown, s) => {
    if (s.isDirectory()) {
      let entries;
      try { entries = readdirSync(path).sort(); } catch (err) { throw unreadable(shown, err); }
      for (const e of entries) {
        let es;
        try { es = lstatSync(join(path, e)); } catch (err) { throw unreadable(`${shown}/${e}`, err); }
        visit(join(path, e), `${shown}/${e}`, es);
      }
      return;
    }
    if (!s.isFile()) return; // a link inside the artifact is not followed
    if (isKeyFile(shown)) keyFile(ctx, shown);
    const text = readText(path, shown, s);
    if (text !== null) scanText(ctx, text, shown, { marker: false });
  };
  visit(abs, top, st);
}

const whereOf = (f) => `${f.commit ? `${f.commit}:` : ''}${f.path}${f.line ? `:${f.line}` : ''}`;
const byPlace = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0));

// One scan: { mode, findings: [{ where, path, line, commit, type, masked }], scanned: { files, lines } }. opts: cwd,
// env, names, mode (tree, staged, range, artifact), revs (the words of a range), artifact (a path relative to cwd).
export function scanSecrets({ cwd, env, names, mode = 'tree', revs = [], artifact } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown scan mode ${mode}`);
  let where;
  try {
    where = resolve({ cwd, env, names });
  } catch (err) {
    if (err instanceof StateError || typeof err?.code !== 'string') throw err;
    throw invalid('state-unreadable', `cannot resolve the repository state (${err.code})`, 'check the machine data directory of the plugin');
  }
  const extra = readPatterns(where);
  let tmp;
  try { tmp = mkdtempSync(join(tmpdir(), 'secrets-')); } catch (err) {
    throw invalid('temp-unavailable', `cannot create a temporary directory (${err.code ?? err.message})`, 'check TMPDIR');
  }
  const found = new Map();
  const ctx = {
    repo: where.repo, cwd, env, extra, tmp, outputs: 0, files: 0, lines: 0,
    add: (f) => { const w = whereOf(f); if (!found.has(w)) found.set(w, { where: w, ...f }); },
  };
  try {
    if (mode === 'tree') scanTree(ctx);
    else if (mode === 'staged') scanStaged(ctx);
    else if (mode === 'range') scanRange(ctx, revs);
    else scanArtifact(ctx, artifact);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const findings = [...found.values()].sort(byPlace); // stable: one place in several commits keeps git log's order
  return { mode, findings, scanned: { files: ctx.files, lines: ctx.lines } };
}
