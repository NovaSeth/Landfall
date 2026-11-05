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
//      with the working baseline file, which can only add, and with the task's own last passing verify inventory
//      (verify.json inventory.tests: a test the task verified and then removes is removed, whatever replaced the
//      shared baseline). Worktrees share the state, so the working baseline is placed on the history (lineOf): it is
//      on the line of the code verified when its head is the anchor or an ancestor of it or of the verified HEAD (in
//      a merge: of the tip or the merged branch). In-repo state: it counts unless it lies on another live branch (a
//      parallel worktree's verify), so where git cannot tell and after a rewritten history it still counts; the
//      accepted inventory is the baseline committed at the anchor. A state directory outside the repository (linked),
//      which no commit holds and no branch writes: the store's baseline is the anchor only on the line of the code.
//      Where no stored baseline describes the anchor (linked: none, off the line, or git cannot tell; in-repo: none
//      committed at the anchor and the change touches test files), the accepted inventory is measured at the anchor
//      (base.mjs: the test gates in a temporary detached worktree); a gate that cannot run there is an error, never a
//      pass. A missing or malformed baseline at an anchor whose history has one is `baseline-unanchored`. Another
//      collector cannot be compared. Removed and newly skipped tests need an allowance. A failing test gate is excused
//      only when every failure it reports is pinned and the reporter counts no more failures than were collected; a
//      new failure fails even when its gate exited 0.
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
import { authorHandle, readRecords, stateRel } from '../decisions/index.mjs';
import { PROFILE_KINDS, emptyProfile, listFiles, observe, riskGlobsOf } from '../profile/index.mjs';
import { lightMatcher, riskMatcher } from '../router/classify.mjs';
import { reroute, routeFor, routerThresholds } from '../router/index.mjs';
import { KINDS, StateError, gatesShaOf, isTrusted, open, resolve } from '../state/index.mjs';
import { appliedTier, readReport, reportHasEvidence, reviewNeed, reviewProblem, reviewState } from './artifacts.mjs';
import { measureAt } from './base.mjs';
import { baselineSha, compareInventory, excusable, fingerprint, referenceOf, splitFailures } from './baseline.mjs';
import { fastPlan, testGates } from './fast.mjs';
import { cacheKey, lookup, machineKey, store as storeRuns, treeOf } from './gate-cache.mjs';
import { logLines, requireTrustedGates } from './gates.mjs';
import { codeHealth } from './health.mjs';
import { runHeavy } from './heavy.mjs';
import { cacheState, measure } from './measure.mjs';
import { readProjectPatterns, runRedacted } from './redact.mjs';
import { SOURCE_MAX, context, inventoryOf } from './collect.mjs';
import { anchorAt, changeSince, codeState, commitExists, gitIn, lineOf, mergeChange } from './history.mjs';
import { byCodeUnit } from './inventory.mjs';
import { VERIFY_KINDS } from './kinds.mjs';
import { detectRenames, idFiles } from './rename.mjs';
import { scannerOf } from './scan.mjs';
import { taskWhere } from './where.mjs';

const LEVELS = ['error', 'fail', 'baseline-shrunk', 'route-escalated', 'missing-artifact'];
const now = () => new Date().toISOString();
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const some = (list, n = 5) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} (+${list.length - n} more)`);

export const storeOf = (where, names) => open(where.dir, { names, kinds: { ...KINDS, ...PROFILE_KINDS, ...VERIFY_KINDS } });
export const unknownTask = (id, where, names) => usage('task-unknown', `no task ${id} in ${where.dir}`, `'${names.bin} task list' lists the tasks`);
// The identity of a gate set: what verify ran, in order.
export const gatesSha = gatesShaOf;
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

// The evaluation of task `id` in a resolved, active repository: { doc (verify.json), reasons, written, candidates,
// output, reused (the time of the gate runs reused from the gate cache, else null) }. `anchor`: the commit whose
// baseline is the accepted inventory (merge mode: the target tip); `merged`: the commit a merge brings onto it (merge
// mode). `version`: the plugin version (part of the gate cache key); `cache` false runs the gates whatever is stored.
// memo (a batch gate run, T-MG-80 fix round 1): one object shared by the evaluations of the tasks of one integrated tree;
// the gate runs and the base measurement of the first are reused by the others, so the suite runs once and each task is
// checked against that inventory with its own report, baseline and class.
// publish (merge mode, fix round 2 F1): the gate-cache entry of this run is not stored here but returned as a function;
// the caller calls it only after it confirmed that the tree held during the gates, so a rejected run leaves no entry.
// Other modes store it at once (null is returned).
// full (T-MG-182): the whole profile gate set in write and ci mode too; else verify runs the fast subset of the change
// (fast.mjs) where it can. Merge mode always runs the full set: the only full run per task.
export function evaluate(opts) {
  const s = begin(opts);
  if (s.profile.gates.length === 0) {
    s.candidates = observe(s.where.worktree, { env: s.env, exclude: s.code.rel }).gates;
    s.say('fail', 'no-gates', `the profile has no gates, so nothing can verify ${s.id}`, s.candidates.length ? `detected: ${some(s.candidates.map((g) => g.cmd))}; changing gates is a gate-change decision` : 'add a gate of kind test to the profile');
  } else {
    if (!s.profile.gates.some((g) => g.kind === 'test')) {
      if (s.gateChange) s.allowedBy.add(s.gateChange.id);
      else s.say('fail', 'no-test-gate', 'the profile has no gate of kind test', 'add one, or record a gate-change decision that waives it (a docs-only repository)');
    }
    const runs = runGates(s);
    const { pinned, anchorDoc } = references(s);
    const { reference, cmp } = compare(s, pinned, anchorDoc);
    verdicts(s, runs, reference, cmp);
  }
  if (s.mode !== 'merge') routePhase(s);
  return finish(s);
}

// The setup: the store, the task, the profile, the verify.json skeleton, the change under verification and the gate plan.
function begin({ where, names, env, id, mode, handle = null, at = now(), anchor = null, merged = null, version = null, cache = true, memo = null, full = false }) {
  const started = Date.now();
  const store = storeOf(where, names);
  const cost = measure({ store, id, mode }); // load, cache, heavy-lease wait and gate time (measure.mjs, T-MG-121)
  const task = store.read('task', id);
  if (task === null) throw unknownTask(id, where, names);
  const profile = store.read('profile', null) ?? emptyProfile();
  // A batch checked this gate set once before its merges (memo.trusted, batch.mjs); any other set is checked here.
  if (memo?.trusted !== gatesSha(profile.gates)) requireTrustedGates({ where, names, env, gates: profile.gates });
  const code = codeState(where, env);
  const reasons = [];
  const say = (level, c, message, hint = '') => reasons.push({ level, code: c, message, hint });
  const active = readRecords(where.dir).records.map((r) => r.doc).filter((d) => d.status === 'active');
  const doc = {
    schema: VERIFY_KINDS.verify.version, task: id, head: code.dirty ? null : code.head, gatesSha: gatesSha(profile.gates), baselineSha: null,
    class: task.class, startedAt: at, durationMs: 0, gates: [],
    inventory: { collector: 'none', total: 0, added: [], removed: [], newlySkipped: [], allowedBy: [], weak: false },
    failures: { preexisting: [], new: [] }, route: { declared: task.class, actual: task.class, escalated: false, missingSteps: [] },
    artifacts: { report: false, review: 'not-required' }, result: 'pass',
  };
  const baseOk = mode === 'merge' || commitExists(where, env, task.base);
  if (!baseOk) say('fail', 'base-missing', task.base ? `the base commit ${task.base.slice(0, 12)} of ${id} is not in this repository` : `${id} has no base commit`, `record it: ${names.bin} task set ${id} dispatched --executor <e> --base <sha> (fetch it first in a shallow clone)`);
  const anchorCommit = mode === 'merge' ? anchor : baseOk ? task.base : null;
  // The change under verification: since the base (verify), or what the merge brings onto the target tip.
  const riskPaths = riskGlobsOf(profile);
  const risky = riskMatcher(riskPaths);
  const change = mode === 'merge' ? mergeChange(where, env, anchor, code.routeScope) : baseOk ? changeSince(where, env, task.base, code.routeScope, lightMatcher(routerThresholds(store)), risky) : null;
  if (baseOk && change === null && mode !== 'merge') say('fail', 'base-missing', `git cannot compare the work with the base ${task.base.slice(0, 12)}`, 'fetch the base commit, then verify again');
  // The mode (fast.mjs): the fast subset of the change, or the full profile gate set (merge mode: always full).
  const plan = mode === 'merge' || profile.gates.length === 0
    ? { kind: 'full', why: mode === 'merge' ? 'task merge runs the full gate set' : 'no gates', files: [], gates: profile.gates }
    : fastPlan({ profile, change, full, critical: task.class === 'critical', riskPaths, repoFiles: listFiles(where.worktree, { env, exclude: code.rel }),
      trusted: (gates) => isTrusted({ dir: where.dir, dataDir: where.dataDir, names, env, kind: 'gates', sha: gatesShaOf(gates) }).trusted });
  doc.mode = { kind: plan.kind, why: plan.why.slice(0, 200), files: plan.files };
  return {
    started, write: mode === 'write', where, names, env, id, mode, handle, at, anchor, merged, version, cache, memo, store, cost, task, profile, code,
    stateShown: stateRel(where.worktree, where.dir) ?? where.dir, reasons, say, active, gateChange: active.find((d) => d.kind === 'gate-change'),
    allowedBy: new Set(), doc, candidates: null, inv: null, ctx: null, output: [], reused: null, renamed: [], publish: null, cached: 'off',
    baseOk, anchorCommit, riskPaths, change, plan, fast: plan.kind === 'fast',
  };
}

// The gate runs: reused from a batch memo or the gate cache, else run; stores a passing set; takes the inventory.
function runGates(s) {
  const { where, env, names, mode, store, task, plan, memo, doc, fast, cost, version } = s;
  // The gate cache (gate-cache.mjs): the runs stored for this tree, gate set and version are reused; a set that
  // passed is stored (not in ci mode, which writes nothing).
  // The project patterns first: an unreadable or invalid file refuses before any gate runs (T-MG-75).
  const { extra, sha: patterns } = readProjectPatterns(where);
  const tree = treeOf((a) => gitIn(where, env, a), { staged: mode === 'merge' });
  // fast mode: the gates run are the subset's, so its cache entry is keyed by that set
  const runSha = fast ? gatesSha(plan.gates) : doc.gatesSha;
  const key = tree ? cacheKey({ tree, gatesSha: runSha, version, patterns }) : null;
  // A critical task's verify never reuses runs; task merge may reuse an authenticated entry (T-MG-75).
  const reuse = s.cache && (mode === 'merge' || task.class !== 'critical');
  const shared = memo?.runs ?? null;
  const hit = shared === null && key && reuse ? lookup(store, { key, tree, gatesSha: runSha, version, patterns, gates: plan.gates, at: s.at, secret: machineKey(where.dataDir) }) : null;
  const runs = shared ?? (hit ? hit.runs : cost.heavy(() => runHeavy(plan.gates, { names, env, cwd: where.worktree, task: s.id }, (g) => runRedacted(g, { cwd: where.worktree, env, extra }), cost.meter)));
  s.cached = cacheState({ shared, hit, consulted: Boolean(key && reuse) });
  if (memo) memo.runs = runs;
  s.reused = hit?.at ?? null;
  doc.gates = runs.map((r) => r.gate);
  s.output = runs.map((r) => ({ name: r.gate.name, lines: logLines(r.output) }));
  s.ctx = context(where, env, s.code.rel);
  // fast mode with no test file selected: nothing ran to take an inventory of (and no repository scan stands in)
  s.inv = fast && !runs.some((r) => r.kind === 'test') ? { collector: 'none', tests: [], parts: [], weak: false } : inventoryOf(runs, s.ctx);
  if (key && !hit && shared === null && mode !== 'ci') {
    const report = (r) => {
      const part = s.inv.parts.find((p) => p.run === r);
      if (!part) return null;
      const { run: _run, ...collected } = part;
      return collected;
    };
    const entry = () => storeRuns(store, key, { tree, gatesSha: runSha, version, patterns, at: s.at, runs, report, secret: machineKey(where.dataDir, { create: true }) });
    if (mode === 'merge') s.publish = entry;
    else entry();
  }
  return runs;
}

// The reference inventories: the accepted baseline at the anchor, the working baseline, a base measured at the anchor and
// the task's own last passing verify; { pinned, anchorDoc }.
function references(s) {
  const { where, env, names, mode, store, plan, memo, fast, cost, say, id, code, anchorCommit, change, profile } = s;
  const current = store.read('baseline', null);
  if (current && current.sha256 !== baselineSha(current)) {
    say('fail', 'baseline-invalid', `${s.stateShown}/${VERIFY_KINDS.baseline.path()} does not match its sha256: it was changed outside verify`, 'restore it from git; a new baseline needs a decision');
  }
  // the code verified descends from the anchor and HEAD (a merge: the tip and the merged branch)
  const line = lineOf(where, env, current, [anchorCommit, mode === 'merge' ? s.merged : code.head]);
  const linked = code.rel === null;
  const working = line === 'line' || (!linked && (line === 'off' || line === 'unknown')) ? current : null;
  // Fast mode: the stored baselines hold the whole suite and name no file per test (node:test's tap), so the reference
  // is the same subset measured at the anchor, over the selected files the anchor has (a file the task deleted counts
  // there; one it added has no tests before it).
  const anchored = fast ? { doc: null, problem: null } : anchorAt(where, env, anchorCommit, working);
  const tests = (change?.paths ?? []).filter((p) => scannerOf(p) !== null);
  const atAnchor = fast && anchorCommit ? plan.files.filter((f) => gitIn(where, env, ['cat-file', '-e', `${anchorCommit}:${f}`]).status === 0) : [];
  // No stored baseline describes the anchor (linked: none, or off the line; in-repo: none committed there and the
  // change touches tests): the reference is measured at the anchor itself.
  const measure = fast ? atAnchor.length > 0 : !anchored.problem && anchorCommit && (linked ? line !== 'line' : !anchored.doc && tests.length > 0);
  const baseGates = fast ? testGates(atAnchor, plan.gates.find((g) => g.kind === 'test')?.timeoutS ?? 600) : profile.gates;
  let measured = null;
  if (anchored.problem) {
    say('fail', 'baseline-unanchored', `the baseline at ${anchorCommit.slice(0, 12)} is ${anchored.problem}, though its history has one: there is no accepted inventory to compare with`, 'restore the baseline on the target branch (git), or pin one with a decision');
  } else if (measure) {
    const m = memo?.measured?.get(anchorCommit) ?? cost.heavy(() => measureAt({ where, env, names, task: id, commit: anchorCommit, gates: baseGates, gitIn, meter: cost.meter, inventory: (runs, dir) => inventoryOf(runs, context({ ...where, worktree: dir }, env, code.rel)) }));
    if (memo) (memo.measured ??= new Map()).set(anchorCommit, m); // one measurement per anchor (a train: per merge base)
    if (m.error) say('error', 'base-gate-error', `${m.error}: there is no reference to compare with`, 'make the gates run at the base (install what they run), or pin a baseline (' + names.bin + ' baseline pin --decision <D>), then verify again');
    measured = m.doc;
  }
  // The task's own last passing verify: a test it verified and later removes is removed, whatever replaced the baseline.
  const last = store.read('verify', id);
  // In fast mode it counts only when it was a fast run over files this run also ran (else it names tests not run now).
  const sameFiles = !fast || (last?.mode?.kind === 'fast' && last.mode.files.every((f) => plan.files.includes(f)));
  // (a fast run that selected no test file collected nothing: collector none, no reference)
  const own = sameFiles && last?.result === 'pass' && last.inventory.tests && last.inventory.collector !== 'none' ? { collector: last.inventory.collector, tests: last.inventory.tests, failing: last.failures.preexisting } : null;
  const pinned = (fast ? [measured, own] : [measure ? measured : anchored.doc, working, own]).filter((b, k, all) => b && all.indexOf(b) === k);
  // a fast run whose selected files are all gone now (the task deleted them) ran no test: its empty inventory is
  // compared with the reference's collector, so every test of those files counts as removed
  if (fast && s.inv.collector === 'none' && pinned.length) s.inv = { ...s.inv, collector: pinned[0].collector };
  return { pinned, anchorDoc: measure ? measured : anchored.doc };
}

// The inventory against the reference: { reference, cmp }. A removed test whose body is present under a new title is a rename.
function compare(s, pinned, anchorDoc) {
  const { where, env, names, inv, say, anchorCommit, change, active } = s;
  // A reference that collected nothing (the base of a first task has no tests yet: the generic collector saw no
  // runner output) is an empty inventory, not a change of collector.
  const empty = (b) => b.collector === 'generic' && (b.tests?.length ?? 0) === 0 && (b.failing?.length ?? 0) === 0;
  const other = pinned.find((b) => b.collector !== inv.collector && !empty(b));
  let reference = { tests: [], failing: [] };
  let cmp = { added: inv.tests.map((t) => t.id), removed: [], newlySkipped: [], allowedBy: [], unallowed: [] };
  if (other) {
    say('fail', 'collector-changed', `the baseline was collected by ${other.collector}, this run by ${inv.collector}: the inventories cannot be compared`, `restore the test gate, or pin the new inventory on the target (${names.bin} baseline pin --decision <gate-change D>) and base the task on that commit`);
    return { reference, cmp };
  }
  reference = referenceOf(pinned);
  cmp = compareInventory(reference, inv, active.map((d) => ({ id: d.id, allowsTestRemoval: d.allowsTestRemoval ?? [] })));
  // A test removed by its title whose body is present under a title the anchor's inventory did not have (rename.mjs)
  // changed its name, not its assertions: it is reported as renamed and needs no decision (COD-3 names removals and
  // weakenings). The candidates are the current tests the anchor's accepted inventory lacks (not only this run's
  // additions: after a passing verify grew the working baseline, a second run still sees the old titles removed).
  if (cmp.removed.length && anchorCommit && anchorDoc) {
    const known = new Set(anchorDoc.tests.map((t) => t.id));
    // only running tests are targets: a removed test paired with a skipped or focused one would hide the skip
    const candidates = inv.tests.filter((t) => !t.skipped && !t.focused).map((t) => t.id).filter((x) => !known.has(x));
    const readAt = (p) => { const r = gitIn(where, env, ['show', `${anchorCommit}:${p}`]); return r.status === 0 ? r.stdout : null; };
    s.renamed = candidates.length ? detectRenames({ removed: cmp.removed, added: candidates, files: [...(change?.paths ?? []), ...idFiles(cmp.removed)], readAt, readNow: s.ctx.read }) : [];
    if (s.renamed.length) {
      const from = new Set(s.renamed.map((r) => r.from));
      cmp = { ...cmp, removed: cmp.removed.filter((x) => !from.has(x)), unallowed: cmp.unallowed.filter((x) => !from.has(x)) };
    }
  }
  return { reference, cmp };
}

// The reasons the comparison and the gate runs give, and the inventory of verify.json.
function verdicts(s, runs, reference, cmp) {
  const { say, inv, doc, id } = s;
  for (const d of cmp.allowedBy) s.allowedBy.add(d);
  if (cmp.unallowed.length) say('baseline-shrunk', 'baseline-shrunk', `removed or skipped without a decision: ${some(cmp.unallowed)}`, 'restore them, or record a decision that lists them in allowsTestRemoval');
  const focused = inv.tests.filter((t) => t.focused).map((t) => t.id);
  if (focused.length) say('fail', 'focused', `focused tests make the others not run: ${some(focused)}`, 'remove .only, fit and fdescribe');

  doc.failures = splitFailures(reference.failing, inv.parts.flatMap((p) => p.failing.map(fingerprint)));
  const known = new Set(reference.failing);
  for (const r of runs) {
    const g = r.gate;
    if (g.result === 'error') say('error', 'gate-error', `gate ${g.name} could not run (exit ${g.exit ?? '-'})`, 'install what the gate runs, or fix its command in the profile');
    else if (g.result === 'timeout') say('fail', 'gate-timeout', `gate ${g.name} ran over its ${s.profile.gates.find((x) => x.name === g.name)?.timeoutS} s limit`, 'make it faster, or raise its timeoutS in the profile');
    else if (g.result === 'fail') {
      const part = inv.parts.find((p) => p.run === r);
      if (!(r.kind === 'test' && part && excusable(part, known))) say('fail', 'gate-failed', `gate ${g.name} failed (exit ${g.exit ?? '-'})`, `see its output in ${s.stateShown}/local/verify/${id}.log`);
    }
  }
  if (doc.failures.new.length) say('fail', 'new-failures', `new failing tests: ${some(doc.failures.new)}`, 'fix them; only failures pinned in the baseline are tolerated');
  doc.inventory = { collector: inv.collector, total: inv.tests.length, added: cmp.added, removed: cmp.removed, newlySkipped: cmp.newlySkipped, allowedBy: [], weak: inv.weak, tests: inv.tests.map(({ id: t, file, skipped }) => ({ id: t, file, skipped })) };
}

// verify and ci mode: the route after re-classifying the change, and the review it needs.
function routePhase(s) {
  const { store, task, id, say, doc, change, names } = s;
  if (change) {
    const { route, flags } = reroute({ store, task, id, write: s.write, handle: s.handle, riskPaths: s.riskPaths, change, at: s.at });
    doc.route = route;
    doc.class = route.actual;
    if (route.escalated) say('route-escalated', 'route-escalated', `the change is ${route.actual}, not ${route.declared}: the route adds ${route.missingSteps.join(', ')}`, 'do the added steps, then verify again');
    if (doc.class !== null) {
      const steps = routeFor(doc.class, { flags }).steps;
      doc.artifacts.review = reviewState(store, id, steps);
      const problem = doc.artifacts.review === 'missing' ? reviewProblem(store, id, names) : null;
      if (problem) say('missing-artifact', 'missing-artifact', problem, 'an external round counts only with its run');
      else if (doc.artifacts.review === 'missing') say('missing-artifact', 'missing-artifact', `the ${doc.class} route needs an approved ${reviewNeed(doc.class, appliedTier(store)) === 'external' ? 'cross-provider ' : ''}review of ${id}`, 'record the review (review-r<k>.json, verdict approved), then verify again');
    }
  }
  if (doc.class === null) {
    doc.artifacts.review = 'missing';
    say('fail', 'not-classified', `${id} has no class`, `classify it: ${names.bin} route ${id} --paths <p,…> --loc <n>`);
  }
}

// The result, the baseline growth and the records of the run.
function finish(s) {
  const { where, env, store, id, mode, doc, say, code, change, inv, task, at, write, handle, output, fast } = s;
  const health = mode === 'merge' || !change ? null : codeHealth({ store, say, paths: change.paths, base: task.base, git: (a) => gitIn(where, env, a), read: (s.ctx ?? context(where, env, code.rel)).read, max: SOURCE_MAX });
  if (inv?.weak && doc.class === 'critical') {
    say('fail', 'weak-collector', 'a test gate of this critical task is read only by the generic scan (no runtime results)', 'use a structured reporter: profile observe writes --test-reporter=tap for node:test, --json for Jest and Vitest');
  }
  doc.inventory.allowedBy = [...s.allowedBy].sort(byCodeUnit);
  doc.artifacts.report = reportHasEvidence(readReport(where.dir, id));
  if (!doc.artifacts.report) say('missing-artifact', 'missing-artifact', `${s.stateShown}/tasks/${id}/report.md has no RED/GREEN evidence`, 'its frontmatter needs red and green: {"command": …, "exit": …, "excerpt": …}');

  doc.result = LEVELS.find((l) => s.reasons.some((r) => r.level === l)) ?? 'pass';
  // the baseline holds the whole suite: only a full run replaces it (a fast inventory is a subset)
  if (write && doc.result === 'pass' && inv && !fast) grow(store, { inv, preexisting: doc.failures.preexisting, head: code.head, at });
  doc.baselineSha = workingSha(store);
  Object.assign(doc, s.cost.fields(s.cached));
  doc.durationMs = Date.now() - s.started;
  const attempt = record(s);
  return { doc, reasons: s.reasons.map(({ code: c, message, hint }) => ({ code: c, message, hint })), written: write, candidates: s.candidates, output, reused: s.reused, attempt, renamed: s.renamed, publish: s.publish, health: health?.offenders ?? [] };
}

// Every run keeps its own log (local/verify/<id>-<n>.log, merge runs <id>-m<n>; machine-local) next to the latest
// one, so a failed run never hides the output of the one before it; a write-mode run is also an event of the task
// (result, head, attempt), so `task show` lists every attempt. Returns the attempt number (null: none).
function record(s) {
  const { store, id, mode, doc, at, write, handle, output } = s;
  let attempt = null;
  if (write) {
    store.write('verify', id, doc);
    store.write('verifyLog', id, { task: id, at, gates: output });
    const run = { result: doc.result, head: doc.head, class: doc.class };
    store.update('task', id, (cur) => {
      if (cur === null) return undefined;
      attempt = cur.events.filter((e) => e.event === 'verify').length + 1;
      return { ...cur, events: [...cur.events, { at, by: handle ?? 'verify', event: 'verify', data: { ...run, attempt } }] };
    });
    if (attempt !== null) store.write('verifyAttempt', `${id}-${attempt}`, { task: id, at, gates: output });
  } else if (mode === 'merge') {
    const n = store.list('verifyAttempt').filter((k) => k.startsWith(`${id}-m`)).length + 1;
    store.write('verifyAttempt', `${id}-m${n}`, { task: id, at, gates: output });
  }
  return attempt;
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

// `verify <id> [--ci] [--no-cache]`: the owner's verify writes; --ci only reports; --no-cache runs the gates whatever
// the gate cache holds. A closed task (done or cancelled) takes no further state: its verify runs as a check and
// writes nothing (`closed` in the result), so a later run on another HEAD never replaces the record that closed it.
const CLOSED = new Set(['done', 'cancelled']);
export function verifyTask({ cwd, env, names, id, ci = false, cache = true, version = null, at = now(), full = false }) {
  const main = activeWhere({ cwd, env, names });
  KINDS.task.path(id);
  const where = taskWhere(main, storeOf(main, names), id);
  let handle = null;
  let closed = null;
  if (!ci) {
    const store = storeOf(where, names);
    const task = store.read('task', id);
    if (task === null) throw unknownTask(id, where, names);
    handle = authorHandle({ store, where, names, env });
    if (task.owner !== handle) {
      throw new StateError('not-owner', 'REFUSED', `${id} belongs to ${task.owner}; only its owner verifies it with writes`, { hint: `ask ${task.owner}, or check without writing: ${names.bin} verify ${id} --ci` });
    }
    if (CLOSED.has(task.status)) closed = task.status;
  }
  return { ...evaluate({ where, names, env, id, mode: ci || closed ? 'ci' : 'write', handle, at, version, cache, full }), closed };
}
