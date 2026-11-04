// `task merge <id> <id>…` and `task merge --ready` (T-MG-80): ready tasks merge as one batch with one gate run on the
// integrated tree. Steps:
//   1. Each task is checked: known, the caller's, done and not cancelled, not merged yet, its recorded branch names a
//      commit that is not in the target yet, the code at that tip is the code its `done` verified, and its branch does
//      not change the gates or drop risk paths since its merge base (such a branch is skipped: merge it alone).
//   2. A temporary branch `<codename>/batch-<UTC yyyymmddThhmmss>` starts at the target tip in a temporary worktree under
//      os.tmpdir() (outside the repository: no state or code of the project holds it). Each task branch merges with
//      --no-ff in order; a conflict is aborted there and that task is left out (`conflict`).
//   3. A gate run: the integration worktree is checked out again (-f) and cleaned, its HEAD and `git write-tree` are recorded, the suite
//      runs once (evaluate in merge mode, anchored at the target tip: the gate set, the test baseline and the heavy
//      lease as for one task) and every task of the set is checked against that one inventory with its own artifacts
//      (report evidence, its own last baseline, the class rules; fix round 1, F3). After the run HEAD, the index and the
//      working tree must be what was recorded; otherwise nothing merges (`merge-tree-changed`, F1). On a failing batch
//      the culprit is found by binary search over the prefixes (⌈log2 N⌉ runs), then one confirming run on the batch
//      without it; if that one fails too, only the prefix before the culprit (a passing run) merges and the tasks after
//      it are skipped.
//   4. On pass the target is fast-forwarded to the commit recorded before that passing run: only the target ref moves,
//      by a compare-and-swap from the tip read before the gates (`git update-ref <ref> <new> <old>`, never a reset or a
//      merge through HEAD), only when the checkout still holds that branch (`git symbolic-ref`) at that tip just before
//      and the new commit just after (else the ref is swapped back), and when the final integrated profile does not
//      change the gates (F5); otherwise nothing changes (`target-moved`, `gate-change-required`). The working tree then
//      follows by a two-tree `git read-tree -m -u`. Each merged task gets a `merged` event with the batch id.
//   5. Matching lockfiles let the integration worktree link the checkout's node_modules. If dependencies cannot be
//      linked, or the first run cannot execute its gates, merge sequentially in the checkout and stop on failure.
//      The temporary worktree and branch are removed in every case.
// Values from the state reach git only after a check: a done head is an object id, a branch never starts with "-", and
// revisions follow --end-of-options (AR-2).
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorHandle } from '../decisions/index.mjs';
import { emptyProfile } from '../profile/index.mjs';
import { KINDS, StateError, mergedOf, recordMerged } from '../state/index.mjs';
import { refreshReceipt } from './done.mjs';
import { requireTrustedGates } from './gates.mjs';
import { gateChanges, mergeTask, profileOf, targetOf, treeHeld } from './merge.mjs';
import { activeWhere, codeState, evaluate, gatesSha, gitIn, stateAt, storeOf } from './run.mjs';

const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const order = (a, b) => {
  const [pa, na] = [a.replace(/-\d+$/, ''), Number(a.match(/(\d+)$/)?.[1] ?? 0)];
  const [pb, nb] = [b.replace(/-\d+$/, ''), Number(b.match(/(\d+)$/)?.[1] ?? 0)];
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
};
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
// A gate run that changed HEAD, the index or the working tree of the integration worktree (F1): nothing merges.
class TreeChanged extends Error {}
class SequentialFallback extends Error {}
const describeChanges = (changes) => `${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ''}`;
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

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
  const symbolic = () => gitIn(where, env, ['symbolic-ref', '-q', 'HEAD']).stdout.trim() || null;
  const targetRef = symbolic(); // F5: the branch the checkout holds (null: detached), checked again before the fast-forward
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
    if (typeof task.branch !== 'string' || task.branch.startsWith('-')) return skip('the branch name starts with "-" (no ref git can merge safely)');
    const done = [...task.events].reverse().find((e) => e.event === 'done')?.data?.head ?? null;
    if (typeof done !== 'string' || !OBJECT_ID.test(done)) return skip('no done record at a commit');
    const sha = gitIn(where, env, ['rev-parse', '--verify', '-q', `${task.branch}^{commit}`]).stdout.trim();
    if (!OBJECT_ID.test(sha)) return skip(`unknown branch ${task.branch}`);
    if (gitIn(where, env, ['merge-base', '--is-ancestor', '--end-of-options', sha, tip]).status === 0) return skip(`already in ${target} (${names.bin} task merge --adopt ${id})`);
    if (done !== sha && gitIn(where, env, ['diff', '--quiet', '--end-of-options', done, sha, ...scope]).status !== 0) return skip(`the branch changed since done at ${done.slice(0, 12)} (verify it again)`);
    if (targetProfile.rel !== null) {
      const base = gitIn(where, env, ['merge-base', '--end-of-options', tip, sha]).stdout.trim();
      if (!OBJECT_ID.test(base)) return skip('no merge base with the target');
      const changes = gateChanges(profileOf(stateAt(where, env, base, 'profile.json').text), profileOf(stateAt(where, env, sha, 'profile.json').text));
      if (changes.length) return skip(`changes the gates in ${join(targetProfile.rel, 'profile.json')}: ${describeChanges(changes)} (merge it alone)`);
    }
    return { ...t, sha, outcome: null };
  });
  const candidates = tasks.filter((t) => t.outcome === null);

  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  let batch = `batch-${stamp}`;
  for (let k = 2; gitIn(where, env, ['rev-parse', '--verify', '-q', `refs/heads/${names.codename}/${batch}`]).status === 0 && k < 100; k++) batch = `batch-${stamp}-${k}`;
  const branch = `${names.codename}/${batch}`;
  const result = { batch, target, tip, commit: null, branch, worktree: null, gateRuns: 0, tasks, result: null, verify: null, output: [], reasons: [], exit: 'OK' };
  if (candidates.length === 0) return finish(result);
  // Trust (T-MG-77, T-MG-83): the gate set every run of this batch uses is checked once, before any merge or gate run;
  // each branch keeps the target's gates (step 1) and so does the integrated tree (step 4). evaluate skips its own
  // check for this set (memo.trusted) and checks again only a set that changed meanwhile.
  const batchGates = (store.read('profile', null) ?? emptyProfile()).gates;
  requireTrustedGates({ where, names, env, gates: batchGates });
  const trusted = gatesSha(batchGates);

  const sequential = (reason) => {
    result.fallback = { mode: 'sequential', reason };
    result.verify = null;
    result.output = [];
    result.reasons.push({ code: 'batch-fallback', message: `falling back to sequential merges: ${reason}`, hint: '' });
    if (symbolic() !== targetRef || head() !== tip) {
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
  };

  // 2–5. The integration worktree, removed in every case.
  const wt = mkdtempSync(join(tmpdir(), `${names.codename}-batch-`));
  result.worktree = wt;
  const here = { ...where, worktree: wt };
  let created = false;
  const modules = join(wt, 'node_modules');
  let linked = false;
  const unlinkDependencies = () => {
    // Unlink only the link we created; never recursively remove or follow its target.
    if (linked && lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(modules);
    linked = false;
  };
  const linkDependencies = () => {
    const source = join(where.worktree, 'node_modules');
    if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) return;
    const lock = LOCKFILES.find((file) => existsSync(join(where.worktree, file)));
    if (!lock) throw new SequentialFallback('the main checkout has node_modules but no lockfile');
    try {
      if (!existsSync(join(wt, lock)) || !readFileSync(join(where.worktree, lock)).equals(readFileSync(join(wt, lock)))) {
        throw new SequentialFallback(`${lock} differs between the main checkout and the integration worktree`);
      }
      symlinkSync(source, modules, 'dir');
      linked = true;
    } catch (err) {
      if (err instanceof SequentialFallback) throw err;
      throw new SequentialFallback(`cannot link the main checkout's node_modules (${err.code ?? 'filesystem error'})`);
    }
  };
  try {
    const add = gitIn(where, env, ['worktree', 'add', '-q', '-b', branch, wt, tip]);
    if (add.status !== 0) throw new StateError('git-failed', 'ENV', `git cannot create the integration worktree (${String(add.stderr).trim().slice(0, 200)})`, { hint: 'check git worktree list and the temporary directory' });
    created = true;
    // The set merged onto the target tip, in order; a conflicting task is aborted and left out.
    let built = null;
    const build = (set) => {
      const key = set.map((t) => t.task).join(' ');
      if (built?.key === key) return built.ok;
      unlinkDependencies();
      gitIn(here, env, ['checkout', '-q', '-f', '-B', branch, tip]); // the integration branch back at the target tip, local changes dropped
      gitIn(here, env, ['clean', '-q', '-fd', '-e', '/node_modules']);
      const ok = [];
      for (const t of set) {
        const m = gitIn(here, env, ['merge', '--no-ff', '--no-edit', '-q', '-m', `Merge branch '${t.branch}' (${t.task}, ${batch})`, '--end-of-options', t.sha]);
        if (m.status === 0) { ok.push(t); continue; }
        t.conflicts = gitIn(here, env, ['diff', '--name-only', '-z', '--diff-filter=U']).stdout.split('\0').filter(Boolean).sort();
        gitIn(here, env, ['merge', '--abort']);
        gitIn(here, env, ['checkout', '-q', '-f', '-B', branch, 'HEAD']);
        t.outcome = 'conflict';
        t.why = t.conflicts.length ? `conflicts in ${t.conflicts.join(', ')}` : `git merge failed: ${(m.stderr || m.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300);
      }
      built = { key: ok.map((t) => t.task).join(' '), ok };
      return ok;
    };
    // One gate run on the set as built (F1, F3): the worktree checked out again and cleaned, its commit and index tree recorded, the
    // suite run once and each task checked against it with its own artifacts; HEAD, index and tree checked after it.
    const scopeHere = codeState(here, env).scope;
    const passed = new Map(); // the set key of a passing run → the commit it verified
    const gates = (set) => {
      unlinkDependencies();
      gitIn(here, env, ['checkout', '-q', '-f', '-B', branch, 'HEAD']);
      gitIn(here, env, ['clean', '-q', '-fd', '-e', '/node_modules']);
      linkDependencies();
      const commit = gitIn(here, env, ['rev-parse', 'HEAD']).stdout.trim();
      const tree = gitIn(here, env, ['write-tree']).stdout.trim();
      result.gateRuns += 1;
      const memo = { trusted };
      const byTask = new Map(set.map((t) => [t.task, evaluate({ where: here, names, env, id: t.task, mode: 'merge', at, anchor: tip, merged: commit, version, memo })]));
      const checkedScope = linked ? [...scopeHere, ':(top,exclude)node_modules'] : scopeHere;
      if (!treeHeld(here, env, checkedScope, commit) || gitIn(here, env, ['status', '--porcelain', '--untracked-files=all', ...checkedScope]).stdout.trim() !== '' || gitIn(here, env, ['write-tree']).stdout.trim() !== tree) throw new TreeChanged();
      const all = [...byTask.values()];
      for (const o of all) o.publish?.(); // the gate-cache entry, only now that the tree held (fix round 2, F1)
      const worst = all.find((o) => o.doc.result === 'error') ?? all.find((o) => o.doc.result !== 'pass') ?? all[0];
      if (worst.doc.result === 'pass') passed.set(set.map((t) => t.task).join(' '), commit);
      return { ...worst, commit, byTask };
    };
    let set = build(candidates);
    if (set.length === 0) return finish(result);
    let out = gates(set);
    let final = set;
    let integrated = out.commit;
    if (out.doc.result === 'error') throw new SequentialFallback(`the first batch gate run could not run: ${out.reasons.find((r) => r.level !== 'warn')?.message ?? 'gate error'}`);
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
      // the culprit's own check when it failed (its report, its baseline), else the run's first failure
      const own = failedRun.byTask.get(culprit.task);
      const blame = own && own.doc.result !== 'pass' ? own : failedRun;
      culprit.outcome = 'failed';
      culprit.tests = blame.doc.failures.new.slice(0, 10);
      culprit.why = culprit.tests.length ? `new failing tests: ${culprit.tests.join(', ')}` : (blame.reasons.find((x) => x.code !== 'gate-error')?.message ?? 'the gates fail').slice(0, 300);
      result.verify = blame.doc;
      result.output = blame.output;
      const rest = set.filter((t) => t !== culprit);
      final = rest.length ? build(rest) : [];
      integrated = null;
      if (final.length) {
        const confirm = gates(final);
        if (confirm.doc.result === 'pass') integrated = confirm.commit;
        else {
          // A second failure among the rest: only the prefix before the culprit (a passing run) merges.
          const after = set.slice(lo + 1);
          for (const t of after) if (t.outcome === null) { t.outcome = 'skipped'; t.why = `not verified: the batch fails also without ${culprit.task} (merge them again)`; }
          final = lo > 0 ? set.slice(0, lo) : [];
          integrated = final.length ? passed.get(final.map((t) => t.task).join(' ')) ?? null : null;
          if (integrated === null) final = [];
        }
      }
      if (final.length === 0) return finish(result);
    }
    set = final;
    // 4. The final integrated profile must not change the target's gates (each branch was checked alone in step 1).
    const finalChanges = targetProfile.rel === null ? [] : gateChanges(profileOf(targetProfile.text), profileOf(stateAt(where, env, integrated, 'profile.json').text));
    if (finalChanges.length) {
      for (const t of set) { t.outcome = 'skipped'; t.why = 'gate-change-required'; }
      result.reasons.push({ code: 'gate-change-required', message: `the integrated batch changes the gates in ${join(targetProfile.rel, 'profile.json')}: ${describeChanges(finalChanges)}; nothing was merged`, hint: `merge the tasks one by one: ${names.bin} task merge <id>` });
      return finish(result);
    }
    // Fast-forward the target to the verified commit (F5, fix round 2). Only the ref read before the gates moves, by one
    // compare-and-swap (`git update-ref <ref> <new> <old>`; detached: HEAD itself, --no-deref), never through HEAD, so no
    // other branch can move whatever the checkout holds meanwhile. The checkout must hold that ref at the old tip just
    // before and at the new commit just after; otherwise the ref is swapped back and nothing is merged. The working tree
    // then follows by the two-tree read-tree a fast-forward does (local state writes are kept; a conflicting one is
    // found by a dry run first).
    const moved = () => {
      for (const t of set) { t.outcome = 'skipped'; t.why = 'target-moved'; }
      result.reasons.push({ code: 'target-moved', message: `${target} moved from ${tip.slice(0, 12)}, or the checkout changed branch, while the gates ran; nothing was merged`, hint: `${names.bin} task merge ${ready ? '--ready' : list.join(' ')}` });
      return finish(result);
    };
    const ffFailed = (why) => {
      for (const t of set) { t.outcome = 'skipped'; t.why = 'ff-failed'; }
      result.reasons.push({ code: 'ff-failed', message: `the target cannot be fast-forwarded: ${why}`.slice(0, 300), hint: 'check the working tree of the target, then merge again' });
      return finish(result);
    };
    const firstLine = (r) => (r.stderr || r.stdout).trim().split('\n')[0] ?? '';
    const holds = (sha) => symbolic() === targetRef && head() === sha && (targetRef === null || gitIn(where, env, ['rev-parse', '--verify', '-q', targetRef]).stdout.trim() === sha);
    if (!holds(tip)) return moved();
    if (gitIn(where, env, ['merge-base', '--is-ancestor', '--end-of-options', tip, integrated]).status !== 0) return ffFailed('the verified commit does not descend from the target tip');
    gitIn(where, env, ['update-index', '-q', '--refresh']);
    const dry = gitIn(where, env, ['read-tree', '-n', '-m', '-u', tip, integrated]);
    if (dry.status !== 0) return ffFailed(firstLine(dry));
    const ref = targetRef ?? 'HEAD';
    const swap = (to, from) => gitIn(where, env, ['update-ref', ...(targetRef === null ? ['--no-deref'] : []), '-m', `${names.bin} task merge: ${batch}`, ref, to, from]);
    const cas = swap(integrated, tip);
    if (cas.status !== 0) return moved();
    if (!holds(integrated)) { swap(tip, integrated); return moved(); }
    const rt = gitIn(where, env, ['read-tree', '-m', '-u', tip, integrated]);
    if (rt.status !== 0) { swap(tip, integrated); return ffFailed(firstLine(rt)); }
    result.commit = integrated;
    const tree = gitIn(where, env, ['rev-parse', `${integrated}^{tree}`]).stdout.trim();
    recordMerged({ cwd, env, names, at, entries: set.map((t) => ({ id: t.task, data: { commit: integrated, target, batch, adopted: false, verify: tree } })) });
    for (const t of set) {
      t.outcome = 'merged'; t.why = null;
      Object.assign(t, refreshReceipt({ cwd, env, names, id: t.task, mergedAt: at }));
    }
    if (!result.verify) { result.verify = out.doc; result.output = out.output; }
    return finish(result);
  } catch (err) {
    if (err instanceof SequentialFallback) return sequential(err.message);
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
