// The cost of one verify apart from its result (T-MG-121, D-MG-38, plan M1.6, K2-K4): the machine it ran on, whether
// the gate cache served it, the wait for the heavy lease and the time of the gates alone. runHeavy fills the meter
// (heavy.mjs); each wait it records goes to local/waits.jsonl (plan P6) right after the call that waited, also when that
// call throws (heavy-busy), and only in a mode that writes (never ci). The doc's fields are added at the end of the run.
import { readings } from '../sched/index.mjs';

// `cache`: 'hit' (the gate cache or a batch memo supplied the runs) · 'miss' (consulted, no entry) · 'off'.
export const cacheState = ({ shared, hit, consulted }) => (shared || hit ? 'hit' : consulted ? 'miss' : 'off');

// One verify's meter, with the machine reading at its start: { meter (runHeavy's), heavy(fn), fields(cache) }.
export function measure({ store, id, mode }) {
  const start = readings();
  const meter = { waitMs: 0, waits: [], gatesMs: 0 };
  let logged = 0;
  const flush = () => {
    for (; logged < meter.waits.length; logged += 1) {
      if (mode === 'ci') continue;
      try {
        store.append('waits', { ...meter.waits[logged], kind: 'heavy-queue', task: id, source: 'verify' });
      } catch {
        // The waits log is optional telemetry (fix round 1, review r1 F1): any failure of its append is dropped, so it
        // never fails or changes a verify, and in `heavy` never replaces the error of the call that waited (heavy-busy).
        // Expected: the store lock held or stale (locked, stale-lock); a state.json newer or corrupt (schema-newer,
        // state-invalid); an inactive store; local/waits.jsonl not a regular file (EISDIR, ENOTDIR, ELOOP); a full or
        // read-only disk (ENOSPC, EDQUOT, EROFS, EACCES, EPERM).
      }
    }
  };
  return {
    meter,
    heavy: (fn) => {
      try {
        return fn();
      } finally {
        flush();
      }
    },
    fields: (cache) => {
      const end = readings();
      return { machine: { load1Start: start.load1, load1End: end.load1, cores: start.cores }, cache, heavyWaitMs: meter.waitMs, gatesMs: meter.gatesMs };
    },
  };
}
