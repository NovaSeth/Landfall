// Git history helpers of verify (split from run.mjs, T-MG-141): git in the worktree, the code state, the task's own change
// since its base, the baseline as of a commit and where it lies on the history.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRel } from '../decisions/index.mjs';
import { git } from '../git/index.mjs';
import { MAX_PATHS, testPath, weightless } from '../router/index.mjs';
import { StateError, check } from '../state/index.mjs';
import { baselineSha } from './baseline.mjs';
import { VERIFY_KINDS } from './kinds.mjs';

const COUNT_MAX = 8 * 1024 * 1024;
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const envError = (code, message, hint = '') => new StateError(code, 'ENV', message, { hint });

// git in the worktree (the code); git missing or failing to start is an environment problem.
export function gitIn(where, env, args) {
  const r = git(args, { cwd: where.worktree, env });
  if (r.error) throw envError('git-failed', `git ${args[0]} could not run (${r.error})`, 'install git and put it on PATH');
  return r;
}

// T-MG-192: `tip` adds no change of its own to `head` (a review's commit): no own commit, every first-parent commit in
// head..tip is a merge of commits already in `target`, and the own change (target's merge base..commit, over `scope`) is
// the same text at both (the whole tree but the state directory, submodules included; `scope` as codeState gives it): a merge of the target into the branch is no change, an edited merge is. `target`: a branch name
// or full ref, resolved to a commit. Git runs without repository-independent config, external diff or attribute sources.
export function sameChange(where, env, head, tip, target = 'main', scope = ['--', '.']) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_(CONFIG|ATTR_SOURCE|EXTERNAL_DIFF|DIFF_OPTS)/.test(k)));
  const g = (...a) => gitIn(where, { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' }, a);
  const full = target === 'HEAD' || target.startsWith('refs/') ? target : `refs/heads/${target}`;
  const into = g('rev-parse', '--verify', '-q', `${full}^{commit}`).stdout.trim();
  if (!into || g('merge-base', '--is-ancestor', head, tip).status !== 0) return false;
  const log = (...a) => g('log', '--first-parent', ...a, '--end-of-options', `${head}..${tip}`);
  const own = log('--no-merges', '--format=%H');
  const merges = log('--merges', '--format=%P');
  const change = (c) => {
    const b = g('merge-base', '--end-of-options', c, into).stdout.trim();
    const d = b ? g('-c', 'diff.external=', '-c', 'diff.ignoreSubmodules=none', '-c', 'core.attributesFile=/dev/null', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--binary', '--end-of-options', b, c, ...scope) : null;
    return d && d.status === 0 ? d.stdout : null;
  };
  const was = change(head);
  return own.status === 0 && own.stdout.trim() === '' && merges.status === 0 && was !== null && was === change(tip)
    && merges.stdout.split('\n').filter(Boolean).every((l) => l.split(' ').slice(1).every((q) => g('merge-base', '--is-ancestor', q, into).status === 0));
}

export const commitExists = (where, env, sha) => Boolean(sha) && gitIn(where, env, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;

// The repository as verify sees it: { rel, scope, routeScope, head, dirty }. `scope` (freshness: dirty, done) and
// `routeScope` (the change the route classifies) both leave the whole state directory out: the state is not code (a
// decision recorded, a report stored or a review written between verify and `task done` is no change of the code, and
// nothing the gates run reads them), so verify → decide → review record → task done needs no commit in between; the
// typed review records and the baseline are read by value inside the lock of `task done` instead. Before 2.1 only
// verify's own outputs left the scope, and every state write forced a commit before verify (156 state commits in one
// 40-task project).
export function codeState(where, env) {
  const rel = stateRel(where.repo, where.dir);
  const scope = ['--', '.', ...(rel ? [`:(exclude)${rel}`] : [])];
  const routeScope = scope;
  const h = gitIn(where, env, ['rev-parse', '--verify', '-q', 'HEAD']);
  const st = gitIn(where, env, ['status', '--porcelain', '--untracked-files=all', ...scope]);
  if (st.status !== 0) throw envError('git-failed', `git status failed in ${where.worktree}`, 'check that the repository is readable');
  return { rel, scope, routeScope, head: h.status === 0 ? h.stdout.trim() : null, dirty: st.stdout.trim() !== '' };
}

// A state file as of commit `commit` (`path` relative to the state directory): with the state directory in the
// repository, as committed there: { rel (its tree path), path, text (null: the commit has none) }; with a state
// directory outside the repository (linked) no commit holds state and no branch writes it: { rel: null } — the store's
// document stands for every commit.
export function stateAt(where, env, commit, path) {
  const rel = stateRel(where.repo, where.dir);
  if (!rel) return { rel: null };
  const shown = gitIn(where, env, ['show', `${commit}:${rel}/${path}`]);
  return { rel, path: `${rel}/${path}`, text: shown.status === 0 ? shown.stdout : null };
}

// Where the baseline `doc` lies relative to code that descends from `commits`: 'none' (no baseline) · 'line' (its head
// is one of them or an ancestor of one; head null, a baseline collected before the first commit, precedes every
// commit) · 'branch' (off the line, on another local branch) · 'off' (off the line and on no branch: a rewritten
// history) · 'unknown' (git cannot tell: the head is no commit here, or git fails). git that cannot run throws (ENV).
export function lineOf(where, env, doc, commits) {
  if (!doc) return 'none';
  if (doc.head === null) return 'line';
  let unknown = false;
  for (const c of commits.filter(Boolean)) {
    const r = gitIn(where, env, ['merge-base', '--is-ancestor', doc.head, c]);
    if (r.status === 0) return 'line';
    if (r.status !== 1) unknown = true;
  }
  if (unknown) return 'unknown';
  const branches = gitIn(where, env, ['for-each-ref', '--count=1', '--contains', doc.head, '--format=%(refname)', 'refs/heads']);
  if (branches.status !== 0) return 'unknown';
  return branches.stdout.trim() ? 'branch' : 'off';
}

// The accepted inventory as of `commit`: { doc, problem }. In-repo state: the baseline committed there, problem
// 'missing' or 'malformed' when the commit's history has a baseline but the commit has no valid one (review r1 #3).
// Linked state: `working`, the store's baseline when it describes the code verified (else null).
export function anchorAt(where, env, commit, working) {
  if (!commit) return { doc: null, problem: null };
  const at = stateAt(where, env, commit, VERIFY_KINDS.baseline.path());
  if (at.rel === null) return { doc: working, problem: null };
  if (at.text !== null) {
    try {
      const doc = JSON.parse(at.text);
      if (doc?.schema === VERIFY_KINDS.baseline.version && check(VERIFY_KINDS.baseline, doc).length === 0 && doc.sha256 === baselineSha(doc)) return { doc, problem: null };
    } catch { /* malformed */ }
    return { doc: null, problem: 'malformed' };
  }
  const history = gitIn(where, env, ['log', '-1', '--format=%H', commit, '--', at.path]);
  return { doc: null, problem: history.status === 0 && history.stdout.trim() !== '' ? 'missing' : null };
}

function lineCount(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > COUNT_MAX) return 0;
    const b = readFileSync(file);
    if (b.includes(0)) return 0;
    let n = 0;
    for (const c of b) if (c === 10) n++;
    return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return 0;
  }
}

// The integration line the task branches off, every ref of it that exists: origin's HEAD branch, origin/main,
// origin/master, a local main or master; empty when none. Several refs, because a local main may be ahead of origin
// (not pushed) or behind it (not pulled), and the work either one has is integration work, not the task's.
function integrationRefs(where, env) {
  const refs = [];
  const head = gitIn(where, env, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (head.status === 0 && head.stdout.trim()) refs.push(head.stdout.trim());
  for (const name of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (!refs.includes(name) && gitIn(where, env, ['rev-parse', '-q', '--verify', name]).status === 0) refs.push(name);
  }
  return refs;
}

// The task's own change since `base` (the state directory left out), or null when git cannot diff against it: the
// commits of the branch's own first-parent line base..HEAD, always (no ref anyone can move hides them), plus every
// commit of base..HEAD the integration line does not have (a side branch merged into the task is the task's work,
// review r1 F3), so a `git merge main` into the branch brings none of main's work into the class (retro 2026-10
// D-MG-13); a merge commit counts what it changes beyond every parent (`--cc`: a conflict resolution or an edit made
// in the merge itself). Without an integration ref every commit of base..HEAD counts: a class may rise, never fall.
// Plus the uncommitted and untracked changes; the LOC of those paths against the base. Weightless and light paths
// (lib/router) count no LOC unless they match a risk glob.
export function changeSince(where, env, base, scope, light = () => false, risky = () => false, max = MAX_PATHS) {
  const counted = (path) => risky(path) || (!weightless(path) && !light(path));
  // Total LOC also counts test files (the trivial cut); `counted` alone, without them, feeds the split rule.
  const countedAll = (path) => counted(path) || (testPath(path) && !light(path));
  const wt = gitIn(where, env, ['diff', '--name-only', '-z', 'HEAD', ...scope]);
  if (wt.status !== 0) return null;
  const paths = new Set(wt.stdout.split('\0').filter(Boolean));
  const refs = integrationRefs(where, env);
  const chain = gitIn(where, env, ['rev-list', '--first-parent', `${base}..HEAD`]);
  const rest = gitIn(where, env, ['rev-list', `${base}..HEAD`, ...(refs.length ? ['--not', ...refs] : [])]);
  if (chain.status !== 0 || rest.status !== 0) return null;
  const shas = [...new Set([...chain.stdout.split('\n'), ...rest.stdout.split('\n')].filter(Boolean))];
  for (let i = 0; i < shas.length; i += 200) {
    const own = gitIn(where, env, ['log', '--no-walk=unsorted', '--format=', '--name-only', '-z', '--cc', ...shas.slice(i, i + 200), ...scope]);
    if (own.status !== 0) return null;
    for (const p of own.stdout.split('\0').filter(Boolean)) if (!/^[0-9a-f]{40}$/.test(p)) paths.add(p);
  }
  const tracked = [...paths].filter((p) => !UNSAFE_PATH.test(p)).slice(0, max);
  let loc = 0;
  let locCode = 0;
  if (tracked.length) {
    const d = gitIn(where, env, ['diff', '--numstat', '-z', '--no-renames', base, '--', ...tracked]);
    if (d.status !== 0) return null;
    for (const rec of d.stdout.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
      if (!m || m[1] === '-' || !countedAll(m[3])) continue;
      loc += Number(m[1]) + Number(m[2]);
      if (counted(m[3])) locCode += Number(m[1]) + Number(m[2]);
    }
  }
  const u = gitIn(where, env, ['ls-files', '-z', '--others', '--exclude-standard', ...scope]);
  for (const p of u.status === 0 ? u.stdout.split('\0').filter(Boolean) : []) {
    if (paths.has(p)) continue;
    paths.add(p);
    if (countedAll(p)) {
      const n = lineCount(join(where.worktree, p));
      loc += n;
      if (counted(p)) locCode += n;
    }
  }
  // dropped / truncated (T-MG-182 r1 F1): a path left out here is not seen by whoever decides from the list (fastPlan
  // then runs the full set, failing closed)
  const safe = [...paths].filter((p) => !UNSAFE_PATH.test(p));
  return { paths: safe.slice(0, max), loc, locCode, dropped: safe.length < paths.size, truncated: safe.length > max };
}

// The paths a merge in progress brings onto the target tip (the index against the tip), the state directory left out.
export function mergeChange(where, env, tip, scope) {
  const d = gitIn(where, env, ['diff', '--cached', '--name-only', '-z', tip, ...scope]);
  return d.status === 0 ? { paths: d.stdout.split('\0').filter(Boolean), loc: 0 } : null;
}
