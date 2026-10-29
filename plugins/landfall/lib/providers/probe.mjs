// Probes shared by the adapters (spec §7.12 Detection): a PATH lookup without spawning, and one bounded run of the
// provider program through lib/proc (2 s by default). Line cleaning for the record and the log: what a provider prints
// is data; hidden characters (escapes, controls, bidi) are removed and a line is cut to a limit in code points.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { run } from '../proc/index.mjs';
import { forTerminal } from '../text/clean.mjs';

export const PROBE_MS = 2000;

// The provider's PATH: only absolute entries, so neither an empty entry nor "." can find a program in the repository.
export const childPath = (path) => String(path ?? '').split(delimiter).filter((d) => isAbsolute(d)).join(delimiter);

// The provider's environment (B-6), for its runs and its detection probes alike (T-MG-96 F2): the base variables (PATH
// as childPath keeps it), LANG and LC_*, the lease variables, and the adapter's own envNames (NAME or a NAME_* prefix);
// nothing else of the parent passes.
const BASE_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'];
export function childEnv(adapter, parent, lease = {}) {
  const names = (adapter?.envNames ?? []).filter((n) => typeof n === 'string');
  const own = (k) => BASE_ENV.includes(k) || /^LC_[A-Z0-9_]+$/.test(k) || names.some((n) => (n.endsWith('*') ? k.startsWith(n.slice(0, -1)) : k === n));
  const out = {};
  for (const [k, v] of Object.entries(parent ?? {})) if (typeof v === 'string' && k !== 'PATH' && own(k)) out[k] = v;
  if (typeof parent?.PATH === 'string') out.PATH = childPath(parent.PATH);
  for (const [k, v] of Object.entries(lease ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

// The absolute path of an executable program: itself when absolute, else the first match on env.PATH; null when none.
export function which(program, env = {}) {
  const ok = (p) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(program)) return ok(program) ? program : null;
  if (program.includes('/')) return null;
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (isAbsolute(dir) && ok(join(dir, program))) return join(dir, program);
  }
  return null;
}

// One bounded run: { status, stdout, stderr, error } (lib/proc run).
export const probe = (program, args, { env, timeoutMs = PROBE_MS } = {}) => run(program, args, { unit: 'providers', env, timeoutMs });

// { found, path, version, error } of a program answering `--version` with a version on its first line.
export function versionOf(program, env) {
  const path = which(program, env);
  if (!path) return { found: false, path: null, version: null, error: null };
  const r = probe(path, ['--version'], { env });
  if (r.error || r.status !== 0) return { found: true, path, version: null, error: `--version: ${r.error ?? `exit ${r.status}`}` };
  const m = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(r.stdout);
  return { found: true, path, version: m ? m[0].slice(0, 80) : null, error: m ? null : '--version printed no version' };
}

// A provider line as one clean line of at most `max` code points (null when nothing visible is left).
export function cleanLine(text, max) {
  const s = forTerminal(String(text ?? '')).replace(/[\n\t]+/g, ' ').trim();
  if (!s) return null;
  const cps = [...s];
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}

// The last non-empty line of a text, cleaned.
export function lastLineOf(text, max) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? cleanLine(lines[lines.length - 1], max) : null;
}
