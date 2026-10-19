// Gates (spec §7.6 step 2, SD-15 (1)): every profile gate re-run by verify itself through lib/proc, as `sh -c` in the
// repository with the gate's time limit; stderr is merged into stdout in order, so the tail reads like a terminal and
// a collector sees one stream. Result: pass (exit 0) · fail (any other exit) · timeout (over timeoutS) · error (the
// command could not run: exit 126 or 127, a spawn failure, output over lib/proc's buffer). The output is returned to
// the caller, never part of the gate's entry in verify.json (review r1 #8: gate output can hold secrets).
// Known limits: a timeout ends the shell, not processes it started (lib/proc kills the direct child only); the heavy
// lease for long test runs (testRuntimeS >= 60) waits for the scheduler unit.
import { run } from '../proc/index.mjs';
import { forTerminal } from '../text/clean.mjs';
import { TAIL_CHARS } from './kinds.mjs';

const NOT_RUN = new Set([126, 127]);

// The last `max` characters of the output as lines, printable (no escapes, no invisible characters, tabs as spaces).
export function tailLines(output, max = TAIL_CHARS) {
  const text = forTerminal(output).replace(/\t/g, '  ').replace(/\n+$/, '');
  const tail = text.length > max ? text.slice(text.length - max) : text;
  return tail === '' ? [] : tail.split('\n');
}

// The environment of a gate: the caller's, except node:test's marker for its own child processes (verify run by a
// test runner would otherwise turn a gate's `node --test` into a child speaking the runner's internal protocol).
export function gateEnv(env) {
  const out = { ...env };
  delete out.NODE_TEST_CONTEXT;
  return out;
}

// { gate: the verify.json entry (no output), output: the whole merged output, kind }.
export function runGate(gate, { cwd, env }) {
  const started = Date.now();
  const r = run('sh', ['-c', `exec 2>&1\n${gate.cmd}`], { unit: 'verify', cwd, env: gateEnv(env), timeoutMs: gate.timeoutS * 1000 });
  const durationMs = Date.now() - started;
  const exit = Number.isInteger(r.status) ? r.status : null;
  let result = exit === 0 ? 'pass' : 'fail';
  if (r.error === 'timeout') result = 'timeout';
  else if (r.error || NOT_RUN.has(exit)) result = 'error';
  return { gate: { name: gate.name, cmd: gate.cmd, exit, durationMs, result }, output: r.stdout, kind: gate.kind };
}
