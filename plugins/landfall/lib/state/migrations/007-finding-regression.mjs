// Finding schema 1 → 2 (T-MG-116, D-MG-38, plan P13): the optional field regressionOf (the task whose change caused the
// defect) joins the finding. A schema-1 finding never holds it, so the content stays as it is; only the schema is
// stamped. An older plugin refuses a schema-2 finding as newer (GC9) instead of failing on an unknown field.
export default Object.freeze({
  id: '007-finding-regression',
  kind: 'finding',
  from: 1,
  to: 2,
  up(doc) {
    return doc;
  },
});
