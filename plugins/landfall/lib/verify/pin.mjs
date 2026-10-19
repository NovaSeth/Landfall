// `baseline show` and `baseline pin --decision <D>` (spec §5.1, §7.6, §8.2, SD-16, GC3).
//   show  the working baseline (tests with skip flags, pinned failures, collector, head, the decision of the last pin)
//         and whether its sha256 still matches its content. Read-only.
//   pin   the repair after a collector change or a resolved tests.json conflict: the baseline becomes the inventory
//         collected now, replacing the file (also one that does not parse, such as a merge conflict left in it). It
//         needs an active decision of kind gate-change or test-removal, which the baseline records as `pinnedBy`.
//         The test gates run as verify runs them (gates.mjs) and are read by the same collectors; the failures they
//         report are pinned as pre-existing. Refused, writing nothing: no gates (1), a gate that cannot run (8) or runs
//         over its limit (1), focused tests (1: the others did not run), a failing gate whose failures are not all
//         collected (1: a crash says nothing to pin).
// Verify compares with the baseline committed at the anchor (the task base; the target tip for task merge) united
// with the working file, which can only add. So a pin counts once it is committed on the target: pin there, and a
// task based before the pin takes that commit as its base. A pin inside a task branch cannot shrink the accepted
// inventory. With a state directory outside the repository (linked) the pinned store baseline is the anchor of the
// code its head describes: the commit pinned at and its descendants (lib/verify/run.mjs).
import { readRecords } from '../decisions/index.mjs';
import { emptyProfile } from '../profile/index.mjs';
import { PATTERNS, StateError } from '../state/index.mjs';
import { baselineSha, excusable, fingerprint } from './baseline.mjs';
import { runGate, tailLines } from './gates.mjs';
import { byCodeUnit } from './inventory.mjs';
import { activeWhere, codeState, context, inventoryOf, storeOf } from './run.mjs';

export const PIN_KINDS = Object.freeze(['gate-change', 'test-removal']);

const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });
const envError = (code, message, hint = '') => new StateError(code, 'ENV', message, { hint });

// { doc (null without a baseline), valid (null without one) }.
export function showBaseline({ cwd, env, names }) {
  const where = activeWhere({ cwd, env, names });
  const doc = storeOf(where, names).read('baseline', null);
  return { doc, valid: doc === null ? null : doc.sha256 === baselineSha(doc) };
}

// The active pinning decision `id`, or a typed refusal.
function pinningDecision(where, id, names) {
  if (typeof id !== 'string' || id === '') throw usage('missing-flag', 'baseline pin needs --decision <D>: an active gate-change or test-removal decision', `record one: ${names.bin} decide --kind gate-change --title … --why … --cost …`);
  if (!PATTERNS.decisionId.test(id)) throw usage('invalid-value', `not a decision ID: ${id.slice(0, 40)}`, 'a decision ID is D-<handle>-<number>');
  const record = readRecords(where.dir).records.find((r) => r.id === id);
  if (!record) throw usage('unknown-decision', `${id} has no valid record`, `list the records with '${names.bin} decisions find'`);
  if (!PIN_KINDS.includes(record.doc.kind)) throw usage('decision-kind', `${id} is a ${record.doc.kind} decision; a pin needs gate-change or test-removal`, `record one: ${names.bin} decide --kind gate-change …`);
  if (record.doc.status !== 'active') throw fail('decision-not-active', `${id} is ${record.doc.status}; only an active decision pins a baseline`, record.doc.supersededBy ? `use its successor ${record.doc.supersededBy}` : 'record a new decision');
  return record;
}

// The previous baseline as { total, collector, sha256, valid }, or null when there is none or it does not parse.
function previousOf(store) {
  try {
    const doc = store.read('baseline', null);
    return doc && { total: doc.tests.length, collector: doc.collector, sha256: doc.sha256, valid: doc.sha256 === baselineSha(doc) };
  } catch {
    return null;
  }
}

// { doc (the pinned baseline), previous, decision, output: [{ name, lines }] }.
export function pinBaseline({ cwd, env, names, decision, at = new Date().toISOString() }) {
  const where = activeWhere({ cwd, env, names });
  pinningDecision(where, decision, names);
  const store = storeOf(where, names);
  const profile = store.read('profile', null) ?? emptyProfile();
  if (profile.gates.length === 0) throw fail('no-gates', 'the profile has no gates, so nothing collects the tests to pin', `${names.bin} profile observe detects them`);
  const code = codeState(where, env);
  const runs = profile.gates.filter((g) => g.kind === 'test').map((g) => runGate(g, { cwd: where.worktree, env }));
  const output = runs.map((r) => ({ name: r.gate.name, lines: tailLines(r.output) }));
  for (const { gate } of runs) {
    if (gate.result === 'error') throw envError('gate-error', `gate ${gate.name} could not run (exit ${gate.exit ?? '-'}); nothing was pinned`, 'install what the gate runs, or fix its command in the profile');
    if (gate.result === 'timeout') throw fail('gate-timeout', `gate ${gate.name} ran over its time limit; nothing was pinned`, 'make it faster, or raise its timeoutS in the profile');
  }
  const inv = inventoryOf(runs, context(where, env, code.rel));
  const focused = inv.tests.filter((t) => t.focused).map((t) => t.id);
  if (focused.length) throw fail('focused', `focused tests make the others not run (${focused.slice(0, 5).join(', ')}); nothing was pinned`, 'remove .only, fit and fdescribe');
  for (const r of runs.filter((x) => x.gate.result === 'fail')) {
    const part = inv.parts.find((p) => p.run === r);
    if (!part || !excusable(part, new Set(part.failing.map(fingerprint)))) {
      throw fail('gate-failed', `gate ${r.gate.name} failed (exit ${r.gate.exit ?? '-'}) without reporting every failure, so there is nothing to pin; nothing was pinned`, 'run it by hand and fix what stops it');
    }
  }
  const tests = inv.tests.map(({ id, file, skipped }) => ({ id, file, skipped }));
  const failing = [...new Set(inv.parts.flatMap((p) => p.failing.map(fingerprint)))].sort(byCodeUnit);
  const sha256 = baselineSha({ collector: inv.collector, tests, failing });
  const previous = previousOf(store);
  const doc = store.write('baseline', null, { collector: inv.collector, head: code.head, collectedAt: at, tests, failing, sha256, pinnedBy: decision });
  return { doc, previous, decision, output };
}
