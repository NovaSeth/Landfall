// Verify schema 2 → 3 (T-MG-182): the optional field mode (fast or full, why, the test files selected) joins the
// verify record. A schema-2 record never holds it, so the content stays as it is; only the schema is stamped. An older
// plugin refuses a schema-3 record as newer (GC9) instead of failing on an unknown field. The merge train (T-MG-186)
// writes mode kind train and the optional field train ({ commit, head, batch }) under the same schema.
export default Object.freeze({
  id: '011-verify-mode',
  kind: 'verify',
  from: 2,
  to: 3,
  up(doc) {
    return doc;
  },
});
