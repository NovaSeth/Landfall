// GitHub mirror (T-MG-19, D-MG-23): one-way and opt-in. Landfall tasks become GitHub issues; issues are never read back
// into the state. The only unit that spawns `gh` (lib/proc owner table). Task text is data: it reaches gh as argv items
// or on stdin, never through a shell.
import { run } from '../proc/index.mjs';

const MARKER = /^<!-- landfall:(T-[A-Z]{2,4}-[1-9]\d{0,5}) -->/;
const CLOSED = new Set(['done', 'cancelled']);
const MANAGED = (name) => name === 'landfall' || name.startsWith('class:') || name.startsWith('status:');
const gh = (args, { io, input } = {}) => run('gh', args, { unit: 'mirror', cwd: io.cwd, env: io.env, input, timeoutMs: 60000 });

export const markerOf = (id) => `<!-- landfall:${id} -->`;

// The issue a task should have.
export function desired(task) {
  const lines = [markerOf(task.id), '', `status: ${task.status}`, `class: ${task.class ?? 'unrouted'}`];
  if (task.branch) lines.push(`branch: ${task.branch}`);
  if (task.base) lines.push(`base: ${task.base}`);
  if (task.mergedAt) lines.push(`merged: ${task.mergedAt}`);
  return {
    id: task.id,
    title: `${task.id} ${task.title}`,
    body: `${lines.join('\n')}\n`,
    labels: ['landfall', ...(task.class ? [`class:${task.class}`] : []), `status:${task.status}`],
    closed: CLOSED.has(task.status),
  };
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trimEnd();

// Plan: one entry per task: create, edit (with what differs), or none. Existing issues are found by their marker.
export function plan(tasks, issues) {
  const byId = new Map();
  for (const issue of issues) {
    const id = MARKER.exec(String(issue.body ?? '').replace(/^\s+/, ''))?.[1];
    if (id && !byId.has(id)) byId.set(id, issue);
  }
  return tasks.map((task) => {
    const want = desired(task);
    const have = byId.get(task.id);
    if (!have) return { action: 'create', id: task.id, want };
    const names = (have.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    const current = names.filter(MANAGED);
    const diff = [];
    if (have.title !== want.title) diff.push('title');
    if (norm(have.body) !== norm(want.body)) diff.push('body');
    const add = want.labels.filter((l) => !current.includes(l));
    const remove = current.filter((l) => !want.labels.includes(l));
    if (add.length || remove.length) diff.push('labels');
    const isClosed = String(have.state).toUpperCase() === 'CLOSED';
    if (isClosed !== want.closed) diff.push(want.closed ? 'close' : 'reopen');
    return { action: diff.length ? 'edit' : 'none', id: task.id, number: have.number, want, diff, add, remove };
  });
}

export const authStatus = (ctx) => gh(['auth', 'status'], ctx);
export function defaultRepo(ctx) {
  const r = gh(['repo', 'view', '--json', 'nameWithOwner'], ctx);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).nameWithOwner ?? null; } catch { return null; }
}
export function listIssues(repo, ctx) {
  const r = gh(['issue', 'list', '--repo', repo, '--label', 'landfall', '--state', 'all', '--json', 'number,body,title,state,labels', '--limit', '1000'], ctx);
  if (r.status !== 0) return { error: r.stderr.trim() || 'gh issue list failed' };
  try { return { issues: JSON.parse(r.stdout || '[]') }; } catch { return { error: 'gh issue list printed no JSON' }; }
}

// Applies the plan; stops at the first gh failure. Returns { done, error }.
export function apply(repo, entries, ctx) {
  const todo = entries.filter((e) => e.action !== 'none');
  const fail = (what, r) => ({ done: false, error: `${what}: ${r.stderr.trim() || r.error || `exit ${r.status}`}` });
  for (const name of new Set(todo.flatMap((e) => e.want.labels))) {
    const r = gh(['label', 'create', name, '--repo', repo, '--force'], ctx);
    if (r.status !== 0) return fail(`label ${name}`, r);
  }
  for (const e of todo) {
    if (e.action === 'create') {
      const r = gh(['issue', 'create', '--repo', repo, '--title', e.want.title, '--body-file', '-', ...e.want.labels.flatMap((l) => ['--label', l])], { ...ctx, input: e.want.body });
      if (r.status !== 0) return fail(`create ${e.id}`, r);
      const number = /\/issues\/(\d+)/.exec(r.stdout)?.[1];
      if (e.want.closed && number) {
        const c = gh(['issue', 'close', number, '--repo', repo], ctx);
        if (c.status !== 0) return fail(`close ${e.id}`, c);
      }
      continue;
    }
    if (e.diff.some((d) => ['title', 'body', 'labels'].includes(d))) {
      const args = ['issue', 'edit', String(e.number), '--repo', repo, '--title', e.want.title, '--body-file', '-'];
      for (const l of e.add) args.push('--add-label', l);
      for (const l of e.remove) args.push('--remove-label', l);
      const r = gh(args, { ...ctx, input: e.want.body });
      if (r.status !== 0) return fail(`edit ${e.id}`, r);
    }
    const state = e.diff.includes('close') ? 'close' : e.diff.includes('reopen') ? 'reopen' : null;
    if (state) {
      const r = gh(['issue', state, String(e.number), '--repo', repo], ctx);
      if (r.status !== 0) return fail(`${state} ${e.id}`, r);
    }
  }
  return { done: true, error: null };
}
