// Verify schema 3 → 4 (T-MG-195, D-MG-76): the optional field train ({ commit, head, batch }, written by the merge
// train) is a schema-4 field. A schema-3 record never holds it, so the content stays as it is; only the schema is
// stamped. A 3.x plugin refuses a schema-4 record as newer (GC9) instead of failing on an unknown field.
export default Object.freeze({
  id: '012-verify-train',
  kind: 'verify',
  from: 3,
  to: 4,
  up(doc) {
    return doc;
  },
});
