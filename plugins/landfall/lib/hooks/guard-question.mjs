// PreToolUse AskUserQuestion → `guard-question` (T-MG-185, SPC-5, PRI-17): while a plugin loop runs, a question for the
// user never stops it (a loop once waited 1.7 h on answers). The question is recorded on its task instead
// (`task set <id> blocked --reason "question: …"`, listed by tick as an open question) and the orchestrator goes on with
// the next independent task. Deny only while a loop runs (lib/hooks/loop-state.mjs); no loop, an ended loop, an
// inactive repository or a state that cannot be read → allow (asking is never a guarded operation; GC8).
import { loadNames, loopStatus } from './loop-state.mjs';

const names = loadNames();
export const QUESTION_DENIED = `SPC-5: blocked AskUserQuestion: a ${names.bin} loop runs, and a question never stops it. Instead record it: `
  + `\`${names.bin} task set <id> blocked --reason "question: <text>"\`, go on with the next independent task and put the question `
  + 'in your report (PRI-17 ones first).';

export function guardQuestion(input, { env = process.env, deadline = Infinity } = {}) {
  if (loopStatus(input, env, deadline).kind !== 'running') return { stdout: '' };
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: QUESTION_DENIED } })}\n` };
}
