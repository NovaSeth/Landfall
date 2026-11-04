// Loop schema 1 → 2 (T-MG-104): the optional billing { mode, source } joins the loop document. A schema-1 loop never
// holds it (read as billing absent = unknown: the cost cap stays), so the content stays as it is; only the schema is
// stamped. An older plugin refuses a schema-2 loop as newer (GC9).
export default Object.freeze({
  id: '005-loop-billing',
  kind: 'loop',
  from: 1,
  to: 2,
  up(doc) {
    return doc;
  },
});
