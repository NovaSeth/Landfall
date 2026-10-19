// Protected paths (spec §5.1, §7.13, FLW-7, PRI-8, PRI-17, SEC-3; fix round 1: prove a known-safe shape or block).
// The single list of command-owned state files (the Bash guard and the edit hook lib/hooks/edit-protect.mjs read it), the
// Bash check for commands that name the state directory, and the check for a recursive removal of a tracked top-level
// directory, of the repository itself or of another repository root.
// The state comes from lib/state through the hook (ctx.state = { dir, repo }, real paths, or null when the command's
// repository is not active). A state path is any path inside the state directory except the separate checkouts under
// local/worktrees/; paths are compared after following links on the way (real paths), globs are matched against the
// directory entries with dot entries included (dotglob, `**` as any depth). A simple command that names a state path —
// as an argument, an option value (`--x=p`, `-Xp`), a redirection target (also `>&p`), or inside a program text — passes
// only as an exact read shape (READ_ONLY, no output option, no file redirection) or as the own CLI; git passes with a
// read subcommand, and checkout / restore / clean / rm / mv are blocked when a pathspec reaches or contains the state
// directory. With the cwd unknown (after an uncertain cd) a relative path in a command that names the state is blocked.
// Tracked = a top-level directory in HEAD's tree.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { KINDS } from '../state/index.mjs';
import { MSG } from './messages.mjs';
import { why } from './tokenizer.mjs';
import { BIN, base } from './tokens.mjs';

// Command-owned files, relative to the state directory. use(bin, id): the command that writes it. A decision record
// is owned only in its frontmatter `status` (field): its body stays editable with the Edit tool. edit: the Edit tool
// may change it (the user's project rules), only Bash may not.
// The kinds of lib/state (one source) are all owned; KIND_USE names the command that writes each. A kind without an
// entry fails at load, so a new kind cannot be left unprotected.
const KIND_USE = {
  state: (bin) => `\`${bin} init\`, \`${bin} migrate\` or \`${bin} deactivate\``,
  config: (bin) => `\`${bin} flags set\` or \`${bin} config set\``,
  team: (bin) => `\`${bin} init\` or \`${bin} team add\``,
  task: (bin, id) => `\`${bin} task set ${id} <state>\``,
  tombstone: (bin, id) => `\`${bin} decisions retire ${id}\``,
  counter: (bin) => `\`${bin} task new\` or \`${bin} decisions propose\``,
};
const KIND_OWNED = Object.values(KINDS).map((k) => {
  if (!KIND_USE[k.name]) throw new Error(`guard: state kind ${k.name} has no owning command in KIND_USE`);
  return { re: k.match, rule: 'FLW-7', use: KIND_USE[k.name] };
});
export const OWNED = Object.freeze([
  ...KIND_OWNED,
  { re: /^tasks\/([^/]+)\/verify\.json$/, rule: 'FLW-7', use: (bin, id) => `\`${bin} verify ${id}\`` },
  { re: /^baseline\/tests\.json$/, rule: 'FLW-7', use: (bin) => `\`${bin} verify <task>\` or \`${bin} baseline pin --decision <D>\`` },
  { re: /^local\/loop\.json$/, rule: 'FLW-7', use: (bin) => `\`${bin} loop start|stop\` and \`${bin} tick\`` },
  { re: /^local\/gate-cache\/([^/]+)\.json$/, rule: 'FLW-7', use: (bin) => `\`${bin} verify <task>\`, which writes the gate cache (--no-cache runs the gates again)` },
  { re: /^local\/runs\/([^/]+)\.json$/, rule: 'FLW-7', use: (bin) => `\`${bin} exec\` (the run supervisor writes the record)` },
  { re: /^decisions\/([^/]+)\.md$/, rule: 'PRI-8', field: 'status', use: (bin, id) => `\`${bin} decisions supersede ${id}\` or \`${bin} decisions retire ${id}\`` },
  { re: /^guard-extra\.txt$/, rule: 'SEC-4', edit: true, use: () => 'the Edit tool, where the change is visible' },
]);
// Text that names a state file wherever the state directory lives (prescan literals, lowercase).
export const OWNED_NAMES = Object.freeze(['state.json', 'task.json', 'verify.json', 'tests.json', 'loop.json', 'guard-extra.txt', '/tombstones/', '/local/ids/', '/tasks/', '/decisions/',
  '/baseline/', '/team/', '/gate-cache/', '/runs/']);
const WORKTREES = /^local\/worktrees(\/|$)/; // separate checkouts of external executors, not state

export function ownedFile(rel) {
  for (const o of OWNED) {
    const m = o.re.exec(rel);
    if (m) return { ...o, id: m[1] ?? null };
  }
  return null;
}
// An owned file named by some tail of an absolute path (when the state directory itself cannot be resolved).
export const ownedTail = (p) => p.split(sep).some((_, k, parts) => k > 0 && ownedFile(parts.slice(k).join('/')) !== null);

// The real path of p: its nearest existing ancestor with links followed, then the rest as written.
export function realPath(p) {
  const rest = [];
  for (let dir = p; ;) {
    try { return join(realpathSync.native(dir), ...rest); } catch {
      const up = dirname(dir);
      if (up === dir) return p;
      rest.unshift(basename(dir));
      dir = up;
    }
  }
}
// rel of `file` inside `root` with '/' separators ('' for root itself), or null.
export function inside(root, file) {
  const rel = relative(root, file);
  if (rel === '') return '';
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel.split(sep).join('/');
}
// The text that names the state directory in a command: its path relative to the repository, or its absolute path.
export function stateText(state) {
  const rel = relative(state.repo ?? '/', state.dir);
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : state.dir).toLowerCase();
}

// ---------- globs ----------
const MAX_MATCHES = 256;
const GLOB = /[*?[]/;
// A bash glob segment as a predicate; without dots a pattern that does not start with '.' skips dot entries.
export function globRe(seg, { dots = false } = {}) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[' && seg.indexOf(']', i + 2) > 0) {
      const j = seg.indexOf(']', i + 2);
      const cls = seg.slice(i + 1, j);
      re += `[${cls[0] === '!' ? `^${cls.slice(1)}` : cls}]`;
      i = j;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  let rx;
  try { rx = new RegExp(`^${re}$`, 's'); } catch { why(`a glob pattern that cannot be read: ${seg.slice(0, 40)}`); }
  return dots || seg.startsWith('.') ? (e) => e !== '.' && e !== '..' && rx.test(e) : (e) => !e.startsWith('.') && rx.test(e);
}
// The paths a glob path names on disk (each glob segment matched against the directory entries).
function expand(abs, { dots = false } = {}) {
  let paths = [sep];
  for (const seg of abs.split(sep).filter(Boolean)) {
    if (!GLOB.test(seg)) { paths = paths.map((p) => join(p, seg)); continue; }
    const match = globRe(seg, { dots });
    const next = [];
    for (const p of paths) {
      let entries = [];
      try { entries = readdirSync(p); } catch { continue; }
      for (const e of entries) if (match(e)) next.push(join(p, e));
      if (next.length > MAX_MATCHES) why('a glob that matches too many paths to check');
    }
    paths = next;
  }
  return paths;
}
// A glob in a prescan word that could reach the state directory: a segment matching its name (dot entries included),
// a `**`, or a brace alternative naming it.
export function globReaches(text, name) {
  const lower = name.toLowerCase();
  for (const word of text.split(/\s+/)) {
    const alts = /\{[^{}]*,[^{}]*\}/.test(word) ? word.replace(/^(.*?)\{([^{}]*)\}(.*)$/, (_, a, b, c) => b.split(',').map((x) => a + x + c).join(' ')).split(' ') : [word];
    for (const w of alts) {
      if (w.toLowerCase().split('/').includes(lower)) return true;
      for (const seg of w.split('/')) if (GLOB.test(seg) && (seg.includes('**') || safeTest(seg, name))) return true;
    }
  }
  return false;
}
const safeTest = (seg, name) => { try { return globRe(seg, { dots: true })(name); } catch { return true; } };

// ---------- Bash: commands that name the state directory ----------
const WRITE_OPS = /^(>|>>|>\||<>|&>|&>>)$/;
// A redirection that writes a file: >, >>, >|, <>, &>, &>> and `>& file` (not a descriptor duplication >&N, >&-).
export const writeRedir = (r) => (WRITE_OPS.test(r.op) || (r.op === '>&' && !/^(\d+|-)$/.test(r.target))) && r.target !== '/dev/null';
const safeRedir = (r) => !writeRedir(r) && r.op !== '<>';
// Exact read shapes: the program reads the paths it is given and writes none; the option patterns that would write
// or run a program are excluded.
const READ_ONLY = new Map(Object.entries({
  cat: null, head: null, tail: null, wc: null, ls: null, stat: null, file: /^(-[a-zA-Z]*C|--compile)/, grep: null, egrep: null, fgrep: null,
  rg: /^(--pre|--replace|-[a-zA-Z]*r)/, jq: /^(-[a-zA-Z]*i|--in-place)/, diff: null, cmp: null, echo: null, printf: null, test: null, '[': null, '[[': null,
  cd: null, pushd: null, popd: null,
}));
function readShape(c, w) {
  if (c.redirs.some((r) => !safeRedir(r))) return false;
  const b = base(w[0]);
  if (!READ_ONLY.has(b)) return false;
  const deny = READ_ONLY.get(b);
  return !deny || !w.slice(1).some((t) => deny.test(t));
}
// Words a path can hide in: the word, the value of name=value / --option=value, a glued short option value (-Xpath).
const candidates = (t) => [...(t.startsWith('-') ? [] : [t]), ...(t.includes('=') ? [t.slice(t.indexOf('=') + 1)] : []), ...(/^-[A-Za-z][^-=]/.test(t) ? [t.slice(2)] : [])];

// The state path a path word reaches ({ rel, owned }), or null; a glob is matched against the entries (dot entries
// included, `**` as any depth below its fixed part). An unknown cwd with a relative word in a command that names the
// state has no proof.
function stateTarget(t, ctx, glob) {
  const abs = ctx.inDir(ctx.cwd, t);
  if (abs === null) {
    if (ctx.stateHit && t !== '' && !t.startsWith('-')) why('the directory is unknown (an uncertain cd) in a command that names the state directory');
    return null;
  }
  const reach = (p) => {
    const rel = inside(ctx.state.dir, realPath(p));
    return rel === null || WORKTREES.test(rel) ? null : { rel, owned: ownedFile(rel) };
  };
  if (!glob || !GLOB.test(t)) return reach(abs);
  const parts = abs.split(sep);
  const k = parts.findIndex((s) => GLOB.test(s));
  const fixed = parts.slice(0, k).join(sep) || sep;
  if (parts.slice(k).some((s) => s.includes('**')) && inside(fixed, ctx.state.dir) !== null) return { rel: '', owned: null };
  for (const p of expand(abs, { dots: true })) { const hit = reach(p); if (hit) return hit; }
  return reach(fixed); // a glob whose fixed part lies in the state directory names it, whatever matches now
}
const shown = (state, rel) => join(stateText(state) === state.dir.toLowerCase() ? state.dir : relative(state.repo, state.dir), rel);

// Bash (spec §7.13): a write redirection to a state path; any other simple command that names one and is not an exact
// read shape, the own CLI or a git read. args false: only the redirections (a wrapper; its command is checked as its
// own simple command). Result: the deny reason or null.
export function stateWrite(c, w, ctx, { args = true } = {}) {
  const st = ctx.state;
  if (!st) return null;
  const reason = (hit) => MSG.stateFile(shown(st, hit.rel), hit.owned, BIN);
  for (const r of c.redirs) {
    if (!writeRedir(r)) continue;
    const hit = stateTarget(r.target, ctx, r.glob);
    if (hit) return reason(hit);
  }
  if (!args || !w.length || w[0] === BIN) return null;
  const b = base(w[0]);
  if (b === 'git' || /^git-[a-z]/.test(b)) return gitState(w, ctx);
  const text = stateText(st);
  let hit = null;
  for (const word of c.words.slice(1)) {
    const vs = candidates(word.text);
    for (const v of vs) { hit = stateTarget(v, ctx, word.glob); if (hit) break; }
    // the state named inside a program text (sed 'w …', awk '… > "…"', node -e …), not as a path
    if (!hit && word.text.toLowerCase().includes(text) && !vs.some((v) => ctx.inDir(ctx.cwd, v) !== null && inside(st.dir, realPath(ctx.inDir(ctx.cwd, v))) !== null)) hit = { rel: '', owned: null };
    if (hit) break;
  }
  const inState = ctx.cwd !== null ? inside(st.dir, realPath(ctx.cwd)) : null;
  if (!hit && inState !== null && !WORKTREES.test(inState)) hit = { rel: inState, owned: null };
  return hit && !readShape(c, w) ? reason(hit) : null;
}

// git: checkout / restore / clean / rm / mv with a pathspec that reaches or contains the state directory (a glob or
// pathspec magic counts, quoted or not; `git clean` without a path means the working directory); another subcommand
// that names a state path passes only when it reads. `git restore --staged|-S` without `--worktree|-W` (any spelling
// that may mean it) changes only the index and passes (findings-r2 A-m1).
const GIT_REWRITE = new Set(['checkout', 'restore', 'clean', 'rm', 'mv']);
const indexOnly = (opts) => opts.some((a) => a === '--staged' || /^-[pqmS]*S[pqmS]*$/.test(a)) && !opts.some((a) => /^--w/.test(a) || /^-[^-]*W/.test(a));
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'add', 'ls-files', 'blame', 'grep', 'commit']);
function gitState(w, ctx) {
  const ws = base(w[0]) === 'git' ? w : ['git', base(w[0]).slice(4), ...w.slice(1)];
  let k = 1;
  const global = [];
  while (k < ws.length && ws[k].startsWith('-')) { global.push(ws[k]); if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(ws[k])) global.push(ws[++k]); k++; }
  const sub = ws[k]; const args = ws.slice(k + 1);
  const dashes = args.indexOf('--');
  const paths = args.filter((a, j) => (dashes >= 0 && j > dashes) || (!a.startsWith('-') && j !== dashes));
  const st = ctx.state;
  // a pathspec reaches the state (a path inside it) or contains it (an ancestor: `.`, the repository)
  const reaches = (q) => { const r = realPath(q); const rel = inside(st.dir, r); return (rel !== null && !WORKTREES.test(rel)) || inside(r, st.dir) !== null; };
  const touches = (p) => {
    if (p.startsWith(':')) return true; // pathspec magic: no proof
    const abs = ctx.inDir(ctx.cwd, p);
    if (abs === null) { if (ctx.stateHit) why('the directory is unknown (an uncertain cd) for a git pathspec'); return false; }
    if (!GLOB.test(p)) return reaches(abs);
    const parts = abs.split(sep);
    if (p.includes('**')) return reaches(parts.slice(0, parts.findIndex((x) => GLOB.test(x))).join(sep) || sep);
    return expand(abs, { dots: true }).some(reaches);
  };
  if (GIT_REWRITE.has(sub)) {
    if (sub === 'clean' && args.some((a) => /^(-[a-zA-Z]*n|--dry-run)$/.test(a))) return null;
    if (sub === 'restore' && indexOnly(dashes >= 0 ? args.slice(0, dashes) : args)) return null;
    const targets = paths.length ? paths : sub === 'clean' ? ['.'] : [];
    if (targets.length && global.some((g) => g === '-C' || /^--(git-dir|work-tree)/.test(g))) why(`git ${sub} in another directory: its pathspecs cannot be placed`);
    const hit = targets.find(touches);
    return hit === undefined ? null : MSG.stateGit(sub, hit, BIN);
  }
  const named = args.flatMap(candidates).find((a) => stateTarget(a, ctx, GLOB.test(a)));
  if (named === undefined || (GIT_READ.has(sub) && !args.some((a) => /^--output(=|$)/.test(a)))) return null;
  return MSG.stateGit(sub ?? '', named, BIN);
}

// ---------- Bash: recursive removal of tracked top-level directories ----------
// The reason a recursive removal of one target is blocked, or null. word: { text, glob } of the tokenizer.
export function removal(word, ctx) {
  const t = word.text;
  if (/^~/.test(t)) why(`a path starting with ${t.split('/')[0]}`);
  const abs = ctx.inDir(ctx.cwd, t);
  if (abs === null) why('the directory of a recursive removal is unknown');
  const paths = word.glob ? expand(abs) : [abs];
  const top = ctx.cwd === null ? null : ctx.repoTop(ctx.cwd);
  for (const p of paths) {
    const parent = dirname(p);
    let realParent;
    try { realParent = realpathSync.native(parent); } catch { continue; } // nothing there to remove
    const real = parent === p ? parent : join(realParent, basename(p));
    if (top && (real === top || top.startsWith(real.endsWith(sep) ? real : real + sep))) return MSG.removeTracked(t, 'the repository itself or a directory above it');
    if (existsSync(join(real, '.git'))) return MSG.removeTracked(t, 'a repository root or worktree (a worktree: `git worktree remove`)');
    const own = ctx.repoTop(realParent);
    if (own && own === realParent && ctx.trackedRoots(own).has(basename(real))) return MSG.removeTracked(t, 'a tracked top-level directory');
  }
  // a glob that names every entry of the repository or of a tracked top-level directory empties it (rm -rf src/*)
  if (word.glob && paths.length) {
    const dir = realPath(dirname(paths[0]));
    const own = ctx.repoTop(dir);
    if (own && (dir === own || (dirname(dir) === own && ctx.trackedRoots(own).has(basename(dir))))) {
      const named = new Set(paths.map((p) => basename(p)));
      let entries = [];
      try { entries = readdirSync(dir).filter((e) => !e.startsWith('.')); } catch { /* gone */ }
      if (entries.length && entries.every((e) => named.has(e))) return MSG.removeTracked(t, 'every entry of a tracked top-level directory or of the repository');
    }
  }
  return null;
}

// rm with -r / -R / --recursive (any spelling, options until --): each target. Result: the reason or null.
export function removeShape(c, ctx) {
  let recursive = false;
  let opts = true;
  const targets = [];
  for (const word of c.words.slice(1)) {
    const t = word.text;
    if (opts && t === '--') { opts = false; continue; }
    if (opts && /^-[^-]/.test(t)) { if (/[rR]/.test(t)) recursive = true; continue; }
    if (opts && t.startsWith('--')) { if (t.length >= 3 && '--recursive'.startsWith(t)) recursive = true; continue; }
    targets.push(word);
  }
  if (!recursive) return null;
  for (const word of targets) { const v = removal(word, ctx); if (v) return v; }
  return null;
}

// find … -delete, or -exec / -execdir / -ok rm …, removes from each start path (default `.`), whatever the filters:
// each start path is a removal target.
const FIND_GLOBAL = /^-(H|L|P|E|X|s|x|d|O\d*|D)$/;
export function findDeleteShape(c, ctx) {
  const w = c.words.map((x) => x.text);
  const k = w.findIndex((t) => /^-(exec|execdir|ok|okdir)$/.test(t));
  if (!w.includes('-delete') && !(k > 0 && base(w[k + 1] ?? '') === 'rm')) return null;
  const starts = [];
  for (const word of c.words.slice(1)) {
    if (FIND_GLOBAL.test(word.text)) continue;
    if (/^[-(!]/.test(word.text)) break;
    starts.push(word);
  }
  for (const word of starts.length ? starts : [{ text: '.', glob: false }]) { const v = removal(word, ctx); if (v) return v; }
  return null;
}
