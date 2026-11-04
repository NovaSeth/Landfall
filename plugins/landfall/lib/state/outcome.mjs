// Task outcomes (T-MG-118, plan M1.3, decision D-MG-38): what a cancelled task delivered or was replaced by.
// proposeOutcome reads the free-text reason of a `cancelled` event with strict, start-anchored patterns (the leading
// word in any case, the ID only from the token right after the phrase, ending at a word boundary, no nested quantifier);
// setOutcome records { kind, by, at } on a cancelled task in one store.update; adoptOutcomes runs that over the tasks of
// a handle, one update per task, so a run stopped midway leaves each task fully adopted or untouched (plan RF2).
import { StateError } from './errors.mjs';
import { PATTERNS } from './kinds.mjs';

export const OUTCOME_KINDS = Object.freeze(['delivered', 'superseded', 'dropped']);

// The token ends at a word boundary: no word character, hyphen or "." + word character may follow.
const END = String.raw`(?![\w-]|\.\w)`;
const TASK = String.raw`(T-[A-Z]{2,4}-[1-9]\d{0,5})${END}`;
const RULES = [
  [new RegExp(`^delivered in ${TASK}`, 'i'), 'delivered', (m) => m[1]],
  [new RegExp(`^superseded by ${TASK}`, 'i'), 'superseded', (m) => m[1]],
  [new RegExp(`^stale record: shipped in v?(\\d+\\.\\d+\\.\\d+)${END}`, 'i'), 'delivered', (m) => `v${m[1]}`],
  [new RegExp(`^(?:stale record: )?merged as ([0-9a-f]{7,40})${END}`, 'i'), 'delivered', (m) => m[1]],
  [/^split into\b/i, 'superseded', () => null],
  [/^deferred\b/i, 'dropped', () => null],
];

// { kind, by } or null. `by` passes PATTERNS.outcomeBy or is null (split, deferred).
export function proposeOutcome(reason) {
  if (typeof reason !== 'string') return null;
  const text = reason.trim();
  for (const [re, kind, by] of RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const ref = by(m);
    return ref === null || PATTERNS.outcomeBy.test(ref) ? { kind, by: ref } : null;
  }
  return null;
}

const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });

// Sets the outcome on `doc` (a cancelled task) and appends the `outcome` event. Returns false when the same outcome
// is already there (nothing changed); a different one is refused.
export function applyOutcome(doc, { kind, by = null, at, handle }) {
  if (doc.status !== 'cancelled') throw fail('outcome-needs-cancelled', `${doc.id} is ${doc.status}: only a cancelled task takes an outcome`, 'cancel it first: task set <id> cancelled --reason <t>');
  if (doc.outcome) {
    if (doc.outcome.kind === kind && (doc.outcome.by ?? null) === (by ?? null)) return false;
    throw fail('outcome-set', `${doc.id} already has the outcome ${doc.outcome.kind}${doc.outcome.by ? ` (${doc.outcome.by})` : ''}: an outcome is recorded once`, 'a different outcome needs a decision record');
  }
  doc.outcome = { kind, by: by ?? null, at };
  doc.events.push({ at, by: handle, event: 'outcome', data: { kind, by: by ?? null } });
  return true;
}

// `task outcome` on an open store: the cancelled task of `handle`. One store.update; an equal second call writes nothing.
export function setOutcome(store, id, { kind, by = null, at = new Date().toISOString(), handle } = {}) {
  return store.update('task', id, (doc) => {
    if (doc === null) throw fail('task-unknown', `no task ${id}`);
    if (doc.owner !== handle) throw fail('not-owner', `${id} belongs to ${doc.owner}; only its owner records its outcome`, 'ask the owner');
    return applyOutcome(doc, { kind, by, at, handle }) ? doc : undefined;
  });
}

const reasonOf = (task) => [...task.events].reverse().find((e) => e.event === 'cancelled')?.data?.reason ?? '';

// The adoption run over the cancelled tasks of `handle` without an outcome: { proposals: [{ id, kind, by }],
// human: [{ id, reason }], applied: [id], skipped: [id] }. Without `write` nothing is written; with it each task is
// its own update.
export function adoptOutcomes(store, { handle, at = new Date().toISOString(), write = false } = {}) {
  const run = { proposals: [], human: [], applied: [], skipped: [] };
  for (const id of store.list('task')) {
    const task = store.read('task', id);
    if (task?.status !== 'cancelled' || task.outcome || task.owner !== handle) continue;
    const reason = reasonOf(task);
    const proposal = proposeOutcome(reason);
    if (!proposal) {
      run.human.push({ id, reason });
      continue;
    }
    run.proposals.push({ id, ...proposal });
    if (!write) continue;
    try {
      setOutcome(store, id, { ...proposal, at, handle });
      run.applied.push(id);
    } catch (err) {
      if (!(err instanceof StateError)) throw err;
      run.skipped.push(id);
    }
  }
  return run;
}
