// Tasks (spec §5.1, §8.2, SD-8, SD-9, GC3; the successor of the 1.x task.sh): tasks/<T-H-n>/task.json, created
// with the next ID of the developer's handle (the one registered for the git email of the target repository)
// and changed only by its owner. setTask records one state as an event { at, by, event, data } and moves the
// status:
//   dispatched --executor <e> --base <sha> [--lane <l>]   → dispatched (base and lane stored on the task)
//   implementer --report done|done-with-concerns           → implemented
//   implementer --report needs-context|blocked             → blocked
//   blocked --reason <t> · cancelled --reason <t>          → blocked · cancelled
//   fix-round --round <k> --addressed <n> --open <n>       → fix-round (round k)
//   self-verified [--round <k>] · status-request           → status unchanged (round default: the task's, ≥ 1)
// --note <t> fits every state. A task is never set done here (GC3: done needs a passing verify); a done or
// cancelled task is closed. With the lanes capability on (state.json flags.lanes = on), a task is dispatched
// only with a lane. Text values are checked like state fields (limits; no control, zero-width or bidi
// characters). Writes refuse in an inactive repository (exit 7) and check every value before the store lock;
// reads write nothing.
// Task texts (spec §5.1, TASK_TEXTS): Markdown files next to task.json, written whole by the task's owner
// (writeTaskText: `brief --write` stores tasks/<id>/brief.md); the caller decides whether an existing file may be
// replaced, under the same store lock as the write.
import { join } from 'node:path';
import { checkWrite } from './document.mjs';
import { StateError, guarded } from './errors.mjs';
import { allocateId } from './ids.mjs';
import { KINDS, LIMITS, PATTERNS } from './kinds.mjs';
import { resolve } from './resolve.mjs';
import { validate } from './schema.mjs';
import { open } from './store.mjs';
import { emailHash, gitIdentity } from './team.mjs';

const REPORTS = { done: 'implemented', 'done-with-concerns': 'implemented', 'needs-context': 'blocked', blocked: 'blocked' };
const unchanged = (data, doc) => doc.status;
const STATES = Object.freeze({
  dispatched: { required: ['executor', 'base'], optional: ['lane'], status: () => 'dispatched' },
  implementer: { required: ['report'], status: (data) => REPORTS[data.report] },
  blocked: { required: ['reason'], status: () => 'blocked' },
  cancelled: { required: ['reason'], status: () => 'cancelled' },
  'fix-round': { required: ['round', 'addressed', 'open'], status: () => 'fix-round' },
  'self-verified': { optional: ['round'], status: unchanged },
  'status-request': { status: unchanged },
});
const CLOSED = ['done', 'cancelled'];
const text = (max, extra = {}) => ({ t: 'str', max, min: 1, ...extra });
const VALUES = {
  executor: text(LIMITS.actor, { re: PATTERNS.actor }),
  base: text(64, { re: PATTERNS.sha }),
  lane: text(LIMITS.lane, { re: PATTERNS.lane }),
  reason: text(LIMITS.reason),
  note: text(LIMITS.reason),
  report: { t: 'enum', of: Object.keys(REPORTS) },
  round: { t: 'int', min: 1, max: LIMITS.round },
  addressed: { t: 'int', min: 0, max: LIMITS.idNumber },
  open: { t: 'int', min: 0, max: LIMITS.idNumber },
};
const now = () => new Date().toISOString();
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });

function value(name, raw) {
  const spec = VALUES[name];
  const v = spec.t === 'int' && typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : raw;
  const errors = validate({ t: 'obj', f: { [`--${name}`]: spec } }, { [`--${name}`]: v });
  if (errors.length) throw usage(errors[0].code, errors[0].message);
  return v;
}

// The checked options of `state` ({ name: value }): every required one present, none that does not apply.
function stateOptions(state, given, doneCommand) {
  if (state === 'done') throw usage('done-needs-verify', 'task set never marks a task done: done needs a passing verify (GC3)', `after a passing verify: ${doneCommand}`);
  if (typeof state !== 'string' || !Object.hasOwn(STATES, state)) throw usage('unknown-state', `unknown state ${JSON.stringify(state)}`, `one of ${Object.keys(STATES).join('|')}`);
  const rule = STATES[state];
  const allowed = [...(rule.required ?? []), ...(rule.optional ?? []), 'note'];
  const out = {};
  for (const [name, raw] of Object.entries(given ?? {})) {
    if (raw === undefined) continue;
    if (!allowed.includes(name)) throw usage('unexpected-flag', `--${name} does not apply to ${state}`, `${state} takes ${allowed.map((n) => `--${n}`).join(', ')}`);
    out[name] = value(name, raw);
  }
  const missing = (rule.required ?? []).filter((n) => out[n] === undefined);
  if (missing.length) throw usage('missing-flag', `${state} needs ${missing.map((n) => `--${n}`).join(' and ')}`, `${state} takes ${allowed.map((n) => `--${n}`).join(', ')}`);
  return out;
}

function activeStore({ cwd, env, names }) {
  const where = resolve({ cwd, env, names });
  if (!where.active) throw new StateError('inactive', 'REFUSED', `${where.repo} is not active: there is no state to write`, { hint: `'${names.bin} init' activates it` });
  return { where, store: open(where.dir, { names }) };
}

// The handle registered for the git email of the repository (team/<H>.json holds its hash).
function actor(store, where, env, names) {
  const { email } = gitIdentity(where.repo, { env });
  if (!email) throw usage('email-required', 'a git user.email is needed to find your handle', 'set it with: git config user.email <address>');
  const hash = emailHash(email);
  const mine = store.list('team').map((h) => store.read('team', h)).find((doc) => doc?.emailSha256 === hash);
  if (!mine) throw usage('handle-unknown', `no handle is registered for your git user.email in ${where.dir}`, `'${names.bin} init' registers yours`);
  return mine.handle;
}

const unknownTask = (id, where, names) => usage('task-unknown', `no task ${id} in ${where.dir}`, `'${names.bin} task list' lists the tasks`);
const lanesOn = (store) => store.read('state', null)?.flags?.lanes === 'on';

// `task new`: { id, task }.
export function createTask({ cwd, env, names, title, kind = 'task', lane = null, at = now() } = {}) {
  return guarded(() => {
    const { where, store } = activeStore({ cwd, env, names });
    const by = actor(store, where, env, names);
    const build = (id) => ({ id, kind, title, lane: lane ?? null, owner: by, class: null, classHistory: [], status: 'new', round: 0, events: [{ at, by, event: 'created', data: {} }], base: null, branch: null });
    const probe = `T-${by}-1`;
    checkWrite(KINDS.task, { schema: KINDS.task.version, ...build(probe) }, { where: 'task', key: probe });
    const id = allocateId(store, { prefix: 'T', handle: by, build });
    return { id, task: store.read('task', id) };
  });
}

// `task set`: { id, task, event }. options: the flags of the state (strings from the CLI, or numbers).
export function setTask({ cwd, env, names, id, state, options = {}, at = now() } = {}) {
  return guarded(() => {
    const opts = stateOptions(state, options, `${names.bin} task done ${PATTERNS.taskId.test(String(id)) ? id : '<id>'}`);
    const { where, store } = activeStore({ cwd, env, names });
    KINDS.task.path(id);
    const by = actor(store, where, env, names);
    let event = null;
    const task = store.update('task', id, (doc) => {
      if (doc === null) throw unknownTask(id, where, names);
      if (doc.owner !== by) throw new StateError('not-owner', 'FAIL', `${id} belongs to ${doc.owner}; only its owner records its state`, { hint: 'ask the owner; taking a task over needs a decision record' });
      if (CLOSED.includes(doc.status)) throw new StateError('task-closed', 'FAIL', `${id} is ${doc.status}: a closed task takes no further state`, { hint: `'${names.bin} task new' starts a new task` });
      const data = { ...opts };
      if (state === 'self-verified' && data.round === undefined) data.round = Math.max(doc.round, 1);
      if (state === 'dispatched') {
        if (data.lane === undefined && doc.lane === null && lanesOn(store)) throw usage('lane-required', `${id} has no lane and the lanes capability is on`, 'pass --lane <lane>');
        doc.base = data.base;
        if (data.lane !== undefined) doc.lane = data.lane;
      }
      if (state === 'fix-round') doc.round = data.round;
      doc.status = STATES[state].status(data, doc);
      event = { at, by, event: state, data };
      doc.events.push(event);
      return doc;
    });
    return { id, task, event };
  });
}

// Task text files by name: tasks/<id>/<file>.
export const TASK_TEXTS = Object.freeze({ brief: 'brief.md' });
const TEXT_MAX = 65536;

// Writes the task text `name` of task `id` for its owner, under the store lock: { file, outcome }. outcome: created ·
// replaced (replace(current text) allowed it) · unchanged (same text, nothing written) · kept (replace refused).
export function writeTaskText({ cwd, env, names, id, name, text, replace = () => false } = {}) {
  return guarded(() => {
    if (!Object.hasOwn(TASK_TEXTS, name)) throw new TypeError(`state.writeTaskText: unknown task text ${name}`);
    const rel = KINDS.task.path(id).replace(/[^/]+$/, TASK_TEXTS[name]);
    if (typeof text !== 'string' || Buffer.byteLength(text) > TEXT_MAX) throw usage('limit-exceeded', `tasks/${id}/${TASK_TEXTS[name]}: at most ${TEXT_MAX} bytes of text`, 'shorten it; nothing was written');
    const { where, store } = activeStore({ cwd, env, names });
    const by = actor(store, where, env, names);
    let outcome = null;
    store.locked(() => {
      store.assertWritable();
      const doc = store.read('task', id);
      if (doc === null) throw unknownTask(id, where, names);
      if (doc.owner !== by) throw new StateError('not-owner', 'FAIL', `${id} belongs to ${doc.owner}; only its owner writes its ${TASK_TEXTS[name]}`, { hint: 'ask the owner' });
      const cur = store.readText(rel);
      if (cur === text) outcome = 'unchanged';
      else if (cur !== null && !replace(cur)) outcome = 'kept';
      else {
        store.writeText(rel, text);
        outcome = cur === null ? 'created' : 'replaced';
      }
    });
    return { file: join(where.dir, rel), outcome };
  });
}

// `task list`: { repo, dir, active, tasks } (an inactive repository has no tasks).
export function listTasks({ cwd, env, names } = {}) {
  return guarded(() => {
    const where = resolve({ cwd, env, names });
    if (!where.active) return { repo: where.repo, dir: where.dir, active: false, tasks: [] };
    const store = open(where.dir, { names });
    return { repo: where.repo, dir: where.dir, active: true, tasks: store.list('task').map((id) => store.read('task', id)) };
  });
}

// `task show`: the task document.
export function showTask({ cwd, env, names, id } = {}) {
  return guarded(() => {
    KINDS.task.path(id);
    const where = resolve({ cwd, env, names });
    const doc = where.active ? open(where.dir, { names }).read('task', id) : null;
    if (doc === null) throw unknownTask(id, where, names);
    return doc;
  });
}
