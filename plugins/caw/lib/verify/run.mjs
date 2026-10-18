// `verify <task> [--ci]` (spec §7.6, §8.4, SD-15, SD-16, GC3): the outcome gates, recomputed from the repository and
// never from what the model wrote. Every check is anchored in something the agent cannot edit in the same breath
// (review r1): git history, the gates run here, the tree they ran on.
//   1. Gates from profile.json; none → fail `no-gates` with the candidates a scan detects. Without a gate of kind
//      test the task needs an active gate-change decision (a docs-only repository).
//   2. The task's base commit must exist here (`base-missing` otherwise, for every class): it anchors the baseline
//      and the route.
//   3. Every gate re-run (gates.mjs); the output tails go to local/verify/<id>.log, never into committed state.
//   4. The inventory: each test gate's output through the reporter collectors; the generic scan when an output is no
//      report (or there is no test gate). A test gate read only by the generic scan is weak: reported, and always
//      refused for a critical task (review r2 D4; no decision waives it). Focused tests (.only, fit) fail.
//   5. The reference: the accepted inventory as of the anchor (the task base; the target tip for a merge; stateAt) united
//      with the working baseline file, which can only add. The working baseline counts only while it describes the code
//      verified: its head is the anchor or an ancestor of it or of the verified HEAD (in a merge: of the tip or the
//      merged branch); one collected on a parallel branch (worktrees share the state) is no reference here. As of the
//      anchor: with the state directory in the repository, the baseline committed there; with a state directory outside
//      the repository (linked), which no commit holds and no branch writes, the store's baseline when it describes the
//      code. Without such a baseline (r2 D5) the working baseline is accepted only when the change touches no test
//      file, so the inventory still is the anchor's; else, or with a missing or malformed baseline at an anchor whose
//      history has one, `baseline-unanchored`. Another collector cannot be compared. Removed and newly skipped tests need an allowance. A failing test gate is excused only when every failure it reports is pinned and the reporter
//      counts no more failures than were collected; a new failure fails even when its gate exited 0.
//   6. The route re-classified from `git diff --numstat <base>` plus untracked files, the state directory left out
//      (the lib/router ratchet: the class only rises); the report's RED/GREEN evidence; the
//      approved review the route needs (artifacts.mjs).
//   7. verify.json written, also on failure, so a stale pass never survives; it binds gatesSha (the gates run) and
//      baselineSha (the working baseline after the run). On pass the baseline becomes this inventory (growth,
//      allowed removals and skips, failures still pinned), written only when it changed.
// Result: the first that applies of error (a gate could not run; exit 8) · fail · baseline-shrunk · route-escalated ·
// missing-artifact (exit 1); else pass (exit 0). Every reason is reported.
// head: HEAD when the code has no uncommitted change, else null (such a run verified no commit). The code is the
// working tree without verify's and the task's own outputs (local/, tasks/*/verify.json, tasks/*/task.json,
// baseline/tests.json) and the typed review records (tasks/*/review-r*.json), which `task done` binds by value
// instead (class, baselineSha, the latest review round).
// Modes: write (default; the task's owner only) · ci (--ci: nothing written, no owner needed) · merge (task merge:
// the outcome gates against the target tip, without route and review; nothing written).
// The code is the worktree's (lib/state resolve: `worktree`, the git top level of the current directory): the gates run
// there, its HEAD is verified and its change against the base classified; the state is the project's (a linked worktree
// shares the state of its main checkout). State paths in git pathspecs are tree paths (relative to the project root,
// the same in every checkout); state paths in messages are shown relative to the worktree, or absolute outside it.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorHandle, readRecords, stateRel } from '../decisions/index.mjs';
import { git } from '../git/index.mjs';
import { PROFILE_KINDS, emptyProfile, listFiles, observe } from '../profile/index.mjs';
import { MAX_PATHS, addedSteps, applyClass, classify, rank, recordedKeys, routeFor, routeTask } from '../router/index.mjs';
import { KINDS, StateError, check, open, resolve } from '../state/index.mjs';
import { readReport, reportHasEvidence, reviewNeed, reviewState } from './artifacts.mjs';
import { baselineSha, compareInventory, excusable, fingerprint, referenceOf, splitFailures } from './baseline.mjs';
import { runGate, tailLines } from './gates.mjs';
import { byCodeUnit, hashOf } from './inventory.mjs';
import { VERIFY_KINDS } from './kinds.mjs';
import { parseReport } from './reporters.mjs';
import { SKIP_DIRS, scanRepo, scannerOf } from './scan.mjs';

const SOURCE_MAX = 1024 * 1024;
const COUNT_MAX = 8 * 1024 * 1024;
const LEVELS = ['error', 'fail', 'baseline-shrunk', 'route-escalated', 'missing-artifact'];
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

const now = () => new Date().toISOString();
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const envError = (code, message, hint = '') => new StateError(code, 'ENV', message, { hint });
const some = (list, n = 5) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} (+${list.length - n} more)`);

export const storeOf = (where, names) => open(where.dir, { names, kinds: { ...KINDS, ...PROFILE_KINDS, ...VERIFY_KINDS } });
export const unknownTask = (id, where, names) => usage('task-unknown', `no task ${id} in ${where.dir}`, `'${names.bin} task list' lists the tasks`);
// The identity of a gate set: what verify ran, in order.
export const gatesSha = (gates) => hashOf(JSON.stringify(gates.map((g) => [g.name, g.cmd, g.timeoutS, g.kind])));
// The sha256 of the working baseline's content (null without one), recomputed: an edit that keeps the field shows.
export const workingSha = (store) => {
  const doc = store.read('baseline', null);
  return doc === null ? null : baselineSha(doc);
};

export function activeWhere({ cwd, env, names }) {
  const where = resolve({ cwd, env, names });
  if (!where.active) throw new StateError('inactive', 'REFUSED', `${where.repo} is not active: it has no tasks`, { hint: `'${names.bin} init' activates it` });
  return where;
}

// git in the worktree (the code); git missing or failing to start is an environment problem.
export function gitIn(where, env, args) {
  const r = git(args, { cwd: where.worktree, env });
  if (r.error) throw envError('git-failed', `git ${args[0]} could not run (${r.error})`, 'install git and put it on PATH');
  return r;
}

export const commitExists = (where, env, sha) => Boolean(sha) && gitIn(where, env, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;

// The repository as verify sees it: { rel, scope, routeScope, head, dirty }. `scope` (freshness: dirty, done) is the
// working tree without verify's and the task's own outputs, and without the typed review records (exactly the review
// kind's names, review-r<1-999>.json), which `task done` reads by value inside its lock: verify → review record →
// task done needs no second verify. `routeScope` (the change the route classifies) leaves the whole state directory
// out: process records are not the code change.
const REVIEW_NAMES = ['[1-9]', '[1-9][0-9]', '[1-9][0-9][0-9]'].map((k) => `review-r${k}.json`);
export function codeState(where, env) {
  const rel = stateRel(where.repo, where.dir);
  const reviews = rel ? REVIEW_NAMES.map((n) => `:(exclude,glob)${rel}/tasks/*/${n}`) : [];
  const own = rel ? [`:(exclude)${rel}/local`, `:(exclude,glob)${rel}/tasks/*/verify.json`, `:(exclude,glob)${rel}/tasks/*/task.json`, ...reviews, `:(exclude)${rel}/${VERIFY_KINDS.baseline.path()}`] : [];
  const scope = ['--', '.', ...own];
  const routeScope = ['--', '.', ...(rel ? [`:(exclude)${rel}`] : [])];
  const h = gitIn(where, env, ['rev-parse', '--verify', '-q', 'HEAD']);
  const st = gitIn(where, env, ['status', '--porcelain', '--untracked-files=all', ...scope]);
  if (st.status !== 0) throw envError('git-failed', `git status failed in ${where.worktree}`, 'check that the repository is readable');
  return { rel, scope, routeScope, head: h.status === 0 ? h.stdout.trim() : null, dirty: st.stdout.trim() !== '' };
}

// The collector context: repository files (tracked and untracked, not ignored; never the state directory) and a
// reader that opens only those, as plain files of at most 1 MB.
export function context(where, env, rel) {
  let files = null;
  let known = null;
  const list = () => (files ??= listFiles(where.worktree, { env, exclude: rel }).filter((f) => !SKIP_DIRS.test(f)));
  const read = (path) => {
    known ??= new Set(list());
    if (!known.has(path)) return null;
    try {
      const file = join(where.worktree, path);
      const st = lstatSync(file);
      return st.isFile() && st.size <= SOURCE_MAX ? readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  };
  return { repo: where.worktree, files: list, read };
}

export function inventoryOf(runs, ctx) {
  const tests = runs.filter((r) => r.kind === 'test');
  const parts = [];
  let weak = false;
  let scan = tests.length === 0;
  for (const run of tests) {
    const inv = parseReport(run.output, ctx);
    if (inv) parts.push({ ...inv, run });
    else { scan = true; weak = true; }
  }
  if (scan) parts.push({ ...scanRepo(ctx), run: null });
  const byId = new Map();
  for (const p of parts) {
    for (const t of p.tests) {
      const cur = byId.get(t.id);
      byId.set(t.id, cur ? { ...cur, skipped: cur.skipped && t.skipped, focused: cur.focused || t.focused } : t);
    }
  }
  const collector = [...new Set(parts.map((p) => p.collector))].sort(byCodeUnit).join('+');
  return { collector, tests: [...byId.values()].sort((a, b) => byCodeUnit(a.id, b.id)), parts, weak };
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

// Whether the baseline `doc` describes code that descends from `commits`: its head is one of them or an ancestor of
// one (a baseline collected before the first commit, head null, precedes every commit).
function describes(where, env, doc, commits) {
  if (!doc) return false;
  if (doc.head === null) return true;
  return commits.some((c) => c && gitIn(where, env, ['merge-base', '--is-ancestor', doc.head, c]).status === 0);
}

// The accepted inventory as of `commit`: { doc, problem }. In-repo state: the baseline committed there, problem
// 'missing' or 'malformed' when the commit's history has a baseline but the commit has no valid one (review r1 #3).
// Linked state: `working`, the store's baseline when it describes the code verified (else null).
function anchorAt(where, env, commit, working) {
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

// The change since `base` (committed, uncommitted and untracked; the state directory left out), or null
// when git cannot diff against it.
function changeSince(where, env, base, scope) {
  const d = gitIn(where, env, ['diff', '--numstat', '-z', '--no-renames', base, ...scope]);
  if (d.status !== 0) return null;
  const paths = new Set();
  let loc = 0;
  for (const rec of d.stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    paths.add(m[3]);
    if (m[1] !== '-') loc += Number(m[1]) + Number(m[2]);
  }
  const u = gitIn(where, env, ['ls-files', '-z', '--others', '--exclude-standard', ...scope]);
  for (const p of u.status === 0 ? u.stdout.split('\0').filter(Boolean) : []) {
    if (paths.has(p)) continue;
    paths.add(p);
    loc += lineCount(join(where.worktree, p));
  }
  return { paths: [...paths].filter((p) => !UNSAFE_PATH.test(p)).slice(0, MAX_PATHS), loc };
}

// The paths a merge in progress brings onto the target tip (the index against the tip), the state directory left out.
function mergeChange(where, env, tip, scope) {
  const d = gitIn(where, env, ['diff', '--cached', '--name-only', '-z', tip, ...scope]);
  return d.status === 0 ? { paths: d.stdout.split('\0').filter(Boolean), loc: 0 } : null;
}

// { route (verify.json), flags } after re-classifying the change; writes the ratchet in write mode.
function reroute({ store, task, id, write, handle, riskPaths, change, at }) {
  const declared = task.class;
  const route = { declared, actual: declared, escalated: false, missingSteps: [] };
  let flags = recordedKeys(task).flags;
  if (change.paths.length === 0) return { route, flags };
  const plan = { paths: change.paths, loc: change.loc, flags: [], riskPaths };
  if (write) {
    const r = routeTask(store, id, { ...plan, handle, at });
    flags = recordedKeys(store.read('task', id)).flags;
    return { route: { declared, actual: r.class, escalated: r.escalated, missingSteps: [...r.addedSteps] }, flags };
  }
  const step = applyClass(task, classify(plan), { at, by: handle ?? 'verify' });
  const actual = step.next?.class ?? declared;
  const escalated = declared !== null && rank(actual) > rank(declared);
  return { route: { declared, actual, escalated, missingSteps: escalated ? [...addedSteps(declared, actual, { flags: step.flags })] : [] }, flags: step.flags };
}

// The evaluation of task `id` in a resolved, active repository: { doc (verify.json), reasons, written, candidates,
// output }. `anchor`: the commit whose baseline is the accepted inventory (merge mode: the target tip); `merged`: the
// commit a merge brings onto it (merge mode).
export function evaluate({ where, names, env, id, mode, handle = null, at = now(), anchor = null, merged = null }) {
  const started = Date.now();
  const write = mode === 'write';
  const store = storeOf(where, names);
  const task = store.read('task', id);
  if (task === null) throw unknownTask(id, where, names);
  const profile = store.read('profile', null) ?? emptyProfile();
  const code = codeState(where, env);
  const stateShown = stateRel(where.worktree, where.dir) ?? where.dir;
  const reasons = [];
  const say = (level, c, message, hint = '') => reasons.push({ level, code: c, message, hint });
  const active = readRecords(where.dir).records.map((r) => r.doc).filter((d) => d.status === 'active');
  const gateChange = active.find((d) => d.kind === 'gate-change');
  const allowedBy = new Set();
  const doc = {
    schema: VERIFY_KINDS.verify.version, task: id, head: code.dirty ? null : code.head, gatesSha: gatesSha(profile.gates), baselineSha: null,
    class: task.class, startedAt: at, durationMs: 0, gates: [],
    inventory: { collector: 'none', total: 0, added: [], removed: [], newlySkipped: [], allowedBy: [], weak: false },
    failures: { preexisting: [], new: [] }, route: { declared: task.class, actual: task.class, escalated: false, missingSteps: [] },
    artifacts: { report: false, review: 'not-required' }, result: 'pass',
  };
  let candidates = null;
  let inv = null;
  let output = [];
  const baseOk = mode === 'merge' || commitExists(where, env, task.base);
  if (!baseOk) say('fail', 'base-missing', task.base ? `the base commit ${task.base.slice(0, 12)} of ${id} is not in this repository` : `${id} has no base commit`, `record it: ${names.bin} task set ${id} dispatched --executor <e> --base <sha> (fetch it first in a shallow clone)`);
  const anchorCommit = mode === 'merge' ? anchor : baseOk ? task.base : null;
  // The change under verification: since the base (verify), or what the merge brings onto the target tip.
  const change = mode === 'merge' ? mergeChange(where, env, anchor, code.routeScope) : baseOk ? changeSince(where, env, task.base, code.routeScope) : null;
  if (baseOk && change === null && mode !== 'merge') say('fail', 'base-missing', `git cannot compare the work with the base ${task.base.slice(0, 12)}`, 'fetch the base commit, then verify again');

  if (profile.gates.length === 0) {
    candidates = observe(where.worktree, { env, exclude: code.rel }).gates;
    say('fail', 'no-gates', `the profile has no gates, so nothing can verify ${id}`, candidates.length ? `detected: ${some(candidates.map((g) => g.cmd))}; changing gates is a gate-change decision` : 'add a gate of kind test to the profile');
  } else {
    if (!profile.gates.some((g) => g.kind === 'test')) {
      if (gateChange) allowedBy.add(gateChange.id);
      else say('fail', 'no-test-gate', 'the profile has no gate of kind test', 'add one, or record a gate-change decision that waives it (a docs-only repository)');
    }
    const runs = profile.gates.map((g) => runGate(g, { cwd: where.worktree, env }));
    doc.gates = runs.map((r) => r.gate);
    output = runs.map((r) => ({ name: r.gate.name, lines: tailLines(r.output) }));
    inv = inventoryOf(runs, context(where, env, code.rel));

    const current = store.read('baseline', null);
    if (current && current.sha256 !== baselineSha(current)) {
      say('fail', 'baseline-invalid', `${stateShown}/${VERIFY_KINDS.baseline.path()} does not match its sha256: it was changed outside verify`, 'restore it from git; a new baseline needs a decision');
    }
    // the code verified descends from the anchor and HEAD (a merge: the tip and the merged branch)
    const commits = [anchorCommit, mode === 'merge' ? merged : code.head];
    const working = describes(where, env, current, commits) ? current : null;
    const anchored = anchorAt(where, env, anchorCommit, working);
    const tests = (change?.paths ?? []).filter((p) => scannerOf(p) !== null);
    if (anchored.problem) {
      say('fail', 'baseline-unanchored', `the baseline at ${anchorCommit.slice(0, 12)} is ${anchored.problem}, though its history has one: there is no accepted inventory to compare with`, 'restore the baseline on the target branch (git), or pin one with a decision');
    } else if (!anchored.doc && anchorCommit && tests.length && code.rel) {
      say('fail', 'baseline-unanchored', `no baseline is committed at ${anchorCommit.slice(0, 12)} and the change touches test files (${some(tests)}): the working baseline cannot be trusted`, `land the initial baseline in a task without test changes, or pin it on the target (${names.bin} baseline pin --decision <D>) and base the task on that commit`);
    } else if (!anchored.doc && anchorCommit && tests.length) {
      const what = current ? `the baseline in ${stateShown} was collected at ${String(current.head).slice(0, 12)}, not on the history of this code` : `no baseline is recorded in ${stateShown}`;
      say('fail', 'baseline-unanchored', `${what}, and the change touches test files (${some(tests)}): there is no accepted inventory to compare with`, `merge the branch it was collected on first, or pin one for this code (${names.bin} baseline pin --decision <D>), then verify again`);
    }
    const pinned = [anchored.doc, working].filter((b, k, all) => b && all.indexOf(b) === k);
    const other = pinned.find((b) => b.collector !== inv.collector);
    let reference = { tests: [], failing: [] };
    let cmp = { added: inv.tests.map((t) => t.id), removed: [], newlySkipped: [], allowedBy: [], unallowed: [] };
    if (other) {
      say('fail', 'collector-changed', `the baseline was collected by ${other.collector}, this run by ${inv.collector}: the inventories cannot be compared`, `restore the test gate, or pin the new inventory on the target (${names.bin} baseline pin --decision <gate-change D>) and base the task on that commit`);
    } else {
      reference = referenceOf(pinned);
      cmp = compareInventory(reference, inv, active.map((d) => ({ id: d.id, allowsTestRemoval: d.allowsTestRemoval ?? [] })));
    }
    for (const d of cmp.allowedBy) allowedBy.add(d);
    if (cmp.unallowed.length) say('baseline-shrunk', 'baseline-shrunk', `removed or skipped without a decision: ${some(cmp.unallowed)}`, 'restore them, or record a decision that lists them in allowsTestRemoval');
    const focused = inv.tests.filter((t) => t.focused).map((t) => t.id);
    if (focused.length) say('fail', 'focused', `focused tests make the others not run: ${some(focused)}`, 'remove .only, fit and fdescribe');

    doc.failures = splitFailures(reference.failing, inv.parts.flatMap((p) => p.failing.map(fingerprint)));
    const known = new Set(reference.failing);
    for (const r of runs) {
      const g = r.gate;
      if (g.result === 'error') say('error', 'gate-error', `gate ${g.name} could not run (exit ${g.exit ?? '-'})`, 'install what the gate runs, or fix its command in the profile');
      else if (g.result === 'timeout') say('fail', 'gate-timeout', `gate ${g.name} ran over its ${profile.gates.find((x) => x.name === g.name)?.timeoutS} s limit`, 'make it faster, or raise its timeoutS in the profile');
      else if (g.result === 'fail') {
        const part = inv.parts.find((p) => p.run === r);
        if (!(r.kind === 'test' && part && excusable(part, known))) say('fail', 'gate-failed', `gate ${g.name} failed (exit ${g.exit ?? '-'})`, `see its output in ${stateShown}/local/verify/${id}.log`);
      }
    }
    if (doc.failures.new.length) say('fail', 'new-failures', `new failing tests: ${some(doc.failures.new)}`, 'fix them; only failures pinned in the baseline are tolerated');
    doc.inventory = { collector: inv.collector, total: inv.tests.length, added: cmp.added, removed: cmp.removed, newlySkipped: cmp.newlySkipped, allowedBy: [], weak: inv.weak };
  }

  if (mode !== 'merge') {
    if (change) {
      const { route, flags } = reroute({ store, task, id, write, handle, riskPaths: profile.riskPaths, change, at });
      doc.route = route;
      doc.class = route.actual;
      if (route.escalated) say('route-escalated', 'route-escalated', `the change is ${route.actual}, not ${route.declared}: the route adds ${route.missingSteps.join(', ')}`, 'do the added steps, then verify again');
      if (doc.class !== null) {
        const steps = routeFor(doc.class, { flags }).steps;
        doc.artifacts.review = reviewState(store, id, steps);
        if (doc.artifacts.review === 'missing') say('missing-artifact', 'missing-artifact', `the ${doc.class} route needs an approved ${reviewNeed(steps) === 'external' ? 'cross-provider ' : ''}review of ${id}`, 'record the review (review-r<k>.json, verdict approved), then verify again');
      }
    }
    if (doc.class === null) {
      doc.artifacts.review = 'missing';
      say('fail', 'not-classified', `${id} has no class`, `classify it: ${names.bin} route ${id} --paths <p,…> --loc <n>`);
    }
  }
  if (inv?.weak && doc.class === 'critical') {
    say('fail', 'weak-collector', 'a test gate of this critical task is read only by the generic scan (no runtime results)', 'use a structured reporter: profile observe writes --test-reporter=tap for node:test, --json for Jest and Vitest');
  }
  doc.inventory.allowedBy = [...allowedBy].sort(byCodeUnit);
  doc.artifacts.report = reportHasEvidence(readReport(where.dir, id));
  if (!doc.artifacts.report) say('missing-artifact', 'missing-artifact', `${stateShown}/tasks/${id}/report.md has no RED/GREEN evidence`, 'its frontmatter needs red and green: {"command": …, "exit": …, "excerpt": …}');

  doc.result = LEVELS.find((l) => reasons.some((r) => r.level === l)) ?? 'pass';
  if (write && doc.result === 'pass' && inv) grow(store, { inv, preexisting: doc.failures.preexisting, head: code.head, at });
  doc.baselineSha = workingSha(store);
  doc.durationMs = Date.now() - started;
  if (write) {
    store.write('verify', id, doc);
    store.write('verifyLog', id, { task: id, at, gates: output });
  }
  return { doc, reasons: reasons.map(({ code: c, message, hint }) => ({ code: c, message, hint })), written: write, candidates, output };
}

// On pass the baseline is this inventory; written only when its content changed, and only over the baseline this run
// read (a concurrent verify that wrote first wins).
function grow(store, { inv, preexisting, head, at }) {
  const current = store.read('baseline', null);
  const next = { collector: inv.collector, tests: inv.tests.map(({ id, file, skipped }) => ({ id, file, skipped })), failing: preexisting };
  const sha = baselineSha(next);
  if (current?.sha256 === sha) return;
  const pinned = current?.pinnedBy ? { pinnedBy: current.pinnedBy } : {};
  store.update('baseline', null, (cur) => ((cur?.sha256 ?? null) === (current?.sha256 ?? null) ? { ...next, head, collectedAt: at, sha256: sha, ...pinned } : undefined));
}

// `verify <id> [--ci]`: the owner's verify writes; --ci only reports.
export function verifyTask({ cwd, env, names, id, ci = false, at = now() }) {
  const where = activeWhere({ cwd, env, names });
  KINDS.task.path(id);
  let handle = null;
  if (!ci) {
    const store = storeOf(where, names);
    const task = store.read('task', id);
    if (task === null) throw unknownTask(id, where, names);
    handle = authorHandle({ store, where, names, env });
    if (task.owner !== handle) {
      throw new StateError('not-owner', 'REFUSED', `${id} belongs to ${task.owner}; only its owner verifies it with writes`, { hint: `ask ${task.owner}, or check without writing: ${names.bin} verify ${id} --ci` });
    }
  }
  return evaluate({ where, names, env, id, mode: ci ? 'ci' : 'write', handle, at });
}
