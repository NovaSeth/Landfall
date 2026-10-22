// SessionStart (startup|resume|clear|compact) → `session-start` (spec §7.2, §7.13, §8.3, SC3, GC7): the session
// context of an active repository, at most CONTEXT_MAX characters: the state line, the tier when known, the profile scan line when one is due, the loop state
// (lib/hooks/loop-state.mjs), the active tasks with their next step, the next action ("run `<bin> tick`") and the
// always rules of the method (up to 8). An inactive, declined or non-git directory gets nothing; nothing is written.
// Budget: the fixed lines and the rules come first; tasks fill the rest in ID order and the remainder is counted in
// one "… N more" line. Tasks are read until the hook's deadline nears. The text goes through lib/text forModel.
// The tier comes from the adaptive engine (explain only, nothing recorded); the line is left out when it is off.
import { isAbsolute, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ENGINE_FLAG, lastRecordedChange } from '../engine/index.mjs';
import { readProfile } from '../profile/index.mjs';
import { open } from '../state/index.mjs';
import { getRule, openMethod } from '../method/index.mjs';
import { forModel } from '../text/clean.mjs';
import { loadNames, loopExit, readLoop, stateOf } from './loop-state.mjs';

export const CONTEXT_MAX = 2000;
const MAX_RULES = 8;
const TITLE_MAX = 60;
const READ_MARGIN_MS = 150; // stop reading tasks this long before the deadline
const CLOSED = new Set(['done', 'cancelled']);

// The next step per active task status (spec §7.6, §8.2); the loop's tick computes the authoritative steps.
export const NEXT_STEP = Object.freeze({
  new: 'classify it with route',
  planned: 'write the brief and dispatch it',
  dispatched: 'wait for the executor report',
  implemented: 'review it',
  'in-review': 'record the review',
  'fix-round': 'dispatch the fix round, then re-review',
  verified: 'close it with task done',
  blocked: 'resolve the blocker (task show)',
});

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function loopLine(loop, bin) {
  if (loop.error) return `Loop: state cannot be read (${clip(oneLine(loop.error), 40)}); run \`${bin} tick\` by hand.`;
  if (loop.exit) return `Loop: ended (${loop.exit}); schedule no further wakeup.`;
  if (loop.doc) return `Loop: running${Number.isInteger(loop.doc.ticks) ? `, tick ${loop.doc.ticks}` : ''}.`;
  return null;
}
const taskLine = (t) => `- ${t.id} ${t.status}${t.round > 0 ? ` r${t.round}` : ''}: ${clip(oneLine(t.title), TITLE_MAX)} → ${NEXT_STEP[t.status] ?? 'see task show'}`;

// Pure: the context text, never longer than max. tasks: active task documents in order (more: how many were not
// read); loop: { doc, exit } | { error }; rules: [{ id, text }].
export function renderContext({ bin, where, tier = null, scan = null, tasks = [], more = 0, loop = {}, rules = [], max = CONTEXT_MAX }) {
  let head = [`${bin} is active here (${where}); task state changes only through \`${bin}\` commands (FLW-7).`];
  if (tier) head.push(`Tier: ${clip(oneLine(tier), 10)}.`);
  const scanLine = scan?.due ? `Profile: scan due (${clip(oneLine(scan.reason ?? 'due'), 40)}); run \`${bin} profile observe\`.` : null;
  if (scanLine) head.push(scanLine);
  const l = loopLine(loop, bin);
  if (l) head.push(l);
  const next = `Next: run \`${bin} tick\` and do the listed steps.`;
  const ruleLines = rules.slice(0, MAX_RULES).map((r) => `${r.id}. ${oneLine(r.text)}`);
  const join = (ls) => ls.join('\n');
  const build = (taskLines, rl) => join([...head, ...taskLines, next, ...(rl.length ? ['Core rules:', ...rl] : [])]);
  // rules first: drop from the end only if even no task fits them
  if (scanLine && build([], ruleLines).length > max) head = head.filter((x) => x !== scanLine); // the scan line goes before any rule
  let rl = ruleLines;
  while (rl.length && build([], rl).length > max) rl = rl.slice(0, -1);
  const lines = [];
  const total = tasks.length + more;
  const moreLine = (n) => `- … ${n} more: \`${bin} task list\``;
  if (total) lines.push(`Active tasks (${total}):`);
  for (let k = 0; k < tasks.length; k++) {
    const rest = total - k - 1;
    const candidate = [...lines, taskLine(tasks[k]), ...(rest ? [moreLine(rest)] : [])];
    if (build(candidate, rl).length > max) { lines.push(moreLine(total - k)); break; }
    lines.push(taskLine(tasks[k]));
    if (k === tasks.length - 1 && more) lines.push(moreLine(more));
  }
  if (!tasks.length && more) lines.push(moreLine(more));
  let text = build(lines, rl);
  if (text.length > max) text = build([], rl); // the task header alone did not fit
  return text.length > max ? text.slice(0, max) : text;
}

// The active tasks of a store, read until the deadline nears: { tasks, more }.
function activeTasks(store, deadline) {
  const ids = store.list('task');
  const tasks = [];
  let k = 0;
  for (; k < ids.length && performance.now() < deadline - READ_MARGIN_MS; k++) {
    let doc = null;
    try { doc = store.read('task', ids[k]); } catch { continue; } // an unreadable task: `task list` reports it
    if (doc && !CLOSED.has(doc.status)) tasks.push(doc);
  }
  return { tasks, more: ids.length - k };
}

function alwaysRules() {
  try {
    const method = openMethod();
    return method.index.always.slice(0, MAX_RULES).map((id) => getRule(method, id)).filter(Boolean);
  } catch { return []; } // a broken method copy: the context still carries the state
}

// The applied tier (spec §7.4): the latest recorded tier change while the engine flag is on, else L0 (shadow mode or
// no decision). A read of two files, never an evaluation (that runs detached); a near deadline leaves the line out.
function tierOf(where, names, env, deadline) {
  if (performance.now() > deadline - 2 * READ_MARGIN_MS) return null;
  try {
    const mode = open(where.dir, { names }).read('config', null)?.flags?.[ENGINE_FLAG] ?? 'shadow';
    return mode === 'on' ? lastRecordedChange(where.dir).tier : mode === 'off' ? null : 'L0';
  } catch { return null; }
}

// The profile scan trigger (read only): { due: true, reason } or null; an error or a near deadline means no line.
function scanOf(where, names, env, deadline) {
  if (performance.now() >= deadline - 2 * READ_MARGIN_MS) return null;
  try {
    const { scan } = readProfile(where, { names, env });
    return scan?.due ? { due: true, reason: scan.reason } : null;
  } catch { return null; }
}

// Registry handler: (hook input, { env, deadline }) → { stdout }.
export function sessionStart(input, { env = process.env, deadline = Infinity } = {}) {
  const cwd = [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d));
  if (!cwd) return { stdout: '' };
  const names = loadNames();
  const where = stateOf(cwd, env, deadline).where; // git bounded by the budget; an unknown state injects nothing
  if (!where?.active) return { stdout: '' };
  const store = open(where.dir, { names });
  const r = readLoop(where.dir);
  const loop = r.error ? { error: r.error } : { doc: r.doc, exit: loopExit(r.doc) };
  const { tasks, more } = activeTasks(store, deadline);
  const rel = relative(where.worktree, where.dir); // from a linked worktree: the main checkout's state, by its path
  const tier = tierOf(where, names, env, deadline);
  const scan = scanOf(where, names, env, deadline);
  const text = renderContext({ bin: names.bin, tier, scan, where: `state in ${rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : where.dir}`, tasks, more, loop, rules: alwaysRules() });
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: forModel(text) } })}\n` };
}
