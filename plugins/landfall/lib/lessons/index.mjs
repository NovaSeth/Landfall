// Evidence-gated lessons (T-MG-29): admission is code. One pass returns every problem as {field, problem}; the CLI
// handlers (commands.mjs) refuse a lesson with any problem. Lesson text is repository data (SEC-14): it is stored and
// printed, never interpreted.
import { KINDS, PATTERNS } from '../state/index.mjs';
import { RUN_ID } from '../runs/index.mjs';

export const COMPONENTS = KINDS.lesson.spec.f.component.of;
export const VERDICTS = KINDS.lesson.spec.f.verdicts.of.f.verdict.of;
export const STATUSES = KINDS.lesson.spec.f.status.of;
export const LIMITS = Object.freeze({ cue: 200, lesson: 300, evidence: 20 });
const ATTEMPT = /^(T-[A-Z]{2,4}-[1-9]\d{0,5})#([1-9]\d{0,3})$/;

export const readLessons = (store) => store.list('lesson').map((id) => store.read('lesson', id));

// Whether an evidence ID exists in the state: a task or receipt (T-<H>-<n>), a verify attempt (<task>#<n>) or a run record.
export function evidenceExists(store, id) {
  if (PATTERNS.taskId.test(id)) return store.read('task', id) !== null || store.readText(`receipts/${id}.json`) !== null;
  const m = ATTEMPT.exec(id);
  if (m) {
    const task = store.read('task', m[1]);
    return task !== null && task.events.some((e) => e.event === 'verify' && e.data?.attempt === Number(m[2]));
  }
  if (RUN_ID.test(id)) return store.readText(`local/runs/${id}.json`) !== null;
  return false;
}

const oneLine = (v) => typeof v === 'string' && v.trim().length > 0 && !/[\r\n]/.test(v);

// input: { cue, lesson, component, evidence: [id], verdicts: [{change, verdict}] }; exists(id) → boolean.
export function admit(input, exists) {
  const problems = [];
  const add = (field, problem) => problems.push({ field, problem });
  if (!oneLine(input.cue)) add('cue', 'a lesson needs a cue: the situation, on one line');
  else if ([...input.cue].length > LIMITS.cue) add('cue', `the cue is over ${LIMITS.cue} characters`);
  if (!oneLine(input.lesson)) add('lesson', 'a lesson needs its text, on one line');
  else if ([...input.lesson].length > LIMITS.lesson) add('lesson', `the lesson is over ${LIMITS.lesson} characters`);
  if (!COMPONENTS.includes(input.component)) add('component', `a lesson names the component it changes: ${COMPONENTS.join(', ')}`);
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length === 0) add('evidence', 'a lesson needs evidence: a receipt, run, verify attempt or task ID');
  else if (evidence.length > LIMITS.evidence) add('evidence', `at most ${LIMITS.evidence} evidence IDs`);
  else {
    const missing = evidence.filter((id) => !exists(id));
    if (missing.length) add('evidence', `no such evidence in the state: ${missing.join(', ')}`);
  }
  const verdicts = Array.isArray(input.verdicts) ? input.verdicts : [];
  if (verdicts.length > 0 && verdicts.every((v) => v.verdict === 'confounded')) add('verdicts', 'a lesson cannot rest only on confounded verdicts');
  return problems;
}

// ---- retrieval by cue (T-MG-94) ----
export const FIND_MAX = 5;
export const BRIEF_MAX = Object.freeze({ lessons: 3, chars: 300 });
const wordsOf = (text) => new Set(String(text).toLowerCase().match(/\p{L}{3,}/gu) ?? []);

// Active lessons whose cue shares a word (3 or more letters, any case) with `text`, best match first (most shared words,
// then ID order), at most `max`.
export function findLessons(lessons, text, max = FIND_MAX) {
  const query = wordsOf(text);
  return lessons
    .filter((l) => l.status === 'active')
    .map((l) => ({ l, n: [...wordsOf(l.cue)].filter((w) => query.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || (a.l.id < b.l.id ? -1 : a.l.id > b.l.id ? 1 : 0))
    .slice(0, max)
    .map((x) => x.l);
}

// The text after `Lessons: ` in a brief: "L-…: <lesson>" items, at most 3 and 300 characters in all.
export function lessonsLine(matches) {
  const parts = [];
  let used = 0;
  for (const l of matches.slice(0, BRIEF_MAX.lessons)) {
    const item = `${l.id}: ${l.lesson}`;
    const cost = [...item].length + (parts.length ? 3 : 0);
    if (used + cost > BRIEF_MAX.chars) {
      const room = BRIEF_MAX.chars - used - (parts.length ? 3 : 0);
      if (room > 12) parts.push(`${[...item].slice(0, room - 1).join('')}…`);
      break;
    }
    parts.push(item);
    used += cost;
  }
  return parts.join(' | ');
}

// ---- promotion from receipts (T-MG-94) ----
export const PROMOTE_MIN = 20;

// Outcomes: [{ class, firstPass, endedAt }] from receipts; `at` is the lesson's time. A shadow lesson is confirmed when,
// in the class of its evidence, at least PROMOTE_MIN receipts lie on each side of `at` and the 90 % bootstrap intervals of
// the first-pass rate separate in the direction of the verdict (helped: the rate rose; hurt: it fell).
export function confirmLesson(lesson, outcomes, cls, intervalOf) {
  const kinds = new Set(lesson.verdicts.map((v) => v.verdict).filter((v) => v === 'helped' || v === 'hurt'));
  if (kinds.size !== 1) return { ok: false, reason: 'the lesson needs a helped or a hurt verdict, not both and not neither', class: cls };
  const direction = [...kinds][0];
  if (!cls) return { ok: false, reason: 'no class found in the evidence', class: null, direction };
  const at = Date.parse(lesson.at);
  const mine = outcomes.filter((o) => o.class === cls && o.endedAt && Number.isFinite(Date.parse(o.endedAt)));
  const side = (rows) => {
    const passes = rows.map((o) => (o.firstPass ? 1 : 0));
    return { tasks: rows.length, rate: rows.length ? passes.reduce((a, b) => a + b, 0) / rows.length : null, ...(rows.length ? intervalOf(passes, 1) : { lo: null, hi: null }) };
  };
  const before = side(mine.filter((o) => Date.parse(o.endedAt) <= at));
  const after = side(mine.filter((o) => Date.parse(o.endedAt) > at));
  const base = { class: cls, direction, before, after };
  if (before.tasks < PROMOTE_MIN || after.tasks < PROMOTE_MIN) return { ...base, ok: false, reason: `fewer than ${PROMOTE_MIN} receipts` };
  const separated = direction === 'helped' ? after.lo > before.hi : after.hi < before.lo;
  return separated ? { ...base, ok: true, reason: null } : { ...base, ok: false, reason: 'intervals overlap' };
}
