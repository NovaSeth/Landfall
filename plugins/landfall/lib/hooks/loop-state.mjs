// State of a repository and of its loop, as the hooks read it (spec §5.2, §7.7, §7.13, SD-18, R73, GC4, GC8).
// stateOf(cwd, env, deadline): lib/state resolve() with git bounded by what is left of the hook's time budget →
// { where } · { none } (no repository, or nothing of the plugin's here: nothing to protect) · { unknown, fallback? } (git
// missing, slow or failing, or machine data that cannot be read; fallback = the repository's in-repo state location
// resolved without machine data, when git answers). Only a clean answer is "inactive"; an unknown state makes the guards
// fail closed. Git missing, slow or failing (findings-r2 B2) is unknown only with an active-looking marker (lib/state stateMarker);
// without one the plugin stays out (R73).
// The loop unit writes local/loop.json of a state directory; readLoop(dir) reads it (read-only, never through a link,
// like the store) and loopExit(doc) is a pure function of it. loopStatus(input, env, deadline) looks at the project
// (CLAUDE_PROJECT_DIR) and the session's cwd: kind ended | unknown | unreadable | inactive | running | none.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolve, stateMarker } from '../state/index.mjs';

export const TERMINAL = Object.freeze(['DONE', 'STALLED', 'BUDGET']);
const LOOP_MAX_BYTES = 65536;
const GIT_MARGIN_MS = 100; // left for the hook's own work after git
const GIT_MAX_MS = 2000;
const MACHINE_DATA = ['CLAUDE_PLUGIN_DATA', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'HOME'];

let cachedNames = null;
export const loadNames = () => (cachedNames ??= JSON.parse(readFileSync(new URL('../name.json', import.meta.url), 'utf8')));

// Milliseconds git may take before the deadline (performance.now() ms), at most GIT_MAX_MS.
export const gitTimeLeft = (deadline = Infinity) => Math.floor(Math.min(GIT_MAX_MS, deadline - performance.now() - GIT_MARGIN_MS));

export function stateOf(cwd, env, deadline = Infinity) {
  const names = loadNames();
  const unresolved = (unknown) => (stateMarker({ cwd, env, names }) ? { unknown } : { none: true });
  const left = gitTimeLeft(deadline);
  if (left <= 0) return unresolved('out of time');
  try {
    return { where: resolve({ cwd, env, names, timeoutMs: left }) };
  } catch (e) {
    if (e?.code === 'not-a-repo') return { none: true };
    const unknown = typeof e?.code === 'string' ? e.code : 'error';
    if (unknown === 'git-missing' || unknown === 'git-failed') return unresolved(unknown);
    // machine data that cannot be read: the in-repo location, resolved without it
    const again = gitTimeLeft(deadline);
    if (again <= 0) return { unknown };
    const bare = Object.fromEntries(Object.entries(env).filter(([k]) => !MACHINE_DATA.includes(k)));
    try { return { unknown, fallback: resolve({ cwd, env: bare, names, timeoutMs: again }) }; } catch { return { unknown }; }
  }
}

// { doc: null } (no loop document) · { doc } (a JSON object) · { error } (present but unreadable).
export function readLoop(dir) {
  const file = join(dir, 'local', 'loop.json');
  let st;
  try { st = lstatSync(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { doc: null };
    return { error: e.code ?? 'unreadable' };
  }
  if (!st.isFile()) return { error: st.isSymbolicLink() ? 'a symbolic link' : 'not a regular file' };
  if (st.size > LOOP_MAX_BYTES) return { error: 'too large' };
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { error: e instanceof SyntaxError ? 'not JSON' : e.code ?? 'unreadable' }; }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? { doc } : { error: 'not a JSON object' };
}

// The terminal exit of a loop document, or null while it runs. `exit` is null | DONE | STALLED | BUDGET; any other
// value counts as terminal ('unknown'): an exit this plugin does not know still ends the loop.
export function loopExit(doc) {
  const e = doc?.exit;
  if (e === null || e === undefined) return null;
  return TERMINAL.includes(e) ? e : 'unknown';
}

// The loop of the project and of the session's cwd. A terminal exit anywhere wins; then a state that cannot be
// resolved (unknown), a loop document that cannot be read (unreadable); no active repository → inactive (R73);
// otherwise running (a loop document without an exit) or none. `where`: the first active state.
export function loopStatus(input, env, deadline = Infinity) {
  const roots = [env.CLAUDE_PROJECT_DIR, input.cwd].filter((d, k, all) => typeof d === 'string' && isAbsolute(d) && all.indexOf(d) === k);
  let unknown = null; let unreadable = null; let where = null; let running = false;
  const seen = new Set();
  for (const cwd of roots) {
    const s = stateOf(cwd, env, deadline);
    if (s.unknown) { unknown ??= s.unknown; continue; }
    if (!s.where?.active || seen.has(s.where.dir)) continue;
    seen.add(s.where.dir);
    where ??= s.where;
    const r = readLoop(s.where.dir);
    if (r.error) { unreadable ??= r.error; continue; }
    const exit = loopExit(r.doc);
    if (exit) return { kind: 'ended', exit, where: s.where };
    if (r.doc) running = true;
  }
  if (unknown) return { kind: 'unknown', why: unknown };
  if (unreadable) return { kind: 'unreadable', why: unreadable };
  if (!where) return { kind: 'inactive' };
  return { kind: running ? 'running' : 'none', where };
}
