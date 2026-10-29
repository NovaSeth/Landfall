// This machine's id and the owner of a state directory's local/ (T-MG-77).
// machineId(): derived, never stored: the first 32 hex characters of sha256(`<plugin>-machine:` + host name + `:` + uid
// (or the user name) + `:` + the real path of the account home directory, from passwd). Every config dir, plugin data dir and HOME of one user on
// one machine shares it (a fresh install tested through CLAUDE_CONFIG_DIR owns the same local/).
// localForeign(stateDir, { env }) → { foreign, why }: the one check every reader and writer of local/ uses.
//   - foreign, 'tracked by git': a file under local/ is tracked by git in the state dir's repository and is present
//     unchanged in the working tree. A shipped marker proves nothing (the id is derivable), so this wins over it. The
//     marker itself is not counted (this machine writes the same marker again after a move-aside), and neither is a
//     tracked path that is deleted or changed (after a move-aside git still lists the shipped paths).
//   - foreign, 'marked by another machine': the marker local/.machine holds another id.
//   - not foreign: 'absent' (no local/), 'ours' (this machine's marker), 'unmarked' (adopted: marked at the next write).
// The git question is asked at most once per process per state dir (forgetShipped after a move-aside).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { git } from '../git/index.mjs';

export const MARKER = 'local/.machine';
const GIT_MS = 2000;
let plugin = null;
let id = null;
const shipped = new Map();

export function machineId() {
  if (id) return id;
  plugin ??= JSON.parse(readFileSync(new URL('../name.json', import.meta.url), 'utf8')).plugin;
  // The account's home directory (passwd), not $HOME: a process started with another HOME (a throwaway one for a fresh
  // install, a test, a child with an isolated env) is still this user on this machine.
  let home;
  try { home = userInfo().homedir; } catch { home = homedir(); }
  try { home = realpathSync(home); } catch { /* a missing home: its path as given */ }
  const user = process.getuid?.() ?? userInfo().username;
  id = createHash('sha256').update(`${plugin}-machine:${hostname()}:${user}:${home}`).digest('hex').slice(0, 32);
  return id;
}

// Whether a file git tracks under local/ is present unchanged (cached per process).
function ships(stateDir, env) {
  if (shipped.has(stateDir)) return shipped.get(stateDir);
  const r = git(['ls-files', '-z', '-t', '-c', '-m', '-d', '--', 'local'], { cwd: stateDir, env: { ...env, LC_ALL: 'C' }, timeoutMs: GIT_MS });
  let out = false;
  if (!r.error && r.status === 0) {
    const cached = new Set();
    const changed = new Set();
    for (const entry of r.stdout.split('\0')) {
      const tag = entry.slice(0, 1);
      const path = entry.slice(2);
      if (!path || path === MARKER) continue;
      if (tag === 'H' || tag === 'S') cached.add(path);
      else changed.add(path); // C changed, R removed
    }
    out = [...cached].some((p) => !changed.has(p));
  }
  shipped.set(stateDir, out);
  return out;
}

// After local/ was moved aside: what git tracks there is gone from the working tree.
export function forgetShipped(stateDir) {
  shipped.set(stateDir, false);
}

export function localForeign(stateDir, { env = process.env } = {}) {
  const local = join(stateDir, 'local');
  const st = lstatSync(local, { throwIfNoEntry: false });
  if (!st) return { foreign: false, why: 'absent' };
  if (st.isSymbolicLink()) return { foreign: true, why: 'a symbolic link' };
  if (!st.isDirectory()) return { foreign: false, why: 'absent' };
  if (ships(stateDir, env)) return { foreign: true, why: 'tracked by git' };
  let marker = null;
  try {
    if (lstatSync(join(stateDir, MARKER)).isFile()) marker = readFileSync(join(stateDir, MARKER), 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
  if (marker === null) return { foreign: false, why: 'unmarked' };
  return marker === machineId() ? { foreign: false, why: 'ours' } : { foreign: true, why: 'marked by another machine' };
}
