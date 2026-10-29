// CLI handlers return data/text; cli/output.mjs is the only terminal writer.
import { authorHandle, createDecision } from '../decisions/write.mjs';
import { KINDS, StateError, check, createTaskInStore, open, resolve } from '../state/index.mjs';
import { closeFindings, fileSelection, listLine, readFindings, reviewSelection, selectedFindings } from './index.mjs';

const usage = (message) => new StateError('invalid-value', 'USAGE', message);
const statuses = ['open', 'taken', 'fixed', 'dropped', 'all'];
const idsOf = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function context({ io, names }, write = false) {
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  if (write && !where.active) throw new StateError('inactive', 'REFUSED', 'findings can be changed only in an active repository', { hint: `${names.bin} init` });
  return { where, store: open(where.dir, { names }) };
}
const activeOnly = (findings) => {
  const closed = findings.find((f) => f.status !== 'open' && f.status !== 'taken');
  if (closed) throw usage(`${closed.id} is ${closed.status}; only open or taken findings can be closed`);
};

export function list(ctx) {
  const { flags } = ctx;
  if (flags.status !== undefined && !statuses.includes(flags.status)) throw usage(`--status must be ${statuses.join('|')}`);
  if (flags.task !== undefined) KINDS.task.path(flags.task);
  const { where, store } = context(ctx);
  const findings = (where.active ? readFindings(store) : []).filter((f) =>
    (flags.task === undefined || f.task === flags.task) && (flags.status === undefined ? ['open', 'taken'].includes(f.status) : flags.status === 'all' || f.status === flags.status));
  return { data: { findings }, text: findings.length ? `${findings.map(listLine).join('\n')}\n` : 'no findings\n' };
}

export function show(ctx) {
  const { store } = context(ctx);
  const [finding] = selectedFindings(store, [ctx.args.id]);
  return { data: { finding }, text: `${JSON.stringify(finding, null, 2)}\n` };
}

export function add(ctx) {
  const { flags, names, io } = ctx;
  const ids = idsOf(flags.ids);
  if (!ids.length || !/^[1-9]\d{0,2}$/.test(flags.round ?? '')) throw usage('findings add needs --task <id> --round <1..999> --ids <F1,F2>');
  const { where, store } = context(ctx, true);
  const handle = authorHandle({ store, where, names, env: io.env });
  const filed = store.batch((s) => fileSelection(s, reviewSelection(s, { task: flags.task, round: Number(flags.round), ids }), handle));
  return { data: { filed }, text: `filed: ${filed.length ? filed.join(', ') : 'none'}\n` };
}

export function take(ctx) {
  const { args, flags, names, io } = ctx;
  const ids = args.ids ?? [];
  if ((flags.all && ids.length) || (!flags.all && !ids.length)) throw usage('name finding IDs or --all (not both)');
  const { where, store } = context(ctx, true);
  const handle = authorHandle({ store, where, names, env: io.env });
  const result = store.batch((s) => {
    const findings = flags.all ? readFindings(s).filter((f) => f.status === 'open') : selectedFindings(s, ids);
    if (!findings.length) throw usage('there are no open findings to take');
    const notOpen = findings.find((f) => f.status !== 'open');
    if (notOpen) throw usage(`${notOpen.id} is ${notOpen.status}; only open findings can be taken`);
    const title = flags.title ?? [...`Backlog: ${findings.length} findings (${findings.slice(0, 5).map((f) => f.id).join(', ')})`].slice(0, 120).join('');
    const task = createTaskInStore({ store: s, handle, title });
    // The task is written first; a failure while the findings are assigned puts them back to open and cancels it.
    const done = [];
    try {
      for (const f of findings) {
        done.push(f); // before the write: a write that failed late is rolled back too
        s.write('finding', f.id, { ...f, status: 'taken', takenBy: task.id });
      }
    } catch (err) {
      for (const f of done) { try { s.write('finding', f.id, f); } catch { /* best effort: the original error is the one reported */ } }
      try {
        s.update('task', task.id, (doc) => {
          doc.status = 'cancelled';
          doc.events.push({ at: new Date().toISOString(), by: handle, event: 'cancelled', data: { reason: 'take failed' } });
          return doc;
        });
      } catch { /* the original error is the one reported */ }
      throw err;
    }
    return { task: task.id, findings: findings.map((f) => f.id) };
  });
  return { data: result, text: `${result.task}\nnext: ${names.bin} route ${result.task} --paths <p,…> --loc <n>\n` };
}

export function close(ctx) {
  const { flags } = ctx;
  KINDS.task.path(flags.task);
  const { store } = context(ctx, true);
  const fixed = store.batch((s) => {
    if (!s.read('task', flags.task)) throw usage(`no task ${flags.task}`);
    const findings = selectedFindings(s, ctx.args.ids);
    activeOnly(findings);
    const other = findings.find((f) => f.takenBy !== null && f.takenBy !== flags.task);
    if (other) throw usage(`${other.id} was taken by ${other.takenBy}`);
    return closeFindings(s, findings, { by: flags.task, reason: `Fixed by ${flags.task}` });
  });
  return { data: { fixed }, text: `findings fixed: ${fixed.join(', ')}\n` };
}

export function drop(ctx) {
  const { flags, names, io } = ctx;
  const reason = flags.reason?.trim();
  if (!reason || [...reason].length < 10) throw usage('--reason needs at least 10 characters');
  const { where, store } = context(ctx, true);
  const handle = authorHandle({ store, where, names, env: io.env });
  const result = store.batch((s) => {
    const findings = selectedFindings(s, ctx.args.ids);
    activeOnly(findings);
    // Validate every final document before creating the explanatory decision.
    for (const f of findings) {
      const errors = check(KINDS.finding, { ...f, status: 'dropped', closedAt: new Date().toISOString(), closedBy: `D-${handle}-1`, reason });
      if (errors.length) throw usage(errors[0].message);
    }
    const decision = createDecision({ store: s, where, names, env: io.env, handle, input: {
      title: `Drop ${findings.length} backlog findings`, why: reason, cost: 'These findings will remain recorded as dropped.',
      scope: [], kind: 'general',
    } });
    return { dropped: closeFindings(s, findings, { status: 'dropped', by: decision.id, reason }), decision: decision.id };
  });
  return { data: result, text: `findings dropped: ${result.dropped.join(', ')} (${result.decision})\n` };
}
