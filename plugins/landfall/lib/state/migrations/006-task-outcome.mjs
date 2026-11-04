// Task schema 2 → 3 (T-MG-116, D-MG-38, plan P1 and P13): the optional fields outcome (what became of a cancelled task:
// delivered, superseded or dropped, by a task ID, a SHA or a version) and regressionOf (the task whose change caused
// this one) join the task. A schema-2 task never holds them, so the content stays as it is; only the schema is stamped.
// An older plugin refuses a schema-3 task as newer (GC9) instead of failing on an unknown field.
export default Object.freeze({
  id: '006-task-outcome',
  kind: 'task',
  from: 2,
  to: 3,
  up(doc) {
    return doc;
  },
});
