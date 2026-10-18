// Router unit (spec §4.2, §7.5, SD-14, SD-15): classify, ratchet, overrides. The public interface; other units
// import only this file. The router writes only the class fields and its own events of task.json and
// route-override decisions, all through lib/state.
export { RouteError } from './errors.mjs';
export { CRITICAL_FLAGS, DEFAULT_RISK_PATHS, FLAGS, MAX_PATHS, THRESHOLDS, classify, compileGlob, globMatch, normalizePath } from './classify.mjs';
export { CLASSES, OUTCOME_GATES, addedSteps, higher, rank, routeFor } from './routes.mjs';
export { OVERRIDE_EVENT, ROUTE_EVENT, applyClass, overrideTask, recordedKeys, routeTask, routerThresholds } from './ratchet.mjs';
