// A write that needs a decision (a threshold override, a gate change; spec §7.3, §7.6, GC3) cites one with --decision:
// it must be the valid record of an active decision, of one of `kinds` when given. A refusal is FAIL (the condition the
// write needs is false: no ID, an unknown one, one not active or of another kind; nothing is written); a malformed ID
// is USAGE. Returns the record ({ id, name, doc, … } of readRecords).
import { PATTERNS, StateError } from '../state/index.mjs';
import { readRecords } from './records.mjs';

const fail = (code, message, hint) => new StateError(code, 'FAIL', message, { hint });

export function requireDecision({ dir, id, kinds = null, names, what }) {
  const kind = kinds ? `${kinds.join(' or ')} ` : '';
  const record = `record one: ${names.bin} decide${kinds ? ` --kind ${kinds[0]}` : ''} --title … --why … --cost …`;
  if (typeof id !== 'string' || id === '') throw fail('decision-required', `${what} needs --decision <D>: an active ${kind}decision`, record);
  if (!PATTERNS.decisionId.test(id)) throw new StateError('invalid-value', 'USAGE', `not a decision ID: ${id.slice(0, 40)}`, { hint: 'a decision ID is D-<handle>-<number>' });
  const found = readRecords(dir).records.find((r) => r.id === id);
  if (!found) throw fail('unknown-decision', `${id} has no valid record`, `list the records with '${names.bin} decisions find', or ${record}`);
  if (found.doc.status !== 'active') throw fail('decision-not-active', `${id} is ${found.doc.status}; ${what} needs an active decision`, found.doc.supersededBy ? `cite its successor ${found.doc.supersededBy}` : record);
  if (kinds && !kinds.includes(found.doc.kind)) throw fail('decision-kind', `${id} is a ${found.doc.kind} decision; ${what} needs ${kind}decision`, record);
  return found;
}
