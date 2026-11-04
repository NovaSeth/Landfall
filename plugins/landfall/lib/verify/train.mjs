// `train <id…> | --ready` (T-MG-186, D-MG-65): the merge train. Approved tasks (the review step of their route approved,
// or closed by a review-close decision; done is not required) merge as one batch (batch.mjs: a temporary integration
// branch and worktree from the target tip, --no-ff merges, a conflict leaves only that task out, one gate run under the
// heavy lease, a failure bisected out and the rest run once more, the target fast-forwarded only when it did not move).
// The train differs from `task merge --ready` in three points:
//   - who: the caller's tasks, not cancelled, not merged, with a class and a branch, whose route's review is approved
//     (or needs none); a done one is taken as `task merge` takes it. A task that is not done is checked on its real
//     change, read-only (fix round 1): the branch's change since its merge base with the target is classified again
//     (the class only rises) and the review the raised class needs is required (F1); a needed review binds the commit
//     it reviewed (the `head` of its review event, written by `review record`): the tip must be it, or differ from it
//     only in the state directory (F2). A tip already on the target is taken too (F3: a train that died after its
//     fast-forward is recovered by the next one; the merge is empty and the gate runs on a tree containing the tip);
//   - order: a task after the tasks it waits for (--after), else in task ID order;
//   - record: on pass every task of the train gets `merged` and, when not done yet, `done` in the same run: the passing
//     train gate on a tree that contains the task tip is the task's verify (FLW-8, GC3). verify.json holds that run's
//     evaluation of the task (its own report evidence and the test baseline: a removed or skipped test still needs a
//     decision) with mode train, the gate's commit, the fast-forwarded head and the batch id.
import { authorHandle } from '../decisions/index.mjs';
import { closeFindings, findingsForTask } from '../findings/index.mjs';
import { emptyProfile, riskGlobsOf } from '../profile/index.mjs';
import { lightMatcher, riskMatcher } from '../router/classify.mjs';
import { applyClass, classify, rank, recordedKeys, routeFor, routerThresholds, weightless } from '../router/index.mjs';
import { KINDS, afterOf, mergedOf } from '../state/index.mjs';
import { appliedTier, reviewNeed, reviewState } from './artifacts.mjs';
import { batchMerge } from './batch.mjs';
import { activeWhere, gitIn, storeOf } from './run.mjs';

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

const byId = (a, b) => {
  const [pa, na] = [a.replace(/-\d+$/, ''), Number(a.match(/(\d+)$/)?.[1] ?? 0)];
  const [pb, nb] = [b.replace(/-\d+$/, ''), Number(b.match(/(\d+)$/)?.[1] ?? 0)];
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
};

// The review state of a task's route: approved | missing | not-required (null: no class, so no route).
const reviewOf = (store, task) => (task.class === null ? null : reviewState(store, task.id, routeFor(task.class, { flags: recordedKeys(task).flags }).steps));

// Why a task that is not done cannot ride the train by its recorded class, or null (the cheap filter of --ready).
export function unfit(store, task) {
  if (task.class === null) return 'not classified (route it first)';
  return reviewOf(store, task) === 'missing' ? `its ${task.class} route needs an approved review` : null;
}

// The change a merge of `sha` brings onto `tip`: the paths and the counted LOC of merge-base..sha, the state directory
// left out (`scope`); null when git cannot tell.
function mergeChangeOf({ where, env, tip, sha, scope, light, risky }) {
  const base = gitIn(where, env, ['merge-base', '--end-of-options', tip, sha]).stdout.trim();
  if (!OBJECT_ID.test(base)) return null;
  const d = gitIn(where, env, ['diff', '--numstat', '-z', '--no-renames', '--end-of-options', base, sha, ...scope]);
  if (d.status !== 0) return null;
  const paths = [];
  let loc = 0;
  for (const rec of d.stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    paths.push(m[3]);
    if (m[1] !== '-' && (risky(m[3]) || (!weightless(m[3]) && !light(m[3])))) loc += Number(m[1]) + Number(m[2]);
  }
  return { paths, loc };
}

// The train's checks of a task that is not done (F1, F2): { why: null | reason, route }.
export function eligible({ store, task, where, env, tip, sha, scope, at }) {
  const why = unfit(store, task);
  if (task.class === null) return { why, route: null };
  const profile = store.read('profile', null) ?? emptyProfile();
  const riskPaths = riskGlobsOf(profile);
  const thresholds = routerThresholds(store);
  const change = mergeChangeOf({ where, env, tip, sha, scope, light: lightMatcher(thresholds), risky: riskMatcher(riskPaths) });
  if (change === null) return { why: 'git cannot compare its branch with the target', route: null };
  const step = change.paths.length ? applyClass(task, classify({ paths: change.paths, loc: change.loc, flags: [], riskPaths, thresholds }), { at, by: 'train' }) : null;
  const actual = step?.next?.class ?? task.class;
  const flags = step ? step.flags : recordedKeys(task).flags;
  const escalated = rank(actual) > rank(task.class);
  const route = { declared: task.class, actual, escalated, missingSteps: [] };
  const review = reviewState(store, task.id, routeFor(actual, { flags }).steps);
  if (review === 'missing') return { why: escalated ? `the change is ${actual}, not ${task.class}: its route needs an approved review` : why ?? `its ${actual} route needs an approved review`, route };
  if (reviewNeed(actual, appliedTier(store)) === 'none') return { why: null, route };
  // the reviewed commit: the head of the latest review event
  const head = [...task.events].reverse().find((e) => e.event === 'review')?.data?.head;
  if (typeof head !== 'string' || !OBJECT_ID.test(head)) return { why: 'its review records no reviewed commit (record the review again with review record)', route };
  if (head !== sha && gitIn(where, env, ['diff', '--quiet', '--end-of-options', head, sha, ...scope]).status !== 0) {
    return { why: `the branch changed since its review at ${head.slice(0, 12)} (review the new commits, then record the review)`, route };
  }
  return { why: null, route };
}

// The IDs `train --ready` takes: the caller's open, unmerged tasks with a branch that are done or approved, in ID order.
export function trainIds(store, handle) {
  return store.list('task').map((id) => store.read('task', id))
    .filter((t) => t && t.owner === handle && t.status !== 'cancelled' && t.branch && mergedOf(t) === null && (t.status === 'done' || unfit(store, t) === null))
    .map((t) => t.id).sort(byId);
}

// The tasks in merge order: each after the tasks of the train it waits for (--after), else by ID (a cycle keeps ID order).
export function trainOrder(store, tasks) {
  const rest = [...tasks].sort((a, b) => byId(a.task, b.task));
  const inTrain = new Set(rest.map((t) => t.task));
  const waits = new Map(rest.map((t) => [t.task, afterOf(store.read('task', t.task)).filter((x) => inTrain.has(x))]));
  const out = [];
  const placed = new Set();
  while (rest.length) {
    const k = rest.findIndex((t) => waits.get(t.task).every((x) => placed.has(x)));
    const [next] = rest.splice(k === -1 ? 0 : k, 1);
    out.push(next);
    placed.add(next.task);
  }
  return out;
}

// On a passing train: each task's verify (the train gate's evaluation) and its done, in one store batch.
function recordTrain({ store, set, integrated, batch, byTask, handle, at }) {
  store.batch((s) => {
    for (const t of set) {
      const cur = s.read('task', t.task);
      if (cur === null || cur.status === 'done' || cur.status === 'cancelled') continue;
      const run = byTask?.get(t.task);
      if (!run || run.doc.result !== 'pass') continue;
      const route = t.route ?? run.doc.route;
      const review = reviewState(store, t.task, routeFor(route.actual, { flags: recordedKeys(cur).flags }).steps);
      s.write('verify', t.task, { ...run.doc, head: integrated, class: route.actual, route, artifacts: { ...run.doc.artifacts, review }, mode: 'train', train: { commit: run.doc.head ?? integrated, head: integrated, batch } });
      const pending = findingsForTask(s, t.task).filter((f) => f.status === 'taken');
      s.update('task', t.task, (doc) => ({ ...doc, status: 'done', events: [...doc.events, { at, by: handle, event: 'done', data: { head: integrated } }] }));
      closeFindings(s, pending, { by: t.task, reason: `Fixed by ${t.task}`, at });
      t.done = true;
    }
  });
}

export function runTrain({ cwd, env, names, ids = [], ready = false, version = null, at, now }) {
  if (!ready) for (const id of ids) KINDS.task.path(id);
  const where = activeWhere({ cwd, env, names });
  const store = storeOf(where, names);
  authorHandle({ store, where, names, env });
  return batchMerge({ cwd, env, names, ids, ready, version, ...(at ? { at } : {}), ...(now ? { now } : {}), train: { ready: trainIds, eligible, order: trainOrder, record: recordTrain } });
}
