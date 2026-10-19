// `<bin> brief <id> [--role implementer|reviewer] [--write [--force]]` (spec §8.2, §5.1, ORC-4): the brief of a routed
// task, rendered from templates/task/brief.md of the plugin and the state; printed by default.
// Filled from the state: the title line (title, ID), the executor (the shipped agent of the role, ORC-1), the class with
// the reason of its last route record and the kind, the branch and the base once recorded, the rule IDs (lib/method
// briefRules: the role's, then the class's), the profile gates in the gate block, and a "Lease env" line after the
// worktree line while the scheduler holds a live lease for the task in this repository. Every other <…> placeholder
// stays for the orchestrator. Each placeholder is filled once, in one pass, so a value is never filled again; a
// template that lost a placeholder the renderer fills is a bug (it throws: INTERNAL).
// The text ends with a marker line holding the sha256 of the text above it. --write stores tasks/<id>/brief.md
// through lib/state (the task's owner): a file whose marker still matches its text is replaced; a brief written or
// edited by hand is kept (exit 1) unless --force.
// Exit 0 · 1 no such task (an inactive repository has none), the task is not routed, a hand-written brief kept · 2 a
// bad ID, role or flag, no registered handle · 7 --write without consent, a newer schema · 8 not a git repository.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { briefRules } from '../method/index.mjs';
import { openStore } from '../profile/index.mjs';
import { leaseEnv, snapshot } from '../sched/index.mjs';
import { KINDS, open, resolve, writeTaskText } from '../state/index.mjs';
import { reviewShown } from '../verify/artifacts.mjs';
import { EXIT } from './commands.mjs';

const ROLES = Object.freeze(['implementer', 'reviewer']);
const GATE_LINES = '<typecheck>\n<lint>\n<tests with a worker limit>\n';
const WORKTREE = 'Worktree: ';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const marker = (bin, hash) => `<!-- rendered by \`${bin} brief\`; sha256 ${hash}: an edit makes this brief hand-written -->\n`;
const MARKER = /<!-- rendered by `[^`\n]+ brief`; sha256 ([0-9a-f]{64}): an edit makes this brief hand-written -->\n$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whether `text` is a rendered brief nobody edited: it ends with the marker of the text above it.
export function unedited(text) {
  const m = MARKER.exec(text);
  return m !== null && sha256(text.slice(0, m.index)) === m[1];
}

// The brief text. task: the task document; gates: the gate commands; lease: the lease env ({ name: value }) or null.
export function renderBrief({ template, task, role, gates, lease, review = null, names }) {
  const last = task.classHistory[task.classHistory.length - 1];
  const reason = last ? last.reason.replace(new RegExp(`^${escape(task.class)}: `), '') : null;
  const fills = {
    '<Task title>': task.title,
    '<task ID>': task.id,
    '<agent | provider model/effort>': `${names.plugin}:${role}`,
    '<trivial | standard | critical>': `${task.class}${reason ? ` — ${reason}` : ''}; kind: ${task.kind}`,
    '<rule IDs>': briefRules({ cls: task.class, role }).join(' '),
    ...(task.branch ? { '<branch>': task.branch } : {}),
    ...(task.base ? { '<base SHA>': task.base } : {}),
    ...(gates.length ? { [GATE_LINES]: gates.map((g) => `${g}\n`).join('') } : {}),
    '{{bin}}': names.bin,
  };
  for (const ph of [...Object.keys(fills), `\n${WORKTREE}`]) {
    if (!template.includes(ph)) throw new Error(`templates/task/brief.md has no ${JSON.stringify(ph.trim())}: the template and lib/cli/brief.mjs disagree`);
  }
  const lines = template.split('\n');
  if (lease) lines.splice(lines.findIndex((l) => l.startsWith(WORKTREE)) + 1, 0, `Lease env (the scheduler's slot for this task): ${Object.entries(lease).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (review) lines.splice(lines.findIndex((l) => l.startsWith('Executor: ')) + 1, 0, `Review: ${review.text}`);
  const filled = new Set();
  const once = new RegExp(Object.keys(fills).map(escape).join('|'), 'g');
  let text = lines.join('\n').replace(once, (m) => {
    if (m !== '{{bin}}' && filled.has(m)) return m;
    filled.add(m);
    return fills[m];
  });
  if (!text.endsWith('\n')) text += '\n';
  return `${text}${marker(names.bin, sha256(text))}`;
}

export function brief({ args, flags, names, io, pluginRoot }) {
  const { bin } = names;
  const id = args.id;
  const role = flags.role ?? 'implementer';
  if (!ROLES.includes(role)) return { code: EXIT.USAGE, errors: [{ code: 'invalid-value', message: `--role ${String(role).slice(0, 40)}: expected ${ROLES.join(' or ')}`, hint: `${bin} brief ${id} --role reviewer` }] };
  if (flags.force && !flags.write) return { code: EXIT.USAGE, errors: [{ code: 'missing-flag', message: '--force applies only with --write', hint: `${bin} brief ${id} --write --force` }] };
  KINDS.task.path(id); // a malformed ID is a usage error (invalid-key)
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  const task = where.active ? open(where.dir, { names }).read('task', id) : null;
  if (!task) {
    const message = where.active ? `no task ${id} in ${where.dir}` : `no task ${id}: ${where.repo} is not active`;
    return { code: EXIT.FAIL, errors: [{ code: 'task-unknown', message, hint: where.active ? `'${bin} task list' lists the tasks` : `'${bin} init' activates it` }] };
  }
  if (!task.class) {
    return { code: EXIT.FAIL, errors: [{ code: 'task-unrouted', message: `${id} is not routed: its class decides the depth and the rules of the brief`, hint: `${bin} route ${id} --paths <p,…> --loc <n>` }] };
  }
  const gates = (openStore(where.dir, names).read('profile')?.gates ?? []).map((g) => g.cmd);
  const held = where.dataDir ? snapshot({ names, env: io.env }).leases.find((l) => l.owner && l.status === 'live' && l.task === id && l.project === where.worktree) : undefined; // a lease names the checkout it was taken in (lib/sched)
  const lease = held ? leaseEnv(held, names) : null;
  const template = readFileSync(join(pluginRoot, 'templates', 'task', 'brief.md'), 'utf8');
  const review = reviewShown(open(where.dir, { names }), task.class, { names, env: io.env });
  const text = renderBrief({ template, task, role, gates, lease, review, names });
  const data = { task: id, role, class: task.class, kind: task.kind, title: task.title, rules: briefRules({ cls: task.class, role }), gates, lease, review, text, written: null, file: null };
  if (!flags.write) return { data, text };
  const w = writeTaskText({ cwd: io.cwd, env: io.env, names, id, name: 'brief', text, replace: (cur) => Boolean(flags.force) || unedited(cur) });
  const done = { ...data, written: w.outcome, file: w.file };
  if (w.outcome === 'kept') {
    return { code: EXIT.FAIL, data: done, errors: [{ code: 'brief-hand-written', message: `${w.file} was written or edited by hand: it is kept`, hint: `compare it with '${bin} brief ${id}'; '${bin} brief ${id} --write --force' replaces it` }] };
  }
  return { data: done, text: `${w.outcome}: ${w.file}\n` };
}
