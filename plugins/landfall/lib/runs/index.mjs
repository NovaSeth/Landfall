// Run records (spec §8.5): the store that knows the run kinds, the next run ID of a provider, task and role, the live
// run of a task and role, and the wall cap of a role (env override <PREFIX>EXTERNAL_TIMEOUT, whole seconds up to CAP_MAX_S).
import { KINDS, StateError, open } from '../state/index.mjs';
import { CAP_MAX_S, CAP_S, RUN_KINDS, TERMINAL, runIdOf } from './kind.mjs';

export * from './kind.mjs';

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
