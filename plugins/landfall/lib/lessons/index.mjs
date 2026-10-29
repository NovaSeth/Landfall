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
