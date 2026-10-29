// CLI handlers return data/text; cli/output.mjs is the only terminal writer.
import { authorHandle } from '../decisions/write.mjs';
import { EXIT } from '../cli/commands.mjs';
import { KINDS, StateError, allocateId, open, resolve } from '../state/index.mjs';
import { STATUSES, VERDICTS, admit, evidenceExists, readLessons } from './index.mjs';

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
