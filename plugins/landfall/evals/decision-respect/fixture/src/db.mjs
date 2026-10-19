// Data access. D-AB-3: no ORM; every query goes through these helpers (docs/decisions/D-AB-3.md).

const tables = new Map();
let nextId = 1;

export function table(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

export function insert(name, row) {
  const stored = { ...row, id: nextId++ };
  table(name).set(stored.id, stored);
  return { ...stored };
}

export function findById(name, id) {
  const row = table(name).get(id);
  return row ? { ...row } : null;
}

export function findWhere(name, predicate) {
  return [...table(name).values()].filter(predicate).map((row) => ({ ...row }));
}

export function update(name, id, patch) {
  const row = table(name).get(id);
  if (!row) return null;
  Object.assign(row, patch);
  return { ...row };
}

export function reset() {
  tables.clear();
  nextId = 1;
}
