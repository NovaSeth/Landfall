// Process boundary (spec §4.2, §4.3): the only module that spawns programs other than git (lib/git owns git).
// Argument arrays only, never a shell. The caller names its unit; programs with an owner unit (gh: mirror,
// codex and gemini: providers) run only for that unit. Result: { status, signal, stdout, stderr, error } where
// error is null, 'missing' (not on PATH), 'timeout' or 'failed'.
// start (ruling for I9.1): the asynchronous form for long runs under a lease, with the same checks. It returns the
// ChildProcess: output is streamed on its stdout and stderr pipes while it runs, and by default the child leads its
// own process group (detached), so a time limit or the orphan reaper ends the whole group with kill(-pid).
import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const MAX_BUFFER = 16 * 1024 * 1024;
const OWNER = { git: 'git', gh: 'mirror', codex: 'providers', gemini: 'providers' };

function checkOwner(cmd, unit, fn) {
  const program = basename(String(cmd)).replace(/\.exe$/i, '').toLowerCase();
  if (OWNER[program] === 'git') throw new Error(`proc.${fn}: git is spawned only by lib/git`);
  if (typeof unit !== 'string' || unit === '') throw new Error(`proc.${fn}: pass the calling unit ({ unit })`);
  if (OWNER[program] && OWNER[program] !== unit) throw new Error(`proc.${fn}: ${program} is spawned only by lib/${OWNER[program]}`);
}

export function run(cmd, args = [], { unit, cwd, env, input, timeoutMs = 30000 } = {}) {
  checkOwner(cmd, unit, 'run');
  const r = spawnSync(cmd, args, {
    cwd, env, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let error = null;
  if (r.error) error = r.error.code === 'ENOENT' ? 'missing' : r.error.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error };
}

// stdin: 'inherit' (default) or 'ignore'. A program that cannot start emits 'error' (ENOENT when missing).
export function start(cmd, args = [], { unit, cwd, env, detached = true, stdin = 'inherit' } = {}) {
  checkOwner(cmd, unit, 'start');
  return spawn(cmd, args, { cwd, env, detached, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
}
