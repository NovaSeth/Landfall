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
import { join } from 'node:path';
import { DEFAULT_CAPS, LOOP, STORE_KINDS, nextSteps } from '../loop/index.mjs';
import { readRuns } from '../receipts/index.mjs';
import * as state from '../state/index.mjs';
import { openStore } from '../verify/index.mjs';
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

const SUMMARY = ['id', 'status', 'class', 'round', 'kind', 'lane', 'branch', 'title'];
const JSON_SUMMARY = ['id', 'kind', 'status', 'owner', 'lane', 'round', 'title', 'class', 'branch', 'base'];
const STATUS_WIDTH = Math.max(...state.TASK_STATUSES.map((s) => s.length));

export function taskList({ names, io }) {
  const r = state.listTasks(target(io, names));
  const tasks = r.tasks.map((t) => Object.fromEntries(JSON_SUMMARY.map((k) => [k, t[k] ?? null])));
  if (!r.active) return { data: { active: false, tasks }, text: `${r.repo} is not active: no tasks ('${names.bin} init' activates it)\n` };
  const cell = (t, k) => (k === 'round' ? (t.round ? `r${t.round}` : '-') : String(t[k] ?? '-'));
  const rows = tasks.map((t) => SUMMARY.map((k) => cell(t, k)));
  const widths = SUMMARY.map((k, i) => (k === 'status' ? STATUS_WIDTH : Math.max(1, ...rows.map((row) => row[i].length))));
  const line = (row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return { data: { active: true, tasks }, text: tasks.length ? `${rows.map(line).join('\n')}\n` : 'no tasks\n' };
}

const CLOSED = new Set(['done', 'cancelled']);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The step-table row of one task (the call `status` makes for all of them).
function nextOf(where, names, env, t) {
  const store = state.open(where.dir, { names, kinds: STORE_KINDS });
  const team = store.list('team').map((h) => store.read('team', h));
  const { email } = state.gitIdentity(where.repo, { env });
  const hash = email ? state.emailHash(email) : null;
  const table = nextSteps({
    tasks: [t], runs: readRuns(join(where.local, 'runs')).runs, handles: team.map((d) => d.handle), me: team.find((d) => d.emailSha256 === hash)?.handle ?? null,
    plan: null, lanesOn: store.read('config', null)?.flags?.lanes === 'on', caps: store.read(LOOP.name, null)?.caps ?? DEFAULT_CAPS, now: Date.now(), bin: names.bin, problem: null, dirty: () => [],
  });
  const row = [...table.steps, ...table.info].find((x) => x.task === t.id);
  return row ? { state: row.state, step: row.step ?? null, rules: row.rules ?? [] } : null;
}

function cardOf(t, where, names, env) {
  const store = openStore(where.dir, names);
  const v = store.read('verify', t.id);
  const worktree = [...t.events].reverse().find((e) => e.event === 'started')?.data?.worktree ?? null;
  const reviews = store.list('review').filter((k) => k.startsWith(`${t.id}/`)).map((k) => {
    const rec = store.read('review', k);
    return { round: Number(/-r(\d+)$/.exec(k)[1]), verdict: rec.verdict, reviewer: rec.reviewer.kind, blocking: rec.findings.filter((f) => f.severity === 'blocking').length, minor: rec.findings.filter((f) => f.severity === 'minor').length, findings: rec.findings };
  }).sort((a, b) => a.round - b.round);
  const latest = reviews[reviews.length - 1];
  const openFindings = latest?.verdict === 'needs-fixes' ? latest.findings.filter((f) => f.severity === 'blocking').map((f) => ({ id: f.id, path: f.path, line: f.line, text: f.text })) : [];
  return {
    class: t.class, branch: t.branch, base: t.base, worktree,
    after: state.afterOf(t).map((id) => ({ id, status: state.open(where.dir, { names }).read('task', id)?.status ?? 'unknown' })),
    verify: v ? { result: v.result, head: v.head, runs: t.events.filter((e) => e.event === 'verify').length, at: v.startedAt } : null,
    reviews: reviews.map(({ findings, ...r }) => r),
    openFindings,
    next: CLOSED.has(t.status) ? null : nextOf(where, names, env, t),
  };
}

export function taskShow({ args, names, io }) {
  const t = state.showTask({ ...target(io, names), id: args.id });
  const where = state.resolve({ cwd: io.cwd, env: io.env, names });
  const card = cardOf(t, where, names, io.env);
  const data = (d) => Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  const v = card.verify;
  const next = CLOSED.has(t.status) ? `none (${t.status})` : card.next ? `${card.next.state}${card.next.step ? ` → ${card.next.step}` : ''}${card.next.rules.length ? ` (${card.next.rules.join(', ')})` : ''}` : null;
  const lines = [
    `${t.id}  ${t.title}`,
    `kind ${t.kind} · status ${t.status} · class ${t.class ?? '-'} · owner ${t.owner} · lane ${t.lane ?? '-'} · round ${t.round}`,
    `branch ${t.branch ?? '-'} · base ${t.base ?? '-'} · worktree ${card.worktree ?? '-'}`,
    ...(card.after.length ? [`after: ${card.after.map((a) => `${a.id} (${a.status})`).join(', ')}`] : []),
    v ? `verify: ${v.result} at ${v.head ? v.head.slice(0, 12) : 'uncommitted'} (${v.runs} runs, last ${v.at})` : 'verify: none',
    card.reviews.length
      ? `reviews: ${card.reviews.map((r) => `r${r.round} ${r.verdict} (${[r.reviewer, r.blocking ? `${r.blocking} blocking` : null, r.minor ? `${r.minor} minor` : null].filter(Boolean).join(', ')})`).join(', ')}`
      : 'reviews: none',
    ...(card.openFindings.length ? [`open findings: ${card.openFindings.map((f) => `${f.id} ${clip(f.text, 80)}`).join('; ')}`] : []),
    ...(next ? [`next: ${next}`] : []),
    'events:',
    ...t.events.map((e) => `  ${e.at}  ${e.by}  ${e.event}${Object.keys(e.data).length ? `  ${data(e.data)}` : ''}`),
  ];
  return { data: { task: t, card }, text: `${lines.join('\n')}\n` };
}

export function taskNew({ args, flags, names, io }) {
  const after = flags.after === undefined ? [] : String(flags.after).split(',').map((s) => s.trim()).filter(Boolean);
  const r = state.createTask({ ...target(io, names), title: args.title, kind: flags.kind, lane: flags.lane, after });
  return { data: r, text: `${r.id}${after.length ? ` (after ${after.join(', ')})` : ''}\n` };
}

export function taskSet({ args, flags, names, io }) {
  const r = state.setTask({ ...target(io, names), id: args.id, state: args.state, options: flags });
  return { data: r, text: `${r.id}: ${args.state} recorded; status ${r.task.status}\n` };
}
