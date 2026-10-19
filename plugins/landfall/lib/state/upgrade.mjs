// In-memory upgrade of one document through its kind's migration chain (SD-10, GC9): from the file's schema
// to the kind's version (or to schema `to`), one step at a time; each step gets a copy and the engine stamps
// `schema: step.to`.
// A missing or malformed step is a bug of the plugin (INTERNAL), never a silent skip.
import { StateError } from './errors.mjs';

export function upgradeDoc(kind, doc, migrations, where, to = kind.version) {
  let cur = doc;
  while (cur.schema < to) {
    const from = cur.schema;
    const step = migrations.find((m) => m.kind === kind.name && m.from === from);
    if (!step) throw new StateError('migration-missing', 'INTERNAL', `${where}: no migration of ${kind.name} files from schema ${from}`, { hint: 'report this together with the plugin version' });
    if (step.to !== from + 1) throw new StateError('migration-failed', 'INTERNAL', `${where}: migration ${step.id} goes from ${from} to ${step.to}, not ${from + 1}`);
    const next = step.up(structuredClone(cur));
    if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new StateError('migration-failed', 'INTERNAL', `${where}: migration ${step.id} returned no document`);
    cur = { ...next, schema: step.to };
  }
  return cur;
}
