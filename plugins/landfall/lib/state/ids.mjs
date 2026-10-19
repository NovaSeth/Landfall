// Per-developer IDs (spec §5.1, §8.2, SD-9): tasks T-<H>-<n>, decisions D-<H>-<n>; one series per prefix and
// registered handle, numbers from 1. Allocation and retirement hold the store lock: n = 1 + the highest of
// (object files, tombstones, the series' high-water mark in local/ids/<P>-<H>.json); a tombstoned number is
// skipped; the ID is taken by creating the object's file exclusively with its complete content (lib/fsx), then
// the high-water mark is raised. So concurrent allocators get distinct numbers without gaps, a crash leaves the
// object complete or absent, and a number is never returned twice on this machine, even when its object was
// deleted without a tombstone. Every refusal writes nothing but the lock, which it removes.
import { join } from 'node:path';
import { checkWrite } from './document.mjs';
import { StateError } from './errors.mjs';
import { LIMITS, PATTERNS } from './kinds.mjs';
import { format } from './schema.mjs';

const SERIES = {
  T: { dir: 'tasks', file: (id) => `tasks/${id}/task.json`, kind: 'task', entry: (h) => new RegExp(`^T-${h}-([1-9]\\d{0,5})$`) },
  D: { dir: 'decisions', file: (id) => `decisions/${id}.md`, kind: null, entry: (h) => new RegExp(`^D-${h}-([1-9]\\d{0,5})\\.md$`) },
};

function highest(store, prefix, handle) {
  const series = SERIES[prefix];
  let top = 0;
  const entry = series.entry(handle);
  for (const name of store.entries(series.dir)) {
    const m = entry.exec(name);
    if (!m) continue;
    const id = prefix === 'D' ? name.slice(0, -3) : name;
    if (store.readText(series.file(id)) !== null) top = Math.max(top, Number(m[1]));
  }
  const tomb = new RegExp(`^${prefix}-${handle}-([1-9]\\d{0,5})\\.json$`);
  for (const name of store.entries('tombstones')) {
    const m = tomb.exec(name);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return Math.max(top, store.read('counter', `${prefix}-${handle}`)?.high ?? 0);
}

function render(store, series, id, content) {
  const where = join(store.dir, series.file(id));
  if (series.kind) {
    const kind = store.kind(series.kind);
    const doc = store.stamp(kind, content);
    checkWrite(kind, doc, { where, key: id });
    return format(kind.spec, doc);
  }
  if (typeof content !== 'string' || content.length === 0) throw new StateError('invalid-value', 'USAGE', `${where}: the content must be non-empty text`);
  const bytes = Buffer.byteLength(content);
  if (bytes > LIMITS.decisionBytes) throw new StateError('limit-exceeded', 'USAGE', `${where}: ${bytes} bytes, the limit is ${LIMITS.decisionBytes}`, { hint: 'shorten it; nothing was written' });
  return content;
}

function checkSeries(prefix, handle) {
  const series = Object.hasOwn(SERIES, prefix) ? SERIES[prefix] : null;
  if (!series) throw new StateError('invalid-value', 'USAGE', `${JSON.stringify(prefix)} is not an ID prefix (T or D)`);
  if (typeof handle !== 'string' || !PATTERNS.handle.test(handle)) throw new StateError('invalid-value', 'USAGE', `${JSON.stringify(handle)} is not a handle (2-4 letters A-Z)`);
  return series;
}

const exhausted = (prefix, handle) => new StateError('id-space-exhausted', 'USAGE', `the ${prefix}-${handle} series is past ${LIMITS.idNumber}`, { hint: 'register another handle for new IDs' });

// Allocates the next ID of `prefix` (T or D) for a registered `handle`; build(id) gives the object's content
// (a task document for T, the decision text for D). Returns the ID.
export function allocateId(store, { prefix, handle, build }) {
  const series = checkSeries(prefix, handle);
  const counter = store.kind('counter');
  const counterRel = counter.path(`${prefix}-${handle}`);
  return store.locked(() => {
    store.abs(series.dir);
    store.abs(counterRel);
    store.assertWritable();
    if (series.kind) store.refuseNewerKind(store.kind(series.kind));
    store.refuseNewerKind(counter);
    store.refuseNewerKind(store.kind('tombstone'));
    if (store.read('team', handle) === null) throw new StateError('handle-unknown', 'USAGE', `handle ${handle} is not registered`, { hint: 'register the handle first; team/<H>.json lists the registered ones' });
    for (let n = highest(store, prefix, handle) + 1; n <= LIMITS.idNumber; n++) {
      const id = `${prefix}-${handle}-${n}`;
      if (store.readText(store.kind('tombstone').path(id)) !== null) continue;
      const text = render(store, series, id, build(id));
      const rel = series.file(id);
      if (store.readText(rel) === null && store.createText(rel, text)) {
        store.writeText(counterRel, format(counter.spec, { schema: counter.version, high: n }));
        return id;
      }
    }
    throw exhausted(prefix, handle);
  });
}

// SD-9: a tombstone keeps a retired ID's number from being allocated again. True when created, false when the
// tombstone already exists.
export function retireId(store, id, { by, reason, at = new Date().toISOString() }) {
  return store.create('tombstone', id, { id, retiredAt: at, by, reason });
}
