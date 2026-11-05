// `train <id…> | --ready` (T-MG-186, D-MG-65): the merge train. Approved tasks (the review step of their route approved,
// or closed by a review-close decision; done is not required) merge as one batch (batch.mjs: a temporary integration
// branch and worktree from the target tip, --no-ff merges, a conflict leaves only that task out, one gate run under the
// heavy lease, a failure bisected out and the rest run once more, the target fast-forwarded only when it did not move).
// The train differs from `task merge --ready` in three points:
//   - who: the caller's tasks, not cancelled, not merged, with a class and a branch; a done one is taken as `task merge`
//     takes it. A task that is not done passes `eligible`, the one check made at selection, again before the
//     fast-forward and again inside the lock of the record (fix round 2, F2): nothing `task merge` would refuse rides.
//     A tip already on the target is taken too (a train that died after its fast-forward is recovered by the next one);
//   - order: a task after the tasks it waits for (--after), else in task ID order;
//   - record: on pass every task of the train gets `merged` and, when not done yet, `done` { head, mode: train } in the
//     same run: the passing train gate on a tree that contains the task tip is the task's verify (FLW-8, GC3).
//     verify.json holds that run's evaluation of the task (its report evidence and its test baseline against its own
//     merge base with the target, F3) with mode train, the gate's commit, the fast-forwarded head and the batch id.
import { authorHandle } from '../decisions/index.mjs';
import { closeFindings, findingsForTask } from '../findings/index.mjs';
import { emptyProfile, riskGlobsOf } from '../profile/index.mjs';
import { lightMatcher, riskMatcher } from '../router/classify.mjs';
import { addedSteps, applyClass, classify, rank, recordedKeys, routeFor, routerThresholds, weightless } from '../router/index.mjs';
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

// The change a merge of `sha` brings onto the target: the paths and the counted LOC of base..sha (`base`: their merge
// base), the state directory left out (`scope`); null when git cannot tell.
function mergeChangeOf({ where, env, base, sha, scope, light, risky }) {
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

// The eligibility of a train's task that is not done: { why: null | reason, route }. As verify and `task done` decide:
// the real change (base..sha) classified again; an escalated route refuses until its added steps exist (F7, verify's
// route-escalated: verify records the raised class, whose route then needs its own review); the latest review round
// approved for the route; a needed review bound to the tip (the head of its review event, F2 F5).
export function eligible({ store, task, where, env, base, sha, scope, at }) {
  if (task.class === null) return { why: 'not classified (route it first)', route: null };
  const riskPaths = riskGlobsOf(store.read('profile', null) ?? emptyProfile());
  const thresholds = routerThresholds(store);
  const change = mergeChangeOf({ where, env, base, sha, scope, light: lightMatcher(thresholds), risky: riskMatcher(riskPaths) });
  if (change === null) return { why: 'git cannot compare its branch with the target', route: null };
  const step = change.paths.length ? applyClass(task, classify({ paths: change.paths, loc: change.loc, flags: [], riskPaths, thresholds }), { at, by: 'train' }) : null;
  const actual = step?.next?.class ?? task.class;
  const flags = step ? step.flags : recordedKeys(task).flags;
  if (rank(actual) > rank(task.class)) {
    return { why: `the change is ${actual}, not ${task.class}: the route adds ${addedSteps(task.class, actual, { flags }).join(', ')} (verify records the raised class; do the added steps, then run the train again)`, route: null };
  }
  const route = { declared: task.class, actual, escalated: false, missingSteps: [] };
  if (reviewState(store, task.id, routeFor(actual, { flags }).steps) === 'missing') return { why: `its ${actual} route needs an approved review of its latest round`, route };
  if (reviewNeed(actual, appliedTier(store)) === 'none') return { why: null, route };
  const head = [...task.events].reverse().find((e) => e.event === 'review')?.data?.head;
  if (typeof head !== 'string' || !OBJECT_ID.test(head)) return { why: 'its review records no reviewed commit (record the review again with review record)', route };
  if (head !== sha && gitIn(where, env, ['diff', '--quiet', '--end-of-options', head, sha, ...scope]).status !== 0) {
    return { why: `the branch changed since its review at ${head.slice(0, 12)} (review the new commits, then record the review)`, route };
  }
  return { why: null, route };
}

// The IDs `train --ready` takes: the caller's open, unmerged tasks with a branch that are done or whose route's review is
// not missing, in ID order (a cheap filter: each is checked in full by `eligible`).
export function trainIds(store, handle) {
  const reviewed = (t) => t.class !== null && reviewState(store, t.id, routeFor(t.class, { flags: recordedKeys(t).flags }).steps) !== 'missing';
  return store.list('task').map((id) => store.read('task', id))
    .filter((t) => t && t.owner === handle && t.status !== 'cancelled' && t.branch && mergedOf(t) === null && (t.status === 'done' || reviewed(t)))
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

// On a passing train: each task's verify (the train gate's evaluation) and its done, in one store batch. `check` runs
// the selection checks again inside the lock (F2): a task that fails them now gets nothing (t.refused: the reason).
function recordTrain({ store, set, integrated, batch, byTask, handle, at, check }) {
  store.batch((s) => {
    for (const t of set) {
      const cur = s.read('task', t.task);
      if (cur === null || cur.status === 'done' || cur.status === 'cancelled') continue;
      const run = byTask?.get(t.task);
      const why = check(t, s);
      if (why || !run || run.doc.result !== 'pass') { t.refused = why ?? 'no passing train gate for it'; continue; }
      const review = reviewState(s, t.task, routeFor(t.route.actual, { flags: recordedKeys(cur).flags }).steps);
      s.write('verify', t.task, { ...run.doc, head: integrated, class: t.route.actual, route: t.route, artifacts: { ...run.doc.artifacts, review }, mode: 'train', train: { commit: run.doc.head ?? integrated, head: integrated, batch } });
      const pending = findingsForTask(s, t.task).filter((f) => f.status === 'taken');
      s.update('task', t.task, (doc) => ({ ...doc, status: 'done', events: [...doc.events, { at, by: handle, event: 'done', data: { head: integrated, mode: 'train' } }] }));
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
