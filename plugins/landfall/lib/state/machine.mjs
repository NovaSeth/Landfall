// This machine's id and the owner of a state directory's local/ (T-MG-77, T-MG-210).
// machineId(): derived, never stored: the first 32 hex characters of sha256(`<plugin>-machine:` + identity + `:` + uid
// (or the user name) + `:` + the real path of the account home directory, from passwd). The identity is the platform's
// machine identity (macOS IOPlatformUUID from ioreg, Linux the first well-formed /etc/machine-id or
// /var/lib/dbus/machine-id), read once per process; without one (spawn error, timeout, malformed output, missing files,
// other platforms) it is the host name, which on macOS follows DHCP and so is no identity. Every config dir, plugin data
// dir and HOME of one user on one machine shares it (a fresh install tested through CLAUDE_CONFIG_DIR owns the same local/).
// legacyId(): the same formula with the host name; a marker holding it is ours (lossless upgrade) and is rewritten with
// the new id at the next write of local/ (markLocal).
// localForeign(stateDir, { env }) → { foreign, why }: the one check every reader and writer of local/ uses.
//   - foreign, 'tracked by git': a file under local/ is tracked by git in the state dir's repository and is present
//     unchanged in the working tree. A shipped marker proves nothing (the id is derivable), so this wins over it. The
//     marker itself is not counted (this machine writes the same marker again after a move-aside), and neither is a
//     tracked path that is deleted or changed (after a move-aside git still lists the shipped paths).
//   - foreign, 'marked by another machine': the marker local/.machine holds another id.
//   - foreign, 'a marker that is not a regular file': local/.machine is a link, a directory or another entry.
//   - foreign and unknown ({ unknown: true }, 'ownership unknown (…)'): git failed or did not answer in time. Not ours:
//     readers see nothing, writers refuse (nothing is moved on a guess), nothing is adopted. Never cached: the next
//     call asks git again. Outside any repository (git's own "not a git repository") nothing is tracked.
//   - not foreign: 'absent' (no local/), 'ours' (this machine's marker), 'unmarked' (marked at the next write).
// A verified git answer is cached per process per state dir ({ fresh: true } asks again; forgetShipped after a move).
import { spawnSync } from 'node:child_process';
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

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const MACHINE_ID = /^[0-9a-f]{32}$/;
const ioreg = () => spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 1000, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });

export function macIdentity(run = ioreg) {
  try {
    const r = run();
    if (r.error || r.status !== 0) return null;
    const m = /"IOPlatformUUID"\s*=\s*"([^"\n]*)"/.exec(String(r.stdout));
    return m && UUID.test(m[1]) ? m[1].toUpperCase() : null;
  } catch { return null; }
}

export function linuxIdentity(read = (p) => readFileSync(p, 'utf8')) {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = String(read(p)).trim();
      if (MACHINE_ID.test(v)) return v;
    } catch { /* unreadable: the next one */ }
  }
  return null;
}

const platformIdentity = () => (process.platform === 'darwin' ? macIdentity() : process.platform === 'linux' ? linuxIdentity() : null);
const wellFormed = (v) => typeof v === 'string' && (UUID.test(v) || MACHINE_ID.test(v));

// The id for a host name and an identity (null or malformed: the host name stands in).
export function idFor({ hostname: host, identity }) {
  plugin ??= JSON.parse(readFileSync(new URL('../name.json', import.meta.url), 'utf8')).plugin;
  // The account's home directory (passwd), not $HOME: a process started with another HOME (a throwaway one for a fresh
  // install, a test, a child with an isolated env) is still this user on this machine.
  let home;
  try { home = userInfo().homedir; } catch { home = homedir(); }
  try { home = realpathSync(home); } catch { /* a missing home: its path as given */ }
  const user = process.getuid?.() ?? userInfo().username;
  const who = wellFormed(identity) ? identity : host;
  return createHash('sha256').update(`${plugin}-machine:${who}:${user}:${home}`).digest('hex').slice(0, 32);
}

export const legacyId = () => idFor({ hostname: hostname(), identity: null });

export function machineId() {
  id ??= idFor({ hostname: hostname(), identity: platformIdentity() });
  return id;
}

const NOT_A_REPO = /^fatal: not a git repository\b/m;

// Whether a file git tracks under local/ is present unchanged: true, false, or a string (why git gave no answer, not
// cached). Verified answers are cached per process.
function ships(stateDir, env, fresh) {
  if (!fresh && shipped.has(stateDir)) return shipped.get(stateDir);
  const r = git(['ls-files', '-z', '-t', '-c', '-m', '-d', '--', 'local'], { cwd: stateDir, env: { ...env, LC_ALL: 'C' }, timeoutMs: GIT_MS });
  if (r.error) return `git ${r.error}`;
  let out = false;
  if (r.status !== 0) {
    if (r.status !== 128 || !NOT_A_REPO.test(r.stderr)) return `git ${r.signal ?? `exit ${r.status}`}`;
  } else {
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

export function localForeign(stateDir, { env = process.env, fresh = false } = {}) {
  const local = join(stateDir, 'local');
  const st = lstatSync(local, { throwIfNoEntry: false });
  if (!st) return { foreign: false, why: 'absent' };
  if (st.isSymbolicLink()) return { foreign: true, why: 'a symbolic link' };
  if (!st.isDirectory()) return { foreign: false, why: 'absent' };
  const tracked = ships(stateDir, env, fresh);
  if (typeof tracked === 'string') return { foreign: true, unknown: true, why: `ownership unknown (${tracked})` };
  if (tracked) return { foreign: true, why: 'tracked by git' };
  let marker = null;
  const mst = lstatSync(join(stateDir, MARKER), { throwIfNoEntry: false });
  if (mst && !mst.isFile()) return { foreign: true, why: 'a marker that is not a regular file' };
  if (mst) marker = readFileSync(join(stateDir, MARKER), 'utf8').trim();
  if (marker === null) return { foreign: false, why: 'unmarked' };
  return marker === machineId() || marker === legacyId() ? { foreign: false, why: 'ours' } : { foreign: true, why: 'marked by another machine' };
}
