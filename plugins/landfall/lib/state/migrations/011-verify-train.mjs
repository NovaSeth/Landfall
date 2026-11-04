// Verify schema 2 → 3 (T-MG-186, D-MG-65): the optional fields mode (train) and train ({ commit, head, batch }) join the
// verify record written by the merge train. A schema-2 record never holds them, so the content stays as it is; only the
// schema is stamped. An older plugin refuses a schema-3 record as newer (GC9) instead of failing on an unknown field.
export default Object.freeze({
  id: '011-verify-train',
  kind: 'verify',
  from: 2,
  to: 3,
  up(doc) {
    return doc;
  },
});
