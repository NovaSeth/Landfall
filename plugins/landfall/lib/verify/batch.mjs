// Batch merge (T-MG-80): check each task, merge eligible branches in a temporary worktree, and gate the integrated tree.
// Conflicts are left out; failing prefixes are bisected, then the remainder is confirmed (or only a passing prefix merges).
// HEAD, index and worktree must hold through the gates (F1); the target and integrated gate profiles must agree (F5).
// Fast-forward uses compare-and-swap on the original target ref, then updates the checkout; every task gets a merge record.
// Matching lockfiles permit dependency links; unavailable dependencies or gates fall back to sequential merges, except trains.
// Temporary worktree and branch cleanup runs in every case. State-derived revisions are checked before reaching git (AR-2).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorHandle } from '../decisions/index.mjs';
import { emptyProfile } from '../profile/index.mjs';
import { KINDS, StateError, gatesShaOf, isTrusted, mergedOf, recordMerged } from '../state/index.mjs';
import { dependencyLinks } from './deps-link.mjs';
import { refreshReceipt } from './done.mjs';
import { guardGates } from './fast.mjs';
import { requireTrustedGates, runGate } from './gates.mjs';
import { gateChanges, mergeTask, profileOf, targetOf, treeHeld } from './merge.mjs';
import { activeWhere, codeState, evaluate, gatesSha, gitIn, stateAt, storeOf } from './run.mjs';

const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const order = (a, b) => {
  const [pa, na] = [a.replace(/-\d+$/, ''), Number(a.match(/(\d+)$/)?.[1] ?? 0)];
  const [pb, nb] = [b.replace(/-\d+$/, ''), Number(b.match(/(\d+)$/)?.[1] ?? 0)];
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
};
// A conflicted file a generator rebuilds (T-MG-191): its first lines say so on either side, or it is docs/cli.md.
const GENERATED = /Generated from .* by scripts\/\S+; do not edit/;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
// A gate run that changed HEAD, the index or the working tree of the integration worktree (F1): nothing merges.
class TreeChanged extends Error {}
class SequentialFallback extends Error {}
const describeChanges = (changes) => `${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ''}`;

// The IDs `--ready` takes: the caller's done tasks with a recorded branch and no merged event, in task order.
export function readyIds(store, handle) {
  return store.list('task').map((id) => store.read('task', id))
    .filter((t) => t && t.owner === handle && t.status === 'done' && t.branch && mergedOf(t) === null)
    .map((t) => t.id).sort(order);
}

// Train policy supplies ready IDs, eligibility, ordering, and records verify/done alongside merged (T-MG-186).
// Trains accept approved tasks without done, recheck eligibility before fast-forward and under the record lock,
// and never fall back to sequential merges.
export function batchMerge({ cwd, env, names, ids = null, ready = false, version = null, at = new Date().toISOString(), now = new Date(), train = null }) {
  const where = activeWhere({ cwd, env, names });
  const store = storeOf(where, names);
  const handle = authorHandle({ store, where, names, env });
  if (!ready) for (const id of ids) KINDS.task.path(id);
  const list = ready ? (train ? train.ready(store, handle) : readyIds(store, handle)) : [...new Set(ids)];
  if (!ready && list.length === 0) throw usage('missing-argument', 'task merge needs task IDs or --ready', `${names.bin} task merge <id…> | --ready`);
  if (gitIn(where, env, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) throw fail('merge-in-progress', 'a merge is already in progress', 'finish it or run git merge --abort first');
  const { scope } = codeState(where, env);
  if (gitIn(where, env, ['status', '--porcelain', '--untracked-files=all', ...scope]).stdout.trim() !== '') {
    throw fail('dirty-tree', 'the working tree has changes; the gates must run on the merged tree only', 'commit or remove them first');
  }
  const tip = head(where, env);
  const target = targetOf(where, env);
  const targetRef = symbolic(where, env); // F5: the branch the checkout holds (null: detached), checked again before the fast-forward
  const targetProfile = stateAt(where, env, tip, 'profile.json');

  const context = { cwd, env, names, version, at, train, where, store, handle, tip, target, targetRef, targetProfile, scope, ready, list };
  const tasks = list.map((id) => checkTask(context, id));
  const eligible = tasks.filter((t) => t.outcome === null);
  const candidates = train ? train.order(store, eligible) : eligible;
  if (train) tasks.splice(0, tasks.length, ...candidates, ...tasks.filter((t) => t.outcome !== null)); // listed in merge order

  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  let batch = `batch-${stamp}`;
  for (let k = 2; gitIn(where, env, ['rev-parse', '--verify', '-q', `refs/heads/${names.codename}/${batch}`]).status === 0 && k < 100; k++) batch = `batch-${stamp}-${k}`;
  const branch = `${names.codename}/${batch}`;
  const result = { batch, target, tip, commit: null, branch, worktree: null, gateRuns: 0, tasks, result: null, verify: null, output: [], reasons: [], exit: 'OK' };
  if (candidates.length === 0) return finish(result);
  // Trust (T-MG-77, T-MG-83): check the target gates once before merging; branches and the integrated profile must keep them.
  // evaluate reuses memo.trusted for this set and checks again only a set that changed meanwhile.
  const batchGates = (store.read('profile', null) ?? emptyProfile()).gates;
  requireTrustedGates({ where, names, env, gates: batchGates });
  const trusted = gatesSha(batchGates);
  return integration({ ...context, candidates, result, tasks, batch, branch, trusted });
}

const head = (where, env) => gitIn(where, env, ['rev-parse', 'HEAD']).stdout.trim();
const symbolic = (where, env) => gitIn(where, env, ['symbolic-ref', '-q', 'HEAD']).stdout.trim() || null;
const skip = (task, why) => ({ ...task, why });
const contains = (where, env, outer, inner) => gitIn(where, env, ['merge-base', '--is-ancestor', '--end-of-options', inner, outer]).status === 0;
const generated = (here, env, p) => p === 'docs/cli.md' || GENERATED.test(gitIn(here, env, ['show', `:2:${p}`]).stdout.split('\n', 5).join('\n'));
const firstLine = (r) => (r.stderr || r.stdout).trim().split('\n')[0] ?? '';
function holds({ where, env, targetRef }, sha) {
  return symbolic(where, env) === targetRef && head(where, env) === sha && (targetRef === null || gitIn(where, env, ['rev-parse', '--verify', '-q', targetRef]).stdout.trim() === sha);
}
function swap({ where, env, targetRef, names, batch }, to, from) {
  const ref = targetRef ?? 'HEAD';
  return gitIn(where, env, ['update-ref', ...(targetRef === null ? ['--no-deref'] : []), '-m', `${names.bin} task merge: ${batch}`, ref, to, from]);
}
function again(context, t, store = context.store) {
  const c = checkTask(context, t.task, store);
  return c.outcome !== null ? c.why : c.sha !== t.sha ? `its branch moved to ${c.sha.slice(0, 12)} during the train` : null;
}

function checkTask(context, id, s = context.store) {
  const { handle, train, where, env, tip, target, names, scope, targetProfile, at } = context;
  const task = s.read('task', id);
  const t = { task: id, branch: task?.branch ?? null, outcome: 'skipped', why: null, conflicts: [], tests: [] };
  if (task === null) return skip(t, 'task-unknown');
  if (task.owner !== handle) return skip(t, `not-owner (${task.owner})`);
  if (task.status === 'cancelled') return skip(t, 'cancelled');
  if (!train && task.status !== 'done') return skip(t, `not done (${task.status})`);
  // a train closes a task merged by hand (merged, not done) when its tip is on the target: done only, no merge
  const byHand = train !== null && mergedOf(task) !== null && task.status !== 'done';
  if (mergedOf(task) !== null && !byHand) return skip(t, 'already merged');
  const open = train !== null && task.status !== 'done';
  if (!task.branch) return skip(t, 'no branch');
  if (typeof task.branch !== 'string' || task.branch.startsWith('-')) return skip(t, 'the branch name starts with "-" (no ref git can merge safely)');
  const doneEvent = open ? null : [...task.events].reverse().find((e) => e.event === 'done');
  const done = doneEvent?.data?.head ?? null;
  if (!open && (typeof done !== 'string' || !OBJECT_ID.test(done))) return skip(t, 'no done record at a commit');
  const sha = gitIn(where, env, ['rev-parse', '--verify', '-q', `${task.branch}^{commit}`]).stdout.trim();
  if (!OBJECT_ID.test(sha)) return skip(t, `unknown branch ${task.branch}`);
  // A train also verifies tips already on the target after a crash or a merge by hand (fix round 1, F3).
  if (byHand && !contains(where, env, tip, sha)) return skip(t, `merged elsewhere: its tip is not on ${target}`);
  if (!train && contains(where, env, tip, sha)) return skip(t, `already in ${target} (${names.bin} task merge --adopt ${id})`);
  // Only a train done on the target containing the tip verifies it too; every other done needs tree equality (fix round 2, F6).
  const trainDone = doneEvent?.data?.mode === 'train' && contains(where, env, tip, done) && contains(where, env, done, sha);
  if (!open && done !== sha && !trainDone && gitIn(where, env, ['diff', '--quiet', '--end-of-options', done, sha, ...scope]).status !== 0) return skip(t, `the branch changed since done at ${done.slice(0, 12)} (verify it again)`);
  const base = train || targetProfile.rel !== null ? gitIn(where, env, ['merge-base', '--end-of-options', tip, sha]).stdout.trim() : null;
  if (base !== null && !OBJECT_ID.test(base)) return skip(t, 'no merge base with the target');
  if (targetProfile.rel !== null) {
    const changes = gateChanges(profileOf(stateAt(where, env, base, 'profile.json').text), profileOf(stateAt(where, env, sha, 'profile.json').text));
    if (changes.length) return skip(t, `changes the gates in ${join(targetProfile.rel, 'profile.json')}: ${describeChanges(changes)} (merge it alone)`);
  }
  const fit = open ? train.eligible({ store: s, task, where, env, base, sha, scope, at }) : { why: null, route: null };
  if (fit.why) return skip(t, fit.why);
  if (train) return { ...t, sha, base, outcome: null, byHand, route: fit.route, critical: (fit.route?.actual ?? task.class) === 'critical' };
  return { ...t, sha, outcome: null };
}

function sequential(context, reason) {
  const { result, where, env, targetRef, tip, candidates, cwd, names, version, at } = context;
  result.fallback = { mode: 'sequential', reason };
  result.verify = null;
  result.output = [];
  result.reasons.push({ code: 'batch-fallback', message: `falling back to sequential merges: ${reason}`, hint: '' });
  if (symbolic(where, env) !== targetRef || head(where, env) !== tip) {
    for (const t of candidates) { t.outcome = 'skipped'; t.why = 'target-moved'; }
    result.reasons.push({ code: 'target-moved', message: 'the target moved before the sequential fallback; nothing was merged', hint: 'run task merge again' });
    return finish(result);
  }
  // Retry every eligible candidate, including integration conflicts, in the original ID order.
  let stopped = null;
  for (const t of candidates) {
    t.conflicts = [];
    t.tests = [];
    if (stopped) { t.outcome = 'skipped'; t.why = `sequential merge stopped at ${stopped}`; continue; }
    // The branch name when it still points at the verified sha (the merge commit then reads "Merge branch '<name>'").
    const named = gitIn(where, env, ['rev-parse', '--verify', '-q', `${t.branch}^{commit}`]);
    const ref = !t.branch.startsWith('-') && named.status === 0 && named.stdout.trim() === t.sha ? t.branch : t.sha;
    const single = mergeTask({ cwd, env, names, id: t.task, branch: ref, version, at });
    t.receipt = single.receipt;
    t.receiptProblem = single.receiptProblem;
    result.verify = single.verify;
    result.output.push(...single.output);
    result.reasons.push(...single.reasons);
    result.exit = single.exit;
    if (single.merged) {
      t.outcome = 'merged'; t.why = null;
      result.commit = single.commit;
    } else {
      t.conflicts = single.conflicts;
      t.tests = single.verify?.failures?.new?.slice(0, 10) ?? [];
      t.outcome = single.conflicts.length ? 'conflict' : single.upToDate ? 'skipped' : 'failed';
      t.why = single.reasons[0]?.message ?? 'already up to date';
      stopped = t.task;
    }
  }
  return finish(result);
}

function integration(context) {
  const { where, env, names, result, branch, tip, train, tasks } = context;
  const wt = mkdtempSync(join(tmpdir(), `${names.codename}-batch-`));
  result.worktree = wt;
  const here = { ...where, worktree: wt };
  let created = false;
  const dependencies = dependencyLinks(where, wt, SequentialFallback);
  try {
    const add = gitIn(where, env, ['worktree', 'add', '-q', '-b', branch, wt, tip]);
    if (add.status !== 0) throw new StateError('git-failed', 'ENV', `git cannot create the integration worktree (${String(add.stderr).trim().slice(0, 200)})`, { hint: 'check git worktree list and the temporary directory' });
    created = true;
    const run = { ...context, wt, here, dependencies, built: null, scopeHere: codeState(here, env).scope, passed: new Map() };
    const set = build(run, context.candidates);
    if (set.length === 0) return finish(result);
    const out = gates(run, set);
    const selected = selectPassing(run, set, out);
    return selected.done ?? fastForward(run, selected.final, selected.integrated, selected.verified, out);
  } catch (err) {
    if (err instanceof SequentialFallback && train) {
      for (const t of tasks) if (t.outcome === null) { t.outcome = 'skipped'; t.why = err.message; }
      result.reasons.push({ code: 'train-cannot-run', message: `the train cannot run in the integration worktree: ${err.message}; nothing was merged`, hint: 'make the dependencies match the checkout, then run the train again' });
      result.exit = 'ENV';
      return finish(result);
    }
    if (err instanceof SequentialFallback) return sequential(context, err.message);
    if (!(err instanceof TreeChanged)) throw err;
    for (const t of tasks) if (t.outcome === null || t.outcome === 'failed') { t.outcome = 'skipped'; t.why = 'merge-tree-changed'; }
    result.reasons.push({ code: 'merge-tree-changed', message: 'HEAD, the index or the working tree of the integration worktree changed while the gates ran: they did not verify what would be merged; nothing was merged', hint: 'find what writes to tracked files or commits during the gates (a formatter, a build into the tree), then merge again' });
    return finish(result);
  } finally {
    if (created) gitIn(where, env, ['worktree', 'remove', '--force', wt]);
    rmSync(wt, { recursive: true, force: true });
    gitIn(where, env, ['worktree', 'prune']);
    if (created) gitIn(where, env, ['branch', '-q', '-D', branch]);
  }
}

function regenerate(context, paths) {
  const { here, env, store, where, names, wt } = context;
  if (!paths.every((p) => generated(here, env, p))) return 'not generated';
  const guards = guardGates(store.read('profile', null) ?? emptyProfile());
  if (!guards.length) return 'no fastGuards to regenerate with';
  if (!isTrusted({ dir: where.dir, dataDir: where.dataDir, names, env, kind: 'gates', sha: gatesShaOf(guards) }).trusted) return 'the fastGuards are not trusted on this machine (trust records them)';
  if (gitIn(here, env, ['checkout', '--theirs', '--', ...paths]).status !== 0) return 'cannot take the branch side';
  for (const p of paths) rmSync(join(wt, p), { force: true });
  for (const form of [(c) => c.replace(/\s+--check\s*$/, ''), (c) => c]) {
    for (const g of guards) {
      const r = runGate({ ...g, cmd: form(g.cmd) }, { cwd: wt, env });
      if (r.gate.result !== 'pass') return `generator failed: ${r.gate.cmd}`;
    }
  }
  const lost = paths.find((p) => !existsSync(join(wt, p)));
  if (lost) return `no generator rebuilds ${lost}`;
  gitIn(here, env, ['add', '--', ...paths]);
  const stray = gitIn(here, env, ['diff', '--quiet', '--', '.', ...paths.map((p) => `:(exclude,literal)${p}`)]).status !== 0 || gitIn(here, env, ['ls-files', '--others', '--exclude-standard']).stdout.trim() !== '';
  return stray ? 'the generators changed other files' : gitIn(here, env, ['commit', '-q', '--no-edit']).status === 0 ? null : 'cannot commit the regenerated merge';
}

function build(context, set) {
  const { dependencies, here, env, branch, tip, batch } = context;
  const key = set.map((t) => t.task).join(' ');
  if (context.built?.key === key) return context.built.ok;
  dependencies.unlink();
  gitIn(here, env, ['checkout', '-q', '-f', '-B', branch, tip]); // the integration branch back at the target tip, local changes dropped
  gitIn(here, env, ['clean', '-q', '-fd', '-e', '/node_modules']);
  const ok = [];
  for (const t of set) {
    const m = gitIn(here, env, ['merge', '--no-ff', '--no-edit', '-q', '-m', `Merge branch '${t.branch}' (${t.task}, ${batch})`, '--end-of-options', t.sha]);
    if (m.status === 0) { ok.push(t); continue; }
    t.conflicts = gitIn(here, env, ['diff', '--name-only', '-z', '--diff-filter=U']).stdout.split('\0').filter(Boolean).sort();
    const bad = t.conflicts.length ? regenerate(context, t.conflicts) : 'no conflicted file';
    if (bad === null) { ok.push(t); t.regenerated = t.conflicts; t.conflicts = []; continue; }
    gitIn(here, env, ['merge', '--abort']);
    gitIn(here, env, ['checkout', '-q', '-f', '-B', branch, 'HEAD']);
    t.outcome = 'conflict';
    t.why = t.conflicts.length ? `conflicts in ${t.conflicts.join(', ')}${bad && bad !== 'not generated' ? `; ${bad}` : ''}` : `git merge failed: ${(m.stderr || m.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300);
  }
  context.built = { key: ok.map((t) => t.task).join(' '), ok };
  return ok;
}

function gates(context, set) {
  const { dependencies, here, env, branch, result, trusted, train, names, at, tip, version, scopeHere, passed } = context;
  dependencies.unlink();
  gitIn(here, env, ['checkout', '-q', '-f', '-B', branch, 'HEAD']);
  gitIn(here, env, ['clean', '-q', '-fd', '-e', '/node_modules']);
  dependencies.link();
  const commit = gitIn(here, env, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = gitIn(here, env, ['write-tree']).stdout.trim();
  result.gateRuns += 1;
  const memo = { trusted };
  // a train with a critical task never reuses gate runs from the cache (fix round 1, F1: as verify of a critical task)
  const cache = !(train && set.some((t) => t.critical));
  const byTask = new Map(set.map((t) => [t.task, evaluate({ where: here, names, env, id: t.task, mode: 'merge', at, anchor: t.base ?? tip, merged: commit, version, memo, cache })]));
  const checkedScope = dependencies.linked ? [...scopeHere, ':(top,exclude)node_modules'] : scopeHere;
  if (!treeHeld(here, env, checkedScope, commit) || gitIn(here, env, ['status', '--porcelain', '--untracked-files=all', ...checkedScope]).stdout.trim() !== '' || gitIn(here, env, ['write-tree']).stdout.trim() !== tree) throw new TreeChanged();
  const all = [...byTask.values()];
  for (const o of all) o.publish?.(); // the gate-cache entry, only now that the tree held (fix round 2, F1)
  const worst = all.find((o) => o.doc.result === 'error') ?? all.find((o) => o.doc.result !== 'pass') ?? all[0];
  if (worst.doc.result === 'pass') passed.set(set.map((t) => t.task).join(' '), { commit, byTask });
  return { ...worst, commit, byTask };
}

function selectPassing(context, set, out) {
  const { result, train, passed } = context;
  let final = set;
  let integrated = out.commit;
  let verified = out.byTask; // the per-task evaluations of the passing run whose commit the target gets
  if (out.doc.result === 'error' && train) return { done: finish(errored(result, out, set)) };
  if (out.doc.result === 'error') throw new SequentialFallback(`the first batch gate run could not run: ${out.reasons.find((r) => r.level !== 'warn')?.message ?? 'gate error'}`);
  if (out.doc.result !== 'pass') {
    // Binary search over the prefixes: prefix(k) = set[0..k]; prefix(-1) is the target tip, prefix(N-1) failed.
    let lo = 0;
    let hi = set.length - 1;
    let failedRun = out;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const sub = build(context, set.slice(0, mid + 1));
      const r = gates(context, sub);
      if (r.doc.result === 'error') return { done: finish(errored(result, r, set)) };
      if (r.doc.result === 'pass') lo = mid + 1;
      else { hi = mid; failedRun = r; }
    }
    const culprit = set[lo];
    // the culprit's own check when it failed (its report, its baseline), else the run's first failure
    const own = failedRun.byTask.get(culprit.task);
    const blame = own && own.doc.result !== 'pass' ? own : failedRun;
    culprit.outcome = 'failed';
    culprit.tests = blame.doc.failures.new.slice(0, 10);
    culprit.why = culprit.tests.length ? `new failing tests: ${culprit.tests.join(', ')}` : (blame.reasons.find((x) => x.code !== 'gate-error')?.message ?? 'the gates fail').slice(0, 300);
    result.verify = blame.doc;
    result.output = blame.output;
    const rest = set.filter((t) => t !== culprit);
    final = rest.length ? build(context, rest) : [];
    integrated = null;
    if (final.length) {
      const confirm = gates(context, final);
      if (confirm.doc.result === 'pass') { integrated = confirm.commit; verified = confirm.byTask; }
      else {
        // A second failure among the rest: only the prefix before the culprit (a passing run) merges.
        const after = set.slice(lo + 1);
        for (const t of after) if (t.outcome === null) { t.outcome = 'skipped'; t.why = `not verified: the batch fails also without ${culprit.task} (merge them again)`; }
        final = lo > 0 ? set.slice(0, lo) : [];
        const prefix = final.length ? passed.get(final.map((t) => t.task).join(' ')) ?? null : null;
        integrated = prefix?.commit ?? null;
        verified = prefix?.byTask ?? null;
        if (integrated === null) final = [];
      }
    }
    if (final.length === 0) return { done: finish(result) };
  }
  return { final, integrated, verified };
}

function fastForward(context, set, integrated, verified, out) {
  const { targetProfile, where, env, result, names, train, ready, list, tip } = context;
  const finalChanges = targetProfile.rel === null ? [] : gateChanges(profileOf(targetProfile.text), profileOf(stateAt(where, env, integrated, 'profile.json').text));
  if (finalChanges.length) {
    for (const t of set) { t.outcome = 'skipped'; t.why = 'gate-change-required'; }
    result.reasons.push({ code: 'gate-change-required', message: `the integrated batch changes the gates in ${join(targetProfile.rel, 'profile.json')}: ${describeChanges(finalChanges)}; nothing was merged`, hint: `merge the tasks one by one: ${names.bin} task merge <id>` });
    return finish(result);
  }
  // Compare-and-swap only the original ref; check the checkout before and after, rolling back if it moved (F5).
  // Dry-run the two-tree checkout update first so local state writes survive; a changed train blocks the whole set.
  const refused = train ? set.map((t) => [t, again(context, t)]).filter(([, why]) => why) : [];
  if (refused.length) {
    for (const t of set) { t.outcome = 'skipped'; t.why = refused.find(([x]) => x === t)?.[1] ?? `not merged: ${refused.map(([x]) => x.task).join(', ')} changed during the train gate (run the train again)`; }
    result.reasons.push({ code: 'train-changed', message: `${refused.map(([x]) => x.task).join(', ')} no longer pass the train's checks; nothing was merged`, hint: `${names.bin} train ${ready ? '--ready' : list.join(' ')}` });
    return finish(result);
  }
  if (!holds(context, tip)) return moved(context, set);
  if (gitIn(where, env, ['merge-base', '--is-ancestor', '--end-of-options', tip, integrated]).status !== 0) return ffFailed(result, set, 'the verified commit does not descend from the target tip');
  gitIn(where, env, ['update-index', '-q', '--refresh']);
  const dry = gitIn(where, env, ['read-tree', '-n', '-m', '-u', tip, integrated]);
  if (dry.status !== 0) return ffFailed(result, set, firstLine(dry));
  const cas = swap(context, integrated, tip);
  if (cas.status !== 0) return moved(context, set);
  if (!holds(context, integrated)) { swap(context, tip, integrated); return moved(context, set); }
  const rt = gitIn(where, env, ['read-tree', '-m', '-u', tip, integrated]);
  if (rt.status !== 0) { swap(context, tip, integrated); return ffFailed(result, set, firstLine(rt)); }
  return record(context, set, integrated, verified, out);
}

function moved(context, set) {
  const { result, target, tip, names, ready, list } = context;
  for (const t of set) { t.outcome = 'skipped'; t.why = 'target-moved'; }
  result.reasons.push({ code: 'target-moved', message: `${target} moved from ${tip.slice(0, 12)}, or the checkout changed branch, while the gates ran; nothing was merged`, hint: `${names.bin} task merge ${ready ? '--ready' : list.join(' ')}` });
  return finish(result);
}

function ffFailed(result, set, why) {
  for (const t of set) { t.outcome = 'skipped'; t.why = 'ff-failed'; }
  result.reasons.push({ code: 'ff-failed', message: `the target cannot be fast-forwarded: ${why}`.slice(0, 300), hint: 'check the working tree of the target, then merge again' });
  return finish(result);
}

function record(context, set, integrated, verified, out) {
  const { result, where, env, train, store, batch, handle, at, target, cwd, names } = context;
  result.commit = integrated;
  const tree = gitIn(where, env, ['rev-parse', `${integrated}^{tree}`]).stdout.trim();
  // A train records verify and done first: a run that dies between the two writes leaves done tasks whose tips are on
  // the target (`task merge --adopt` records them), never merged tasks that no train takes again and nothing closes.
  // A task the record's own check refuses (inside its lock) is on the target but recorded neither done nor merged.
  if (train) train.record({ store, set, integrated, batch, byTask: verified, handle, at, check: again.bind(null, context) });
  for (const t of set.filter((x) => x.refused)) {
    t.outcome = 'skipped'; t.why = `on ${target} at ${integrated.slice(0, 12)} but not recorded: ${t.refused}`;
    result.reasons.push({ code: 'train-changed', message: `${t.task} ${t.why}`.slice(0, 300), hint: `address it, then ${names.bin} task merge --adopt ${t.task}` });
  }
  set = set.filter((x) => !x.refused);
  for (const t of set.filter((x) => x.byHand)) t.outcome = 'done'; // merged by hand: done recorded, no second merged event
  set = set.filter((x) => !x.byHand);
  if (set.length) recordMerged({ cwd, env, names, at, entries: set.map((t) => ({ id: t.task, data: { commit: integrated, target, batch, adopted: false, verify: tree } })) });
  for (const t of set) {
    t.outcome = 'merged'; t.why = null;
    if (t.regenerated) result.reasons.push({ code: 'regenerated', level: 'warn', message: `${t.task}: merged (generated files regenerated: ${t.regenerated.join(', ')})`, hint: '' });
    Object.assign(t, refreshReceipt({ cwd, env, names, id: t.task, mergedAt: at }));
  }
  if (!result.verify) { result.verify = out.doc; result.output = out.output; }
  return finish(result);
}

// A gate that cannot run: nothing merges; every candidate is skipped and the exit is ENV.
function errored(result, out, set) {
  for (const t of set) if (t.outcome === null) { t.outcome = 'skipped'; t.why = 'the gates could not run'; }
  result.verify = out.doc;
  result.output = out.output;
  result.reasons.push(...out.reasons.filter((x) => x.level !== 'warn'));
  result.exit = 'ENV';
  return result;
}

// The result: candidates still open are skipped; any task not merged makes the exit FAIL.
function finish(result) {
  for (const t of result.tasks) {
    if (t.outcome === null) { t.outcome = 'skipped'; t.why = t.why ?? 'not merged'; }
    delete t.sha;
    delete t.critical; delete t.base; delete t.refused; delete t.byHand;
  }
  const ok = (t) => t.outcome === 'merged' || t.outcome === 'done';
  result.result = result.tasks.every(ok) ? 'pass' : 'fail';
  if (result.exit === 'OK' && !result.tasks.every(ok)) result.exit = 'FAIL';
  for (const t of result.tasks) {
    if (t.outcome === 'conflict') result.reasons.push({ code: 'merge-conflict', message: `${t.task}: ${t.why}`, hint: `merge ${result.target} into ${t.branch} first, verify it, then merge again` });
    if (t.outcome === 'failed') result.reasons.push({ code: 'new-failures', message: `${t.task}: ${t.why}`, hint: 'fix it on its branch, verify it, then merge again' });
  }
  return result;
}
