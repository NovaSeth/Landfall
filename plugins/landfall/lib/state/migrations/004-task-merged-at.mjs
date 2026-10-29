// Task schema 1 → 2 (T-MG-80): the optional field mergedAt (set with the `merged` event of task merge) joins the task.
// A schema-1 task never holds it, so the content stays as it is; only the schema is stamped. An older plugin refuses a
// schema-2 task as newer (GC9) instead of failing on an unknown field.
export default Object.freeze({
  id: '004-task-merged-at',
  kind: 'task',
  from: 1,
  to: 2,
  up(doc) {
    return doc;
  },
});
