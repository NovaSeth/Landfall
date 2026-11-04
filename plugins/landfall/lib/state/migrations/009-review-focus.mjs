// Review schema 1 → 2 (T-MG-117, D-MG-38, plan M1.2 and P13): the optional field focus (security, general, data,
// concurrency; non-empty, each once) joins the review record. A schema-1 record never holds it, so the content stays
// as it is; only the schema is stamped. An older plugin refuses a schema-2 record as newer (GC9).
export default Object.freeze({
  id: '009-review-focus',
  kind: 'review',
  from: 1,
  to: 2,
  up(doc) {
    return doc;
  },
});
