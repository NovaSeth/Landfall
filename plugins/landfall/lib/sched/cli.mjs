// Commands of the scheduler (spec §8.2, §7.8, §7.8a): `slots` lists the calibration, the readings, the leases and
// the queues and writes nothing (`slots --unlock-stale`: the explicit removal of a scheduler lock whose owner is gone,
// after a crash); `slots calibrate` saves the calibration with overrides (refusals exit 2, nothing written);
// `heavy -- <cmd…>` runs a command in the FIFO queue under a heavy (or e2e) lease: acquireWait → start → attachChild
// → supervise → release, so the lease is free before anyone looks at the results.
// heavy (successor of heavy.sh): admitted only while the machine check passes (load and free memory against the
// calibration, addendum 11: admission `on` whatever the agent admission mode); until then its ticket waits with its
// FIFO place and deadline. Low priority (`nice -n 10`, the user's argv passed to it) and default thread limits of
// common test runners unless already set; the lease env on top. The command leads its own process group: SIGINT,
// SIGTERM and SIGHUP to the runner go to the group; a runner killed outright leaves the lease and the recorded command
// to the orphan reaper of the next acquire. A command that cannot be recorded in the lease has its group ended before
// the lease is released (findings r1 6); a runner killed between the start and the record leaves an unrecorded
// command (known limitation).
// Exit: 0 the command succeeded · 1 it failed (its status in data) or the worktree already has a queue entry · 2 a bad
// limit · 3 no slot within --wait · 5 no output within --idle · 6 --timeout reached · 8 the program is missing.
// Output (S2: lib/cli/output.mjs is the one writer): the command's stdout and stderr are read while it runs (the
// no-output limit) and their last 64 KB come back in the result (text, or data.output with --json), so nothing of
// it reaches the terminal unfiltered. Scheduler errors are StateErrors, turned into results by lib/cli/main.mjs.
import { accessSync, constants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { start } from '../proc/index.mjs';
import { StateError } from '../state/index.mjs';
import { admissionReasons } from './admission.mjs';
import { calibrate, currentCalibration } from './calibration.mjs';
import { FIFO_KINDS, KIND_NAMES } from './kinds.mjs';
import { unlockStale } from './files.mjs';
import { acquireWait, attachChild, release, snapshot } from './leases.mjs';
import { freePct, readings } from './machine.mjs';
import { supervise } from './run.mjs';

const target = (io, names) => ({ names, env: io.env, cwd: io.cwd });
const gb = (bytes) => `${Math.round(bytes / 2 ** 30)} GB`;
const holder = (o) => (o.pid !== undefined ? `pid ${o.pid}` : `session ${o.sessionId}${o.agentId ? ` agent ${o.agentId}` : ''}`);

function calibrationLine(c) {
  const saved = c.saved ? `saved ${c.at.slice(0, 10)}${c.due ? ', due again' : ''}` : 'defaults, saved on first use';
  return `calibration: ${c.cores} cores, ${gb(c.totalMemBytes)} RAM, memory via ${c.memMethod}; load max ${c.loadMax}, free memory min ${c.freeMinPct}% (${saved})`;
}

export function slots({ flags, names, io }) {
  if (flags.unlockStale) {
    const u = unlockStale(target(io, names));
    return { data: u, text: u.removed ? `removed the scheduler lock left by pid ${u.owner.pid} on ${u.owner.host}\n` : 'no stale scheduler lock\n' };
  }
  const r = readings();
  const { calibration, saved, due } = currentCalibration({ ...target(io, names), readings: r });
  const view = snapshot(target(io, names));
  const kinds = Object.fromEntries(KIND_NAMES.map((k) => [k, { max: calibration.max[k], used: view.used(k), queued: view.queued(k) }]));
  const data = {
    calibration: { ...calibration, schema: undefined, saved, due },
    readings: { ...r, freePct: freePct(r) },
    admission: admissionReasons(r, calibration),
    kinds,
    leases: view.leases,
    queues: view.queues,
  };
  const lines = [calibrationLine(data.calibration), `now: load ${r.load1 ?? 'unmeasured'}, free memory ${freePct(r)}%${data.admission.length ? ` (would wait: ${data.admission.map((x) => x.message).join(', ')})` : ''}`];
  for (const k of KIND_NAMES) {
    lines.push(`${k.padEnd(9)}${kinds[k].used}/${kinds[k].max}${FIFO_KINDS.includes(k) && kinds[k].queued ? `, ${kinds[k].queued} queued` : ''}`);
    for (const l of view.leases.filter((x) => x.kind === k)) {
      lines.push(l.owner
        ? `  ${k}-${l.slot}  ${l.status}${l.orphan ? ' (orphan child running)' : ''}  ${holder(l.owner)}${l.task ? `  ${l.task}` : ''}  ports ${l.ports[0]}-${l.ports[1]}  db ${l.db}  since ${l.at}`
        : `  ${k}-${l.slot}  ${l.status}`);
    }
    for (const t of view.queues[k] ?? []) lines.push(`  queue ${t.position === null ? '-' : t.position + 1}. ${t.worktree}  ${t.status}  pid ${t.owner.pid}${t.task ? `  ${t.task}` : ''}  since ${t.at}`);
  }
  return { data, text: `${lines.join('\n')}\n` };
}

function parseMax(value) {
  const max = {};
  for (const part of String(value).split(',')) {
    const m = /^([a-z0-9]+)=(\d{1,3})$/.exec(part.trim());
    if (!m) throw new StateError('invalid-value', 'USAGE', `--max ${part}: expected kind=n, such as heavy=1`, { hint: `kinds: ${KIND_NAMES.join(', ')}` });
    max[m[1]] = Number(m[2]);
  }
  return max;
}

export function slotsCalibrate({ flags, names, io }) {
  const doc = calibrate({
    ...target(io, names),
    loadMax: flags.loadMax,
    freeMin: flags.freeMin,
    max: flags.max === undefined ? undefined : parseMax(flags.max),
  });
  const calibration = { ...doc, schema: undefined, saved: true, due: false };
  return { data: { calibration }, text: `${calibrationLine(calibration)}\nmax: ${KIND_NAMES.map((k) => `${k} ${doc.max[k]}`).join(', ')}\n` };
}

// heavy (spec §7.8a, addendum 10): limits in whole seconds; defaults [calibrate]. The hard time limit is 45 min unless
// --timeout or the env variable <PREFIX>HEAVY_TIMEOUT sets another (the flag wins).
export const HEAVY_LIMITS = Object.freeze({
  timeout: { def: 2700, min: 1, max: 86400, env: 'HEAVY_TIMEOUT' },
  idle: { def: 600, min: 1, max: 86400 },
  wait: { def: 3600, min: 0, max: 86400 },
});
const THREADS = '4';
const THREAD_VARS = ['VITEST_MAX_THREADS', 'VITEST_MAX_FORKS', 'JEST_WORKERS', 'PYTEST_XDIST_AUTO_NUM_WORKERS', 'GOMAXPROCS', 'CARGO_BUILD_JOBS'];
const GRACE_MS = 5000;
const TAIL_BYTES = 64 * 1024;

// The last TAIL_BYTES of the command's output (stdout and stderr in arrival order).
function outputTail() {
  let buf = Buffer.alloc(0);
  let dropped = 0;
  return {
    add: (d) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      if (buf.length > TAIL_BYTES) {
        dropped += buf.length - TAIL_BYTES;
        buf = buf.subarray(buf.length - TAIL_BYTES);
      }
    },
    text: () => `${dropped ? `[${dropped} earlier bytes of output omitted]\n` : ''}${buf.toString('utf8')}`,
  };
}

function seconds(flag, flags, env, prefix) {
  const { def, min, max, env: suffix } = HEAVY_LIMITS[flag];
  const name = suffix ? `${prefix}${suffix}` : null;
  const fromEnv = name && env[name] !== undefined && env[name] !== '';
  const value = flags[flag] ?? (fromEnv ? env[name] : undefined);
  if (value === undefined) return def;
  if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
    const given = flags[flag] !== undefined ? `--${flag} ${String(value).slice(0, 20)}` : `${name}=${String(value).slice(0, 20)}`;
    throw new StateError('invalid-value', 'USAGE', `${given}: expected whole seconds from ${min} to ${max}`, { hint: `default ${def}` });
  }
  return Number(value);
}

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
// The program of argv[0] on PATH (or as a path), checked before a slot is taken.
const findable = (cmd, env, cwd) => (cmd.includes('/') ? executable(resolve(cwd, cmd)) : String(env.PATH ?? '').split(':').filter(Boolean).some((d) => executable(join(d, cmd))));

// Runs argv under a granted lease: start (own process group, low priority) → attachChild → supervise, and resolves
// with the supervise result. When the child cannot be recorded in the lease (an error, or the lease is gone), its
// group is ended (SIGTERM, grace, SIGKILL) before the error goes on. The caller releases the lease after this settles.
export async function runLeased(lease, argv, { opts, env, cwd, stdin = 'ignore', timeoutMs, idleMs, graceMs = GRACE_MS, out = () => {} }) {
  const child = start('nice', ['-n', '10', ...argv], { unit: 'sched', cwd, env, stdin });
  const forward = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, () => { try { process.kill(-child.pid, sig); } catch { /* gone */ } }]);
  for (const [sig, handler] of forward) process.on(sig, handler);
  const abort = new AbortController();
  const done = supervise(child, { timeoutMs, idleMs, graceMs, out, err: out, signal: abort.signal });
  try {
    let failed = null;
    if (Number.isInteger(child.pid)) {
      try {
        if (!attachChild(lease, child.pid, opts)) failed = new StateError('lease-lost', 'ENV', `the ${lease.kind} lease was gone before the command was recorded in it; the command was stopped`, { hint: 'retry the run' });
      } catch (err) {
        failed = err;
      }
    }
    if (failed) abort.abort();
    const result = await done;
    if (failed) throw failed;
    return result;
  } finally {
    for (const [sig, handler] of forward) process.off(sig, handler);
  }
}

export async function heavy({ args, flags, names, io }) {
  const timeoutS = seconds('timeout', flags, io.env, names.envPrefix);
  const idleS = seconds('idle', flags, io.env, names.envPrefix);
  const waitS = seconds('wait', flags, io.env, names.envPrefix);
  const kind = flags.e2e ? 'e2e' : 'heavy';
  const argv = args.cmd;
  if (!findable(argv[0], io.env, io.cwd)) {
    return { code: EXIT.ENV, errors: [{ code: 'command-missing', message: `${argv[0]}: no such program on PATH`, hint: 'check the command after --' }] };
  }
  const opts = { ...target(io, names), ttlS: timeoutS + GRACE_MS / 1000 + 60 };
  const got = await acquireWait(kind, { ...opts, mode: 'on', readings: io.readings, timeoutMs: waitS * 1000 }); // io.readings: tests
  if (!got.ok) {
    return { code: EXIT.WAIT, data: { kind, reasons: got.reasons }, errors: [{ code: 'wait-timeout', message: `no ${kind} slot within ${waitS} s: ${got.reasons.map((x) => x.message).join(', ')}`, hint: 'retry later or raise --wait' }] };
  }
  const lease = { kind, slot: got.lease.slot, ports: got.lease.ports, db: got.lease.db };
  const env = { ...io.env };
  for (const v of THREAD_VARS) env[v] ??= THREADS;
  Object.assign(env, got.env);
  const began = Date.now();
  const tail = outputTail();
  let done;
  try {
    done = await runLeased(got.lease, argv, { opts, env, cwd: io.cwd, stdin: io.stdinIsTTY ? 'inherit' : 'ignore', timeoutMs: timeoutS * 1000, idleMs: idleS * 1000, out: tail.add });
  } finally {
    release(got.lease, opts);
  }
  const output = tail.text();
  const data = { kind, lease, command: argv.slice(0, 20), ended: done.ended, status: done.status, signal: done.signal, durationMs: Date.now() - began, output };
  if (done.error) return { code: EXIT.ENV, data, text: output, errors: [{ code: 'start-failed', message: `the command could not start: ${done.error}`, hint: 'check that nice and the program are on PATH' }] };
  if (done.ended === 'timeout') return { code: EXIT.BUDGET, data, text: output, errors: [{ code: 'time-limit', message: `no end within --timeout ${timeoutS} s; the command group was stopped`, hint: `raise --timeout (or ${names.envPrefix}HEAVY_TIMEOUT) or split the run` }] };
  if (done.ended === 'idle') return { code: EXIT.STALLED, data, text: output, errors: [{ code: 'no-output', message: `no output for --idle ${idleS} s; the command group was stopped`, hint: 'raise --idle for a run that is quiet for long' }] };
  if (done.status !== 0) return { code: EXIT.FAIL, data, text: output, errors: [{ code: 'command-failed', message: `${argv[0]} ${done.signal ? `ended by ${done.signal}` : `exited with ${done.status}`}`, hint: '' }] };
  return { data, text: output };
}
