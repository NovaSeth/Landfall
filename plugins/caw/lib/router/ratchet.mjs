// Ratchet and overrides (spec §7.5, SD-14, §5.1): the router's writes to task.json, all through lib/state
// (store.update holds the one store lock; every check is repeated inside it), owner only.
// What the task remembers (task.json has no plan fields, so it lives in its event log):
//   `route` events      {computed, keys}: the reason keys (classify `all`, above trivial) of each classification
//                       that brought keys not recorded before; several events when the keys exceed the event size
//   `route-override`    {decision, from, to}: the boundary of a waiver; it counts only when classHistory holds the
//                       router's override entry naming the same decision (another writer cannot forge a waiver)
// The flags of the task are the union of the flags in its recorded keys (a flag seen once keeps its route step).
// - routeTask classifies the plan. The first class is set. Later, the reasons waived by an override (the keys
//   recorded before its boundary) are left out; the class rises when the rest gives a higher class (escalated:
//   class and classHistory); otherwise it is held (lower or waived) or unchanged (equal). New keys are recorded in
//   any case; when there is nothing new and no rise, nothing is written.
// - overrideTask is the only way down: `to` below the stored class needs by = 'user' and the user's quote; it
//   records a route-override decision (D-<handle>-<n>, lib/state ID allocation) listing the waived reasons, then
//   lowers the class with a classHistory entry naming that decision and appends the boundary event. A reason not
//   recorded before that boundary is never waived by it. Raising needs no decision; the same class writes nothing.
// Accepted residual: the decision and the task are two writes under two lock holds (the store lock is not
// re-entrant). If the task changed in between (class or recorded reasons) or the process stops, the decision stays
// without effect; the error names it.
import { thresholdsOf } from '../config/index.mjs';
import { LIMITS, allocateId } from '../state/index.mjs';
import { FLAGS, THRESHOLDS, classify, publicReasons } from './classify.mjs';
import { checkQuote, renderOverride } from './decision.mjs';
import { RouteError, usage } from './errors.mjs';
import { CLASSES, addedSteps, rank, routeFor } from './routes.mjs';

export const ROUTE_EVENT = 'route';
export const OVERRIDE_EVENT = 'route-override';
const C = CLASSES.join('|');
const OVERRIDE_REASON = new RegExp(`^override from (?:${C}) to (?:${C}) by user, decision (D-[A-Z]{2,4}-[1-9]\\d{0,5})$`);
const overrideReason = (from, to, decision) => `override from ${from} to ${to} by user, decision ${decision}`;

// { keys, waived, flags } of a task: every recorded reason key, the keys recorded before its last confirmed
// override boundary, and the flags among the keys.
export function recordedKeys(task) {
  const confirmed = new Set();
  for (const h of task.classHistory) {
    const m = OVERRIDE_REASON.exec(h.reason);
    if (m) confirmed.add(m[1]);
  }
  const keys = new Set();
  let waived = new Set();
  for (const e of task.events) {
    if (e.event === ROUTE_EVENT && Array.isArray(e.data?.keys)) {
      for (const k of e.data.keys) if (typeof k === 'string') keys.add(k);
    } else if (e.event === OVERRIDE_EVENT && confirmed.has(e.data?.decision)) {
      waived = new Set(keys);
    }
  }
  return { keys, waived, flags: FLAGS.filter((f) => keys.has(`risk-flag:${f}`) || keys.has(`flag:${f}`)) };
}

// The classHistory reason of a classification: "<class>: <reason texts>", within the reason limit.
export function summarize(cls, reasons) {
  const texts = [...new Set(reasons.map((r) => r.text))];
  for (let n = texts.length; n >= 1; n--) {
    const more = texts.length - n;
    const s = `${cls}: ${texts.slice(0, n).join('; ')}${more ? ` (+${more} more)` : ''}`;
    if (s.length <= LIMITS.reason) return s;
  }
  return `${cls}: ${texts.length} reasons`;
}

// `route` events for new keys, each within the event data limit.
function routeEvents(computed, keys, { at, by }) {
  const chunks = [];
  let chunk = [];
  const size = (ks) => Buffer.byteLength(JSON.stringify({ computed, keys: ks }));
  for (const k of keys) {
    if (chunk.length && size([...chunk, k]) > LIMITS.eventData) { chunks.push(chunk); chunk = []; }
    chunk.push(k);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.map((ks) => ({ at, by, event: ROUTE_EVENT, data: { computed, keys: ks } }));
}

// Pure: the next task document (null: write nothing), the outcome, the reasons behind the class and the task's flags.
export function applyClass(task, plan, { at, by }) {
  const { keys, waived } = recordedKeys(task);
  const fresh = [...new Set(plan.all.filter((r) => r.level !== 'trivial' && !keys.has(r.key)).map((r) => r.key))];
  for (const k of fresh) keys.add(k);
  const flags = FLAGS.filter((f) => keys.has(`risk-flag:${f}`) || keys.has(`flag:${f}`));
  const previous = task.class;
  let cls = previous;
  let reasons = plan.reasons;
  let outcome;
  if (previous === null) {
    cls = plan.class;
    outcome = 'classified';
  } else {
    const open = plan.all.filter((r) => r.level !== 'trivial' && !waived.has(r.key));
    const target = open.some((r) => r.level === 'critical') ? 'critical' : open.length ? 'standard' : 'trivial';
    if (rank(target) > rank(previous)) {
      cls = target;
      reasons = publicReasons(open.filter((r) => r.level === target));
      outcome = 'escalated';
    } else {
      outcome = plan.class === previous ? 'unchanged' : 'held';
    }
  }
  if (cls === previous && fresh.length === 0) return { next: null, previous, outcome, reasons, flags };
  const next = { ...task };
  if (cls !== previous) {
    next.class = cls;
    next.classHistory = [...task.classHistory, { class: cls, reason: summarize(cls, reasons), at }];
  }
  if (fresh.length) next.events = [...task.events, ...routeEvents(plan.class, fresh, { at, by })];
  return { next, previous, outcome, reasons, flags };
}

function owned(doc, id, handle) {
  if (doc === null) throw usage('task-not-found', `no task ${id}`, 'list the tasks of this repository with their IDs');
  if (typeof handle !== 'string' || doc.owner !== handle) {
    throw new RouteError('not-owner', 'REFUSED', `${id} belongs to ${doc.owner}; only its owner changes its class`, { hint: `ask ${doc.owner} to route it` });
  }
  return doc;
}

const changed = (id, decision) => new RouteError('task-changed', 'FAIL', `${id} changed while the override was written${decision ? `; decision ${decision} was recorded without effect` : ''}`, {
  hint: 'show the task and repeat the override if it is still wanted',
});

function result({ id, doc, previous, computed, outcome, reasons, flags, decision = null }) {
  const escalated = previous !== null && rank(doc.class) > rank(previous);
  return {
    task: id,
    class: doc.class,
    computed,
    previous,
    outcome,
    escalated,
    reasons,
    route: routeFor(doc.class, { flags }),
    addedSteps: escalated ? addedSteps(previous, doc.class, { flags }) : [],
    decision,
  };
}

// The router thresholds of the repository behind `store`: the shipped ones with the overrides of its config.json.
export const routerThresholds = (store) => thresholdsOf('router', THRESHOLDS, store.read('config', null)).data;

// Classifies the declared plan of task `id` and applies the ratchet. `handle` is the caller's registered handle;
// `riskPaths` are the profile's risk globs (added to the defaults).
export function routeTask(store, id, { paths, loc, flags = [], riskPaths = [], handle, at = new Date().toISOString() }) {
  const plan = classify({ paths, loc, flags, riskPaths, thresholds: routerThresholds(store) });
  let step;
  const doc = store.update('task', id, (cur) => {
    step = applyClass(owned(cur, id, handle), plan, { at, by: handle });
    return step.next ?? undefined;
  });
  return { ...result({ id, doc, previous: step.previous, computed: plan.class, outcome: step.outcome, reasons: step.reasons, flags: step.flags }), input: { files: plan.files, loc: plan.loc, flags: plan.flags } };
}

// Sets the class of task `id` to `to` on the user's word (see the header).
export function overrideTask(store, id, { to, by, quote, handle, at = new Date().toISOString() }) {
  routeFor(to);
  if (by !== 'user') throw usage('invalid-by', 'an override is the user\'s decision: pass --by user', 'only the user can change a task\'s class; nothing was written');
  const words = checkQuote(quote);
  const cur = owned(store.read('task', id), id, handle);
  const from = cur.class;
  if (from === null) throw new RouteError('not-classified', 'FAIL', `${id} has no class yet; there is nothing to override`, { hint: 'classify its plan first (--paths and --loc)' });
  const { keys, flags } = recordedKeys(cur);
  const reasons = (text) => [{ code: 'override', text }];
  if (to === from) return result({ id, doc: cur, previous: from, computed: null, outcome: 'unchanged', reasons: reasons(`already ${to}`), flags });
  // The task must be exactly as read: same class and same recorded reasons (keys only ever grow).
  const same = (c) => owned(c, id, handle).class === from && recordedKeys(c).keys.size === keys.size;

  if (rank(to) > rank(from)) {
    const reason = `raised from ${from} by user`;
    const doc = store.update('task', id, (c) => {
      if (!same(c)) throw changed(id, null);
      return { ...c, class: to, classHistory: [...c.classHistory, { class: to, reason, at }] };
    });
    return result({ id, doc, previous: from, computed: null, outcome: 'raised', reasons: reasons(reason), flags });
  }

  const decision = allocateId(store, { prefix: 'D', handle, build: (did) => renderOverride({ id: did, task: id, from, to, quote: words, author: handle, at, waived: [...keys] }) });
  const reason = overrideReason(from, to, decision);
  const doc = store.update('task', id, (c) => {
    if (!same(c)) throw changed(id, decision);
    return {
      ...c,
      class: to,
      classHistory: [...c.classHistory, { class: to, reason, at }],
      events: [...c.events, { at, by: handle, event: OVERRIDE_EVENT, data: { decision, from, to } }],
    };
  });
  return result({ id, doc, previous: from, computed: null, outcome: 'overridden', reasons: reasons(reason), flags, decision });
}
