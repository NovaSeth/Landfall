// TaskCompleted → `task-gate` (T-MG-16, D-MG-23, FLW-8; capability task-mirror, opt-in). The native task list mirrors
// Landfall tasks, but the state directory stays the source of truth: a native completion whose subject starts with the
// ID of an active-state task that is not done or cancelled is refused (exit 2; stderr goes back to the model, ≤ 200
// characters). Any other subject, an unknown task, an inactive state or malformed input is allowed. The subject is data:
// only its leading ID is read, and only the ID (matched against the state's pattern) reaches the message.
import { isAbsolute } from 'node:path';
import { PATTERNS, open } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const ID = new RegExp(`^(${PATTERNS.taskId.source.slice(1, -1)})(?![\\w-])`);
const CLOSED = new Set(['done', 'cancelled']);

// Registry handler: (hook input, { env, deadline }) → { stdout, stderr?, code? }.
export function taskGate(input, { env = process.env, deadline = Infinity } = {}) {
  const allow = { stdout: '' };
  const m = typeof input.task_subject === 'string' ? ID.exec(input.task_subject.trimStart()) : null;
  if (!m) return allow;
  const cwd = [env.CLAUDE_PROJECT_DIR, input.cwd].find((d) => typeof d === 'string' && isAbsolute(d));
  if (!cwd) return allow;
  const names = loadNames();
  const where = stateOf(cwd, env, deadline).where;
  if (!where?.active) return allow;
  const doc = open(where.dir, { names }).read('task', m[1]);
  if (!doc || CLOSED.has(doc.status)) return allow;
  const bin = names.bin;
  return { stdout: '', stderr: `${m[1]} is ${doc.status}: run ${bin} verify ${m[1]}, then ${bin} task done ${m[1]}, before completing it (FLW-8).\n`, code: 2 };
}
