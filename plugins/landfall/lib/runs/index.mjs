// Run records (spec §8.5): the store that knows the run kinds, the next run ID of a provider, task and role, the live
// run of a task and role, the wall cap of a role (env override <PREFIX>EXTERNAL_TIMEOUT, whole seconds up to CAP_MAX_S),
// and the check of a run's bound out directory that run-supervise and review record --run both make (SF-AB-10).
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { KINDS, StateError, open } from '../state/index.mjs';
import { CAP_MAX_S, CAP_S, RUN_KINDS, TERMINAL, runIdOf } from './kind.mjs';

export * from './kind.mjs';

export const OUT_NAME = 'out.json';
export const dirIdOf = (st) => `${st.dev}:${st.ino}`;

// The record's out file is out.json directly inside the directory exec made for the run: a real directory (no link)
// right under the realpath of the temp directory, mode 0700, owned by this user, with the device and inode the record
// bound (outDirId). False for anything else (the record was rewritten) or on any error.
export function ownOutDir(rec) {
  try {
    const f = rec?.outFile;
    if (typeof f !== 'string' || basename(f) !== OUT_NAME || typeof rec.outDirId !== 'string') return false;
    const dir = dirname(f);
    if (realpathSync(dir) !== join(realpathSync(tmpdir()), basename(dir))) return false;
    const st = lstatSync(dir, { bigint: true });
    const mine = typeof process.getuid !== 'function' || st.uid === BigInt(process.getuid());
    return st.isDirectory() && (st.mode & 0o777n) === 0o700n && mine && dirIdOf(st) === rec.outDirId;
  } catch { return false; }
}

export const runsStore = (dir, names) => open(dir, { names, kinds: { ...KINDS, ...RUN_KINDS } });

export const readRunRecords = (store) => store.list('run').map((id) => store.read('run', id)).filter(Boolean);

export function nextRunId(store, provider, task, role) {
  const prefix = runIdOf(provider, task, role, '');
  const n = store.list('run').filter((id) => id.startsWith(prefix)).reduce((m, id) => Math.max(m, Number(id.slice(prefix.length))), 0);
  return runIdOf(provider, task, role, n + 1);
}

export const liveRun = (store, task, role) => readRunRecords(store).find((r) => r.task === task && r.role === role && !TERMINAL.includes(r.status)) ?? null;

export function capFor(role, env, prefix) {
  const name = `${prefix}EXTERNAL_TIMEOUT`;
  const value = env[name];
  if (value === undefined || value === '') return CAP_S[role];
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > CAP_MAX_S) {
    throw new StateError('invalid-value', 'USAGE', `${name}=${String(value).slice(0, 20)}: expected whole seconds from 1 to ${CAP_MAX_S}`, { hint: `default ${CAP_S[role]} for a ${role}` });
  }
  return Number(value);
}
