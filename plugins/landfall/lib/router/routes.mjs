// Routes per class (spec §7.5) and the outcome gates (SD-15). The route is how much ceremony a task gets; the
// outcome gates are what it must pass to close, and they are one frozen list, the same for every class (and
// every tier): review, spec and plan depth scale, gates do not.
//   trivial   implement → verify → done
//   standard  plan in the brief → implement → verify → review (who reviews depends on the tier) → done
//   critical  spec and plan → implement → verify → cross-provider review → rereview → decision record (only for
//             an irreversible change) → done
import { usage } from './errors.mjs';

export const CLASSES = Object.freeze(['trivial', 'standard', 'critical']);

// SD-15: (1) every profile gate passes when verify re-runs it, (2) the test baseline did not shrink without a
// decision, (3) the task report has RED/GREEN evidence, (4) the state files validate.
export const OUTCOME_GATES = Object.freeze(['profile-gates-pass', 'test-baseline-kept', 'report-red-green', 'state-valid']);

const STEPS = Object.freeze({
  trivial: Object.freeze(['implement', 'verify', 'done']),
  standard: Object.freeze(['plan-in-brief', 'implement', 'verify', 'review', 'done']),
  critical: Object.freeze(['spec-plan', 'implement', 'verify', 'cross-provider-review', 'rereview', 'done']),
});

export const rank = (cls) => CLASSES.indexOf(cls);
// The higher of two classes; null counts as lower than any class.
export const higher = (a, b) => (b !== null && b !== undefined && rank(b) > rank(a ?? null) ? b : a ?? null);

function checkClass(cls) {
  if (!CLASSES.includes(cls)) throw usage('invalid-class', `${JSON.stringify(String(cls).slice(0, 40))} is not a class`, `classes: ${CLASSES.join(', ')}`);
}

// { class, steps, gates } of a class; `flags` are the declared risk flags (irreversible adds the decision record).
export function routeFor(cls, { flags = [] } = {}) {
  checkClass(cls);
  let steps = STEPS[cls];
  if (cls === 'critical' && flags.includes('irreversible')) steps = Object.freeze([...steps.slice(0, -1), 'decision-record', steps[steps.length - 1]]);
  return Object.freeze({ class: cls, steps, gates: OUTCOME_GATES });
}

// The steps the route of `to` has and the route of `from` (null: no class yet) does not, in route order.
export function addedSteps(from, to, { flags = [] } = {}) {
  const had = from === null ? [] : routeFor(from, { flags }).steps;
  return routeFor(to, { flags }).steps.filter((s) => !had.includes(s));
}
