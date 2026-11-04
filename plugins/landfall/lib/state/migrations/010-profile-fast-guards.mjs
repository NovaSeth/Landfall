// Profile schema 2 → 3 (T-MG-152): the said fact fastGuards (fast checks every task gate runs, e.g. naming and
// architecture tests) joins the profile. It is an optional fact a schema-2 file never holds, so the content stays as it
// is; only the schema is stamped. An older plugin refuses a schema-3 file as newer (GC9) instead of failing on an
// unknown fact.
export default Object.freeze({
  id: '010-profile-fast-guards',
  kind: 'profile',
  from: 2,
  to: 3,
  up(doc) {
    return doc;
  },
});
