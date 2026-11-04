// Long gates under the heavy lease (T-MG-48, spec §7.8): a profile with a gate of timeoutS >= 60 runs its gates while
// this process holds one `heavy` lease (the queue serialises long suites on the machine); shorter gates take none. The
// wait is bounded; a refused lease ends verify with the scheduler's reasons, never a run without it.
import { acquire, dequeue, release } from '../sched/index.mjs';
import { StateError } from '../state/index.mjs';

export const LONG_S = 60;
const WAIT_MS = 590e3;
const POLL_MS = 1000;
const pause = new Int32Array(new SharedArrayBuffer(4));

// meter (T-MG-121, measure.mjs), changed in place: `gatesMs` gains the wall time of the runOne calls; when the first
// acquire is refused, `waitMs` gains the time from that acquire to the lease or the give-up, and `waits` gets
// { at, until } (ISO). A lease granted at once is no wait. Without a meter nothing is measured.
export function runHeavy(gates, { names, env, cwd, task }, runOne, meter = null) {
  const runAll = () => {
    const t0 = Date.now();
    try {
      return gates.map(runOne);
    } finally {
      if (meter) meter.gatesMs += Math.max(0, Date.now() - t0);
    }
  };
  if (!gates.some((g) => g.timeoutS >= LONG_S)) return runAll();
  const opts = { names, env, cwd, task, mode: 'on' };
  const from = Date.now();
  const until = from + WAIT_MS;
  let got;
  let waited = false;
  for (;;) {
    got = acquire('heavy', { ...opts, deadline: until });
    if (got.ok || Date.now() >= until) break;
    waited = true;
    Atomics.wait(pause, 0, 0, POLL_MS);
  }
  if (meter && waited) {
    const to = Math.max(from, Date.now()); // a clock set back never makes a negative wait
    meter.waitMs += to - from;
    meter.waits.push({ at: new Date(from).toISOString(), until: new Date(to).toISOString() });
  }
  if (!got.ok) {
    dequeue('heavy', opts);
    throw new StateError('heavy-busy', 'ENV', `no heavy slot within ${WAIT_MS / 1000} s: ${got.reasons.map((r) => r.message).join('; ')}`, { hint: 'another long suite holds the machine; verify again later' });
  }
  try {
    return runAll();
  } finally {
    release(got.lease, opts);
  }
}
