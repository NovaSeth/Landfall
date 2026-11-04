// `train <id…> | --ready` (T-MG-186, D-MG-65): the merge train. Approved tasks (the review step of their route approved,
// or closed by a review-close decision; done is not required) merge as one batch (batch.mjs: a temporary integration
// branch and worktree from the target tip, --no-ff merges, a conflict leaves only that task out, one gate run under the
// heavy lease, a failure bisected out and the rest run once more, the target fast-forwarded only when it did not move).
// The train differs from `task merge --ready` in three points:
//   - who: the caller's tasks, not cancelled, not merged, with a class and a branch, whose route's review is approved
//     (or needs none); a done one is taken as `task merge` takes it;
//   - order: a task after the tasks it waits for (--after), else in task ID order;
//   - record: on pass every task of the train gets `merged` and, when not done yet, `done` in the same run: the passing
//     train gate on a tree that contains the task tip is the task's verify (FLW-8, GC3). verify.json holds that run's
//     evaluation of the task (its own report evidence and the test baseline: a removed or skipped test still needs a
//     decision) with mode train, the gate's commit, the fast-forwarded head and the batch id.
import { authorHandle } from '../decisions/index.mjs';
import { closeFindings, findingsForTask } from '../findings/index.mjs';
import { recordedKeys, routeFor } from '../router/index.mjs';
import { KINDS, afterOf, mergedOf } from '../state/index.mjs';
import { reviewState } from './artifacts.mjs';
import { batchMerge } from './batch.mjs';
import { activeWhere, storeOf } from './run.mjs';

const byId = (a, b) => {
  const [pa, na] = [a.replace(/-\d+$/, ''), Number(a.match(/(\d+)$/)?.[1] ?? 0)];
  const [pb, nb] = [b.replace(/-\d+$/, ''), Number(b.match(/(\d+)$/)?.[1] ?? 0)];
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
};

// The review state of a task's route: approved | missing | not-required (null: no class, so no route).
const reviewOf = (store, task) => (task.class === null ? null : reviewState(store, task.id, routeFor(task.class, { flags: recordedKeys(task).flags }).steps));

// Why a task that is not done cannot ride the train, or null.
export function unfit(store, task) {
  if (task.class === null) return 'not classified (route it first)';
  return reviewOf(store, task) === 'missing' ? `its ${task.class} route needs an approved review` : null;
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
      const review = reviewOf(store, cur) ?? 'missing';
      s.write('verify', t.task, { ...run.doc, head: integrated, artifacts: { ...run.doc.artifacts, review }, mode: 'train', train: { commit: run.doc.head ?? integrated, head: integrated, batch } });
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
  return batchMerge({ cwd, env, names, ids, ready, version, ...(at ? { at } : {}), ...(now ? { now } : {}), train: { ready: trainIds, eligible: unfit, order: trainOrder, record: recordTrain } });
}
