// Long gates under the heavy lease (T-MG-48, spec §7.8): a profile with a gate of timeoutS >= 60 runs its gates while
// this process holds one `heavy` lease (the queue serialises long suites on the machine); shorter gates take none. The
// wait is bounded; a refused lease ends verify with the scheduler's reasons, never a run without it.
import { acquire, dequeue, release } from '../sched/index.mjs';
import { StateError } from '../state/index.mjs';

export const LONG_S = 60;
const WAIT_MS = 590e3;
const POLL_MS = 1000;
const pause = new Int32Array(new SharedArrayBuffer(4));

export function runHeavy(gates, { names, env, cwd, task }, runOne) {
  if (!gates.some((g) => g.timeoutS >= LONG_S)) return gates.map(runOne);
  const opts = { names, env, cwd, task, mode: 'on' };
  const until = Date.now() + WAIT_MS;
  let got;
  for (;;) {
    got = acquire('heavy', { ...opts, deadline: until });
    if (got.ok || Date.now() >= until) break;
    Atomics.wait(pause, 0, 0, POLL_MS);
  }
  if (!got.ok) {
    dequeue('heavy', opts);
    throw new StateError('heavy-busy', 'ENV', `no heavy slot within ${WAIT_MS / 1000} s: ${got.reasons.map((r) => r.message).join('; ')}`, { hint: 'another long suite holds the machine; verify again later' });
  }
  try {
    return gates.map(runOne);
  } finally {
    release(got.lease, opts);
  }
}
