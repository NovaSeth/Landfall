// The route of a task after re-classifying its change (split from verify/run.mjs, T-MG-141).
import { classify } from './classify.mjs';
import { applyClass, recordedKeys, routeTask, routerThresholds } from './ratchet.mjs';
import { addedSteps, rank } from './routes.mjs';

// { route (verify.json), flags } after re-classifying the change; writes the ratchet in write mode.
export function reroute({ store, task, id, write, handle, riskPaths, change, at }) {
  const declared = task.class;
  const route = { declared, actual: declared, escalated: false, missingSteps: [] };
  let flags = recordedKeys(task).flags;
  if (change.paths.length === 0) return { route, flags };
  const plan = { paths: change.paths, loc: change.loc, locCode: change.locCode, flags: [], riskPaths };
  if (write) {
    const r = routeTask(store, id, { ...plan, handle, at });
    flags = recordedKeys(store.read('task', id)).flags;
    return { route: { declared, actual: r.class, escalated: r.escalated, missingSteps: [...r.addedSteps] }, flags };
  }
  const step = applyClass(task, classify({ ...plan, thresholds: routerThresholds(store) }), { at, by: handle ?? 'verify' });
  const actual = step.next?.class ?? declared;
  const escalated = declared !== null && rank(actual) > rank(declared);
  return { route: { declared, actual, escalated, missingSteps: escalated ? [...addedSteps(declared, actual, { flags: step.flags })] : [] }, flags: step.flags };
}
