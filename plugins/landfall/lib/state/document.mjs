// One state document (spec §5, SD-10): file text → checked object, and the write-side check of a new version.
// Reading: invalid JSON, a missing schema or failed field checks → state-invalid (FAIL); a newer schema →
// schema-newer (REFUSED, exit 7) unless the kind's reader declares it readable and the caller only reads; an
// older schema is upgraded in memory by `upgrade` (the migration chain) and then checked.
// Writing: field errors → USAGE (exit 2, spec §5: never truncated); the key field must equal the file's key.
import { StateError, newerSchema } from './errors.mjs';
import { validate } from './schema.mjs';

export const invalidState = (where, why, details) => new StateError('state-invalid', 'FAIL', `${where} is invalid: ${why}`, {
  hint: 'fix or restore the file (from git, or from the copy under local/backup/ after a migration)',
  details,
});

const noUpgrade = (kind) => {
  throw new StateError('migration-missing', 'INTERNAL', `no migration chain for ${kind.name} files`);
};

export function parseDoc(kind, text, { where, names, write = false, upgrade = noUpgrade }) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalidState(where, 'not valid JSON');
  }
  const schema = doc?.schema;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Number.isInteger(schema) || schema < 1) throw invalidState(where, 'no integer schema field');
  if (schema > kind.version) {
    if (write || schema > kind.readUpTo) throw newerSchema(names, where, schema, kind.version);
    return doc;
  }
  if (schema < kind.version) doc = upgrade(kind, doc, where);
  const errors = validate(kind.spec, doc);
  if (errors.length) throw invalidState(where, errors[0].message, errors);
  return doc;
}

export function checkWrite(kind, doc, { where, key }) {
  const errors = validate(kind.spec, doc);
  if (errors.length) throw new StateError(errors[0].code, 'USAGE', `${where}: ${errors[0].message}`, { hint: 'shorten or correct the value; nothing was written', details: errors });
  if (kind.key && doc[kind.key] !== key) throw new StateError('invalid-value', 'USAGE', `${where}: ${kind.key} ${JSON.stringify(doc[kind.key])} does not match the key ${JSON.stringify(key)}`);
}

// Programming errors: the caller must pass its context explicitly (REV-58), never fall back to process state.
export function requireArg(value, what, fn) {
  if (!value || typeof value !== 'object') throw new TypeError(`state.${fn}: pass ${what} explicitly (context comes from the target, REV-58)`);
}
