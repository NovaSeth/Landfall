// Verify schema 1 → 2 (T-MG-117, D-MG-38, plan M1.2 and P13): the optional fields machine (1-minute load at start
// and end, logical cores), cache (hit, miss or off), heavyWaitMs (the wait for the heavy-command lease) and gatesMs
// (the gates alone) join the verify record. A schema-1 record never holds them, so the content stays as it is; only
// the schema is stamped. An older plugin refuses a schema-2 record as newer (GC9) instead of failing on an unknown field.
export default Object.freeze({
  id: '008-verify-machine',
  kind: 'verify',
  from: 1,
  to: 2,
  up(doc) {
    return doc;
  },
});
