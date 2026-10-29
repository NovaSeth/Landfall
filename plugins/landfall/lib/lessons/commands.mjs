// CLI handlers return data/text; cli/output.mjs is the only terminal writer.
import { authorHandle } from '../decisions/write.mjs';
import { EXIT } from '../cli/commands.mjs';
import { KINDS, StateError, allocateId, open, resolve } from '../state/index.mjs';
import { intervalOf } from '../receipts/executors.mjs';
import { outcomeRecords } from '../receipts/index.mjs';
import { STATUSES, VERDICTS, admit, confirmLesson, evidenceExists, findLessons, readLessons } from './index.mjs';

const usage = (message) => new StateError('invalid-value', 'USAGE', message);
const idsOf = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function context({ io, names }, write = false) {
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  if (write && !where.active) throw new StateError('inactive', 'REFUSED', 'lessons can be changed only in an active repository', { hint: `${names.bin} init` });
  return { where, store: open(where.dir, { names }) };
}
const line = (l) => `${l.id}  ${l.status}  ${l.component}  ${l.cue}  ->  ${l.lesson}`;
function verdictsOf(flag) {
  return [flag ?? []].flat().map((pair) => {
    const at = String(pair).lastIndexOf('=');
    const verdict = pair.slice(at + 1);
    if (at < 1 || !VERDICTS.includes(verdict)) throw usage(`--verdict must be <change>=<${VERDICTS.join('|')}>`);
    return { change: pair.slice(0, at), verdict };
  });
}
function select(store, id) {
  KINDS.lesson.path(id);
  const doc = store.read('lesson', id);
  if (doc === null) throw usage(`no lesson ${id}`);
  return doc;
}

export function add(ctx) {
  const { flags, names, io } = ctx;
  const { where, store } = context(ctx, true);
  const input = { cue: flags.cue, lesson: flags.lesson, component: flags.component, evidence: idsOf(flags.evidence), verdicts: verdictsOf(flags.verdict) };
  const refuse = (problems) => ({
    code: EXIT.USAGE, data: { problems },
    errors: [{ code: 'lesson-refused', message: `lesson refused: ${problems.map((p) => `${p.field}: ${p.problem}`).join('; ')}`, hint: `${names.bin} lessons add --help` }],
  });
  const early = admit(input, (id) => evidenceExists(store, id));
  if (early.length) return refuse(early);
  const handle = authorHandle({ store, where, names, env: io.env });
  const at = new Date().toISOString();
  const id = allocateId(store, { prefix: 'L', handle, build: (n) => ({ id: n, ...input, status: 'shadow', at, by: handle }) });
  const lesson = store.read('lesson', id);
  return { data: { lesson }, text: `${id}  shadow\n` };
}

export function list(ctx) {
  const { flags } = ctx;
  if (flags.status !== undefined && !STATUSES.includes(flags.status)) throw usage(`--status must be ${STATUSES.join('|')}`);
  const { where, store } = context(ctx);
  const lessons = (where.active ? readLessons(store) : []).filter((l) => flags.status === undefined ? l.status !== 'retired' : l.status === flags.status);
  return { data: { lessons }, text: lessons.length ? `${lessons.map(line).join('\n')}\n` : 'no lessons\n' };
}

export function show(ctx) {
  const { store } = context(ctx);
  const lesson = select(store, ctx.args.id);
  return { data: { lesson }, text: `${JSON.stringify(lesson, null, 2)}\n` };
}

export function retire(ctx) {
  const { flags } = ctx;
  const why = flags.why?.trim();
  if (!why || [...why].length > 300) throw usage('--why needs a reason of 1 to 300 characters');
  const { store } = context(ctx, true);
  store.batch((s) => {
    const cur = select(s, ctx.args.id);
    if (cur.status === 'retired') throw usage(`${cur.id} is already retired`);
    return s.write('lesson', cur.id, { ...cur, status: 'retired', retiredWhy: why });
  });
  return { data: { lesson: store.read('lesson', ctx.args.id) }, text: `${ctx.args.id}  retired\n` };
}

export function find(ctx) {
  const { where, store } = context(ctx);
  const query = (ctx.args.words ?? []).join(' ');
  const lessons = where.active ? findLessons(readLessons(store), query) : [];
  return { data: { lessons }, text: lessons.length ? `${lessons.map(line).join('\n')}\n` : 'no matching lessons\n' };
}

const rate = (x) => (x === null ? 'n/a' : x.toFixed(2));
const sideText = (name, s) => `${name} ${s.tasks} tasks, first pass ${rate(s.rate)} (90% ${rate(s.lo)}-${rate(s.hi)})`;

export function promote(ctx) {
  const { names, io } = ctx;
  const { store } = context(ctx, true);
  const lesson = select(store, ctx.args.id);
  if (lesson.status !== 'shadow') throw usage(`${lesson.id} is ${lesson.status}: only a shadow lesson is promoted`);
  const classes = lesson.evidence.map((e) => store.read('task', e.split('#')[0])?.class).filter(Boolean);
  const result = confirmLesson(lesson, outcomeRecords({ cwd: io.cwd, env: io.env, names }), classes[0] ?? null, intervalOf);
  const evidence = { class: result.class, direction: result.direction ?? null, before: result.before ?? null, after: result.after ?? null };
  if (!result.ok) {
    const numbers = result.before ? `; class ${result.class}: ${sideText('before', result.before)}; ${sideText('after', result.after)}` : '';
    return {
      code: EXIT.REFUSED, data: { lesson, evidence, reason: result.reason },
      errors: [{ code: 'lesson-unconfirmed', message: `${lesson.id} stays in shadow: ${result.reason}${numbers}`, hint: 'a lesson is promoted only when later receipts confirm it; no lesson is forced' }],
    };
  }
  store.batch((s) => {
    const cur = select(s, lesson.id);
    if (cur.status !== 'shadow') throw usage(`${cur.id} is ${cur.status}: only a shadow lesson is promoted`);
    return s.write('lesson', cur.id, { ...cur, status: 'active' });
  });
  return { data: { lesson: store.read('lesson', lesson.id), evidence }, text: `${lesson.id}  active  (${sideText('before', result.before)}; ${sideText('after', result.after)})\n` };
}
