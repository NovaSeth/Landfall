// Profile schema 1 → 2 (retro 2026-10 §3.3, §3.6): the facts riskGlobs (the project's own risk globs, kept apart from
// the scanned riskPaths that observe rewrites) and reviewFocus (what every review checks) join the profile. Both are
// optional facts a schema-1 file never holds, so the content stays as it is; only the schema is stamped. An older
// plugin refuses a schema-2 file as newer (GC9) instead of failing on an unknown fact.
export default Object.freeze({
  id: '003-profile-said-globs',
  kind: 'profile',
  from: 1,
  to: 2,
  up(doc) {
    return doc;
  },
});
