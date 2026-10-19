// Commands of the state unit (spec §7.2, §8.2): each calls lib/state with the target directory and env of the
// invocation (REV-58) and turns its result into data and text. State errors become results in main.mjs.
//   `<bin> state unlock --stale` (findings-r3): the only way a lock left by a process that is gone is removed;
//   writes never take one over. It handles the store lock of the repository at the current directory and the
//   machine data lock, after a crash, while no command runs (findings S3): each is removed only when its owner
//   is gone and the lock stayed unchanged for 2 seconds; otherwise it refuses (store-busy) and touches nothing.
//   Exit 0 done (also when nothing was locked) · 1 an unsafe path · 2 --stale missing · 7 no consent, a lock in
//   use or changing (store-busy), or newer machine data · 8 not a git repository.
//   init · decline · deactivate: the activation lifecycle (lib/state/activation.mjs).
//   task new · list · show · set: task state (lib/state/tasks.mjs).
import * as state from '../state/index.mjs';
import { EXIT } from './commands.mjs';

const target = (io, names) => ({ cwd: io.cwd, env: io.env, names });

export function stateUnlock({ flags, names, io }) {
  if (!flags.stale) {
    return { code: EXIT.USAGE, errors: [{ code: 'missing-flag', message: 'state unlock removes only a lock whose owner is gone: pass --stale', hint: `${names.bin} state unlock --stale` }] };
  }
  const where = state.resolve(target(io, names));
  const store = state.unlockStale(state.open(where.dir, { names }));
  const machine = where.dataDir ? state.unlockStaleMachine(where.dataDir, names) : { removed: false, owner: null };
  const line = (what, r) => (r.removed ? `removed the ${what} lock left by pid ${r.owner.pid} on ${r.owner.host}` : `no stale ${what} lock`);
  return { data: { store, machine }, text: `${line('store', store)}\n${line('machine data', machine)}\n` };
}

export function init({ flags, names, version, io }) {
  const r = state.activate({ ...target(io, names), version, options: flags });
  const handle = `handle ${r.handle}${r.registered ? ' (registered)' : ''}`;
  return { data: r, text: `${r.activated ? 'activated' : 'already active'}: ${r.dir}${r.linked ? ' (linked)' : ''}; ${handle}\n` };
}

export function decline({ names, io }) {
  const r = state.decline(target(io, names));
  return { data: r, text: `${r.changed ? 'declined' : 'already declined'}: ${r.repo}; '${names.bin} init' starts tracking explicitly\n` };
}

export function deactivate({ names, io }) {
  const r = state.deactivate(target(io, names));
  const what = r.removed ? `removed ${r.dir}` : r.unlinked ? `unlinked ${r.dir} (its files are kept)` : `nothing to remove in ${r.repo}`;
  return { data: r, text: `${what}; the opt-out is remembered ('${names.bin} init' starts again)\n` };
}

const SUMMARY = ['id', 'kind', 'status', 'owner', 'lane', 'round', 'title'];
const STATUS_WIDTH = Math.max(...state.TASK_STATUSES.map((s) => s.length));

export function taskList({ names, io }) {
  const r = state.listTasks(target(io, names));
  const tasks = r.tasks.map((t) => Object.fromEntries(SUMMARY.map((k) => [k, t[k]])));
  if (!r.active) return { data: { active: false, tasks }, text: `${r.repo} is not active: no tasks ('${names.bin} init' activates it)\n` };
  const width = (key) => Math.max(1, ...tasks.map((t) => String(t[key] ?? '-').length));
  const [id, kind, lane] = [width('id'), width('kind'), width('lane')];
  const line = (t) => [t.id.padEnd(id), t.status.padEnd(STATUS_WIDTH), t.kind.padEnd(kind), (t.lane ?? '-').padEnd(lane), t.title].join('  ');
  return { data: { active: true, tasks }, text: tasks.length ? `${tasks.map(line).join('\n')}\n` : 'no tasks\n' };
}

export function taskShow({ args, names, io }) {
  const t = state.showTask({ ...target(io, names), id: args.id });
  const data = (d) => Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  const lines = [
    `${t.id}  ${t.title}`,
    `kind ${t.kind} · status ${t.status} · owner ${t.owner} · lane ${t.lane ?? '-'} · round ${t.round}${t.base ? ` · base ${t.base}` : ''}`,
    'events:',
    ...t.events.map((e) => `  ${e.at}  ${e.by}  ${e.event}${Object.keys(e.data).length ? `  ${data(e.data)}` : ''}`),
  ];
  return { data: { task: t }, text: `${lines.join('\n')}\n` };
}

export function taskNew({ args, flags, names, io }) {
  const r = state.createTask({ ...target(io, names), title: args.title, kind: flags.kind, lane: flags.lane });
  return { data: r, text: `${r.id}\n` };
}

export function taskSet({ args, flags, names, io }) {
  const r = state.setTask({ ...target(io, names), id: args.id, state: args.state, options: flags });
  return { data: r, text: `${r.id}: ${args.state} recorded; status ${r.task.status}\n` };
}
