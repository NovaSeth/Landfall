// Git boundary (spec §4.2, §4.3): the only module that spawns git. Argument arrays only, never a shell.
// Result shape matches lib/proc: { status, signal, stdout, stderr, error }. stdout is text (UTF-8), or with raw the
// bytes as git wrote them (a Buffer: blob content); stderr is always text. Each output is capped at MAX_OUTPUT bytes.
import { spawnSync } from 'node:child_process';

export const MAX_OUTPUT = 16 * 1024 * 1024;

export function git(args, { cwd, env, timeoutMs = 30000, raw = false } = {}) {
  const r = spawnSync('git', args, {
    cwd, env, encoding: raw ? 'buffer' : 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let error = null;
  if (r.error) error = r.error.code === 'ENOENT' ? 'missing' : r.error.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
  const stdout = raw ? (r.stdout ?? Buffer.alloc(0)) : (r.stdout ?? '');
  return { status: r.status, signal: r.signal, stdout, stderr: raw ? (r.stderr ?? Buffer.alloc(0)).toString('utf8') : (r.stderr ?? ''), error };
}

// Root of the working tree containing cwd, or null outside a repository.
export function topLevel(cwd, opts = {}) {
  const r = git(['rev-parse', '--show-toplevel'], { ...opts, cwd });
  return r.status === 0 ? r.stdout.trim() : null;
}
