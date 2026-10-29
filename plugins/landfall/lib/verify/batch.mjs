// `task merge <id> <id>…` and `task merge --ready` (T-MG-80): ready tasks merge as one batch with one gate run on the
// integrated tree. Steps:
//   1. Each task is checked: known, the caller's, done and not cancelled, not merged yet, its recorded branch names a
//      commit that is not in the target yet, the code at that tip is the code its `done` verified, and its branch does
//      not change the target's gates or risk paths (such a branch is skipped: merge it alone, with its decision).
//   2. A temporary branch `<codename>/batch-<UTC yyyymmddThhmmss>` starts at the target tip in a temporary worktree under
//      os.tmpdir() (outside the repository: no state or code of the project holds it). Each task branch merges with
//      --no-ff in order; a conflict is aborted there and that task is left out (`conflict`).
//   3. The gates run once through evaluate in merge mode, anchored at the target tip (the gate set, the test baseline
//      and the heavy lease as for one task). On a failing batch the culprit is found by binary search over the prefixes
//      (⌈log2 N⌉ runs), then one confirming run on the batch without it; if that one fails too, only the prefix before
//      the culprit (a passing run) merges and the tasks after it are skipped.
//   4. On pass the target is fast-forwarded (`git merge --ff-only`, never a reset) when it has not moved since step 2;
//      otherwise nothing changes (`target-moved`). Each merged task gets a `merged` event with the batch id.
//   5. The temporary worktree and branch are removed in every case.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorHandle } from '../decisions/index.mjs';
import { KINDS, StateError } from '../state/index.mjs';
import { mergedOf, recordMerged } from '../state/tasks.mjs';
import { changesGates, profileOf, targetOf } from './merge.mjs';
import { activeWhere, codeState, evaluate, gitIn, stateAt, storeOf } from './run.mjs';

const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const order = (a, b) => {
  const [pa, na] = [a.replace(/-\d+$/, ''), Number(a.match(/(\d+)$/)?.[1] ?? 0)];
  const [pb, nb] = [b.replace(/-\d+$/, ''), Number(b.match(/(\d+)$/)?.[1] ?? 0)];
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
};

// The IDs `--ready` takes: the caller's done tasks with a recorded branch and no merged event, in task order.
export function readyIds(store, handle) {
  return store.list('task').map((id) => store.read('task', id))
    .filter((t) => t && t.owner === handle && t.status === 'done' && t.branch && mergedOf(t) === null)
    .map((t) => t.id).sort(order);
}

export function batchMerge({ cwd, env, names, ids = null, ready = false, version = null, at = new Date().toISOString(), now = new Date() }) {
  const where = activeWhere({ cwd, env, names });
  const store = storeOf(where, names);
  const handle = authorHandle({ store, where, names, env });
  if (!ready) for (const id of ids) KINDS.task.path(id);
  const list = ready ? readyIds(store, handle) : [...new Set(ids)];
  if (!ready && list.length === 0) throw usage('missing-argument', 'task merge needs task IDs or --ready', `${names.bin} task merge <id…> | --ready`);
  if (gitIn(where, env, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) throw fail('merge-in-progress', 'a merge is already in progress', 'finish it or run git merge --abort first');
  const { scope } = codeState(where, env);
  if (gitIn(where, env, ['status', '--porcelain', '--untracked-files=all', ...scope]).stdout.trim() !== '') {
    throw fail('dirty-tree', 'the working tree has changes; the gates must run on the merged tree only', 'commit or remove them first');
  }
  const head = () => gitIn(where, env, ['rev-parse', 'HEAD']).stdout.trim();
  const tip = head();
  const target = targetOf(where, env);
  const targetProfile = stateAt(where, env, tip, 'profile.json');

  // 1. The checks; a task that fails one is skipped with its reason.
  const tasks = list.map((id) => {
    const task = store.read('task', id);
    const t = { task: id, branch: task?.branch ?? null, outcome: 'skipped', why: null, conflicts: [], tests: [] };
    const skip = (why) => ({ ...t, why });
    if (task === null) return skip('task-unknown');
    if (task.owner !== handle) return skip(`not-owner (${task.owner})`);
    if (task.status === 'cancelled') return skip('cancelled');
    if (task.status !== 'done') return skip(`not done (${task.status})`);
    if (mergedOf(task) !== null) return skip('already merged');
    if (!task.branch) return skip('no branch');
    const sha = gitIn(where, env, ['rev-parse', '--verify', '-q', `${task.branch}^{commit}`]).stdout.trim();
    if (!sha) return skip(`unknown branch ${task.branch}`);
    if (gitIn(where, env, ['merge-base', '--is-ancestor', sha, tip]).status === 0) return skip(`already in ${target} (${names.bin} task merge --adopt ${id})`);
    const done = [...task.events].reverse().find((e) => e.event === 'done')?.data?.head ?? null;
    if (!done) return skip('no done record at a commit');
    if (done !== sha && gitIn(where, env, ['diff', '--quiet', done, sha, ...scope]).status !== 0) return skip(`the branch changed since done at ${done.slice(0, 12)} (verify it again)`);
    if (targetProfile.rel !== null && changesGates(profileOf(targetProfile.text), profileOf(stateAt(where, env, sha, 'profile.json').text))) return skip('changes the gates (merge it alone)');
    return { ...t, sha, outcome: null };
  });
  const candidates = tasks.filter((t) => t.outcome === null);

  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  let batch = `batch-${stamp}`;
  for (let k = 2; gitIn(where, env, ['rev-parse', '--verify', '-q', `refs/heads/${names.codename}/${batch}`]).status === 0 && k < 100; k++) batch = `batch-${stamp}-${k}`;
  const branch = `${names.codename}/${batch}`;
  const result = { batch, target, tip, commit: null, branch, worktree: null, gateRuns: 0, tasks, result: null, verify: null, output: [], reasons: [], exit: 'OK' };
  if (candidates.length === 0) return finish(result);

  // 2–5. The integration worktree, removed in every case.
  const wt = mkdtempSync(join(tmpdir(), `${names.codename}-batch-`));
  result.worktree = wt;
  const here = { ...where, worktree: wt };
  let created = false;
  try {
    const add = gitIn(where, env, ['worktree', 'add', '-q', '-b', branch, wt, tip]);
    if (add.status !== 0) throw new StateError('git-failed', 'ENV', `git cannot create the integration worktree (${String(add.stderr).trim().slice(0, 200)})`, { hint: 'check git worktree list and the temporary directory' });
    created = true;
    // The set merged onto the target tip, in order; a conflicting task is aborted and left out.
    let built = null;
    const build = (set) => {
      const key = set.map((t) => t.task).join(' ');
      if (built?.key === key) return built.ok;
      gitIn(here, env, ['reset', '-q', '--hard', tip]);
      gitIn(here, env, ['clean', '-q', '-fd']);
      const ok = [];
      for (const t of set) {
        const m = gitIn(here, env, ['merge', '--no-ff', '--no-edit', '-q', '-m', `Merge branch '${t.branch}' (${t.task}, ${batch})`, t.sha]);
        if (m.status === 0) { ok.push(t); continue; }
        t.conflicts = gitIn(here, env, ['diff', '--name-only', '-z', '--diff-filter=U']).stdout.split('\0').filter(Boolean).sort();
        gitIn(here, env, ['merge', '--abort']);
        gitIn(here, env, ['reset', '-q', '--hard', 'HEAD']);
        t.outcome = 'conflict';
        t.why = t.conflicts.length ? `conflicts in ${t.conflicts.join(', ')}` : `git merge failed: ${(m.stderr || m.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300);
      }
      built = { key: ok.map((t) => t.task).join(' '), ok };
      return ok;
    };
    const gates = (set) => {
      result.gateRuns += 1;
      const out = evaluate({ where: here, names, env, id: set[0].task, mode: 'merge', at, anchor: tip, merged: gitIn(here, env, ['rev-parse', 'HEAD']).stdout.trim(), version });
      return out;
    };
    let set = build(candidates);
    if (set.length === 0) return finish(result);
    let out = gates(set);
    let final = set;
    if (out.doc.result === 'error') return finish(errored(result, out, set));
    if (out.doc.result !== 'pass') {
      // Binary search over the prefixes: prefix(k) = set[0..k]; prefix(-1) is the target tip, prefix(N-1) failed.
      let lo = 0;
      let hi = set.length - 1;
      let failedRun = out;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const sub = build(set.slice(0, mid + 1));
        const r = gates(sub);
        if (r.doc.result === 'error') return finish(errored(result, r, set));
        if (r.doc.result === 'pass') lo = mid + 1;
        else { hi = mid; failedRun = r; }
      }
      const culprit = set[lo];
      culprit.outcome = 'failed';
      culprit.tests = failedRun.doc.failures.new.slice(0, 10);
      culprit.why = culprit.tests.length ? `new failing tests: ${culprit.tests.join(', ')}` : (failedRun.reasons.find((x) => x.level === 'fail')?.message ?? 'the gates fail').slice(0, 300);
      result.verify = failedRun.doc;
      result.output = failedRun.output;
      const rest = set.filter((t) => t !== culprit);
      final = rest.length ? build(rest) : [];
      if (final.length) {
        const confirm = gates(final);
        if (confirm.doc.result !== 'pass') {
          // A second failure among the rest: only the prefix before the culprit (a passing run) merges.
          const after = set.slice(lo + 1);
          for (const t of after) if (t.outcome === null) { t.outcome = 'skipped'; t.why = `not verified: the batch fails also without ${culprit.task} (merge them again)`; }
          final = lo > 0 ? build(set.slice(0, lo)) : [];
        }
      }
      if (final.length === 0) return finish(result);
    }
    set = final;
    // 4. Fast-forward the target, only when it has not moved.
    const integrated = gitIn(here, env, ['rev-parse', 'HEAD']).stdout.trim();
    if (head() !== tip) {
      for (const t of set) { t.outcome = 'skipped'; t.why = 'target-moved'; }
      result.reasons.push({ code: 'target-moved', message: `${target} moved from ${tip.slice(0, 12)} while the gates ran; nothing was merged`, hint: `${names.bin} task merge ${ready ? '--ready' : list.join(' ')}` });
      return finish(result);
    }
    const ff = gitIn(where, env, ['merge', '--ff-only', '-q', integrated]);
    if (ff.status !== 0 || head() !== integrated) {
      for (const t of set) { t.outcome = 'skipped'; t.why = 'ff-failed'; }
      result.reasons.push({ code: 'ff-failed', message: `git merge --ff-only failed: ${(ff.stderr || ff.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300), hint: 'check the working tree of the target, then merge again' });
      return finish(result);
    }
    result.commit = integrated;
    const tree = gitIn(where, env, ['rev-parse', `${integrated}^{tree}`]).stdout.trim();
    recordMerged({ cwd, env, names, at, entries: set.map((t) => ({ id: t.task, data: { commit: integrated, target, batch, adopted: false, verify: tree } })) });
    for (const t of set) { t.outcome = 'merged'; t.why = null; }
    if (!result.verify) { result.verify = out.doc; result.output = out.output; }
    return finish(result);
  } finally {
    if (created) gitIn(where, env, ['worktree', 'remove', '--force', wt]);
    rmSync(wt, { recursive: true, force: true });
    gitIn(where, env, ['worktree', 'prune']);
    if (created) gitIn(where, env, ['branch', '-q', '-D', branch]);
  }
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
  }
  result.result = result.tasks.every((t) => t.outcome === 'merged') ? 'pass' : 'fail';
  if (result.exit === 'OK' && result.tasks.some((t) => t.outcome !== 'merged')) result.exit = 'FAIL';
  for (const t of result.tasks) {
    if (t.outcome === 'conflict') result.reasons.push({ code: 'merge-conflict', message: `${t.task}: ${t.why}`, hint: `merge ${result.target} into ${t.branch} first, verify it, then merge again` });
    if (t.outcome === 'failed') result.reasons.push({ code: 'new-failures', message: `${t.task}: ${t.why}`, hint: 'fix it on its branch, verify it, then merge again' });
  }
  return result;
}
