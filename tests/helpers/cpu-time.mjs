// GC8 on a loaded machine (S3): a hook's time limit applies to its own CPU time (user + system, read with
// process.cpuUsage() in the hook process at exit), which load does not stretch; wall time is only a ceiling
// (WALL_CEILING_MS) that still catches a hang. The hook runs as `node --import <reporter> ...`: the reporter
// writes the CPU time to the file named by HOOK_CPU_OUT and leaves stdout and stderr alone. The spawn stays in
// the test file, whose module-level isolateProcessEnv() covers it (tests/isolation-guard.test.mjs).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOOK_CPU_LIMIT_MS = 1000;
export const WALL_CEILING_MS = 10000;
const REPORTER = `data:text/javascript,${encodeURIComponent("import { writeFileSync } from 'node:fs'; process.on('exit', () => { const u = process.cpuUsage(); writeFileSync(process.env.HOOK_CPU_OUT, String(Math.round((u.user + u.system) / 1000))); });")}`;

// For one node process: the arguments to put before its script, the env entry, and how to read its CPU time
// after it exited (NaN when it died before exit).
export function cpuProbe() {
  const dir = mkdtempSync(join(tmpdir(), 'hook-cpu-'));
  const file = join(dir, 'cpu');
  return {
    nodeArgs: ['--import', REPORTER],
    env: { HOOK_CPU_OUT: file },
    read: () => {
      let ms = Number.NaN;
      try { ms = Number(readFileSync(file, 'utf8')); } catch { /* no report */ }
      rmSync(dir, { recursive: true, force: true });
      return ms;
    },
  };
}

// run(probe) spawns node synchronously with probe.nodeArgs and probe.env; returns its result with ms (wall) and
// cpuMs.
export function measured(run) {
  const probe = cpuProbe();
  const started = performance.now();
  const r = run(probe);
  return { ...r, ms: Math.round(performance.now() - started), cpuMs: probe.read() };
}

// The GC8 check: CPU time under the limit, wall time under the ceiling.
export function assertFast(assert, r, what) {
  assert.ok(r.cpuMs < HOOK_CPU_LIMIT_MS, `${what}: ${r.cpuMs} ms of CPU`);
  assert.ok(r.ms < WALL_CEILING_MS, `${what}: ${r.ms} ms`);
}

// For tests that spawn a hook asynchronously with a fourth stdio pipe: a preload (`--require`) that writes the
// process's own process.cpuUsage() as JSON to fd 3 when it exits, and the reader for what it wrote.
export function fd3Preload(prefix = 'cpu-') {
  const file = join(mkdtempSync(join(tmpdir(), prefix)), 'cpu.cjs');
  writeFileSync(file, "process.on('exit', () => { const u = process.cpuUsage(); require('node:fs').writeSync(3, JSON.stringify(u)); });\n");
  return file;
}

// The CPU time in ms from what the preload wrote; NaN when nothing parseable arrived.
export function fd3CpuMs(text) {
  try { const u = JSON.parse(text); return (u.user + u.system) / 1000; } catch { return Number.NaN; }
}

// For in-process perf cases: runs fn once and returns its CPU time (process.cpuUsage() delta, user + system, in
// ms) and its wall time. A case judges the CPU time; wall time only guards a hang (CALL_WALL_GUARD_MS).
export const CALL_WALL_GUARD_MS = 2000;
export function cpuTimed(fn) {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  fn();
  const c = process.cpuUsage(c0);
  return { cpuMs: (c.user + c.system) / 1000, wallMs: performance.now() - w0 };
}

// The p95 (sorted, index ceil(0.95 n) - 1) of the CPU times of n calls of fn; fails when a call hung.
export function cpuP95(assert, fn, n) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const r = cpuTimed(fn);
    assert.ok(r.wallMs < CALL_WALL_GUARD_MS, `a call hung: ${r.wallMs.toFixed(0)} ms wall`);
    xs.push(r.cpuMs);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.ceil(xs.length * 0.95) - 1];
}
