// State (store) schema 2 → 3 (T-MG-194, D-MG-75): the machine-local kind token (local/token.json) joins the store.
// state.json keeps its content; only the schema is stamped. A 2.7.2 plugin refuses a schema-3 store as newer (SC10, GC9),
// so its CLI, which checks no token, cannot write to a migrated repository.
export default Object.freeze({
  id: '013-state-role-tokens',
  kind: 'state',
  from: 2,
  to: 3,
  up(doc) {
    return doc;
  },
});
