// Stop → `stop-guard` (spec §7.7, §7.13, §8.3, SD-18, SC6, U1 fallback): a self-paced loop that ended can still have
// a wakeup scheduled (the fallback wakeup of a self-paced loop is no tool call the wakeup guard sees). When
// `session_crons` holds a loop prompt (isLoopPrompt, the wakeup guard's classifier: prefix-based, so a copy clipped at
// 1,000 characters still counts) and the loop has a terminal exit, or the loop or repository state cannot be read
// (GC4: it may have ended), the turn end is blocked once with the instruction to cancel; with `stop_hook_active`
// (Claude Code continued after that block) the turn ends. The reason is at most 300 characters. Malformed input, no
// loop prompt pending, an inactive repository, no loop or a running loop → no output (allow).
import { forModel } from '../text/clean.mjs';
import { isLoopPrompt } from './guard-wakeup.mjs';
import { loadNames, loopStatus } from './loop-state.mjs';

export { TERMINAL, loopExit, readLoop } from './loop-state.mjs';

const NONE = { stdout: '' };
const REASON_MAX = 300;
const ENDED = new Set(['ended', 'unreadable', 'unknown']);
const cleanId = (id) => forModel(String(id)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || '?';
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// The reason: the rule, why the loop counts as ended, the wakeups to cancel by id; clipped as a whole.
function reason(st, pending, bin) {
  const ids = pending.slice(0, 4).map((c) => cleanId(c.id));
  const more = pending.length > ids.length ? ` and ${pending.length - ids.length} more` : '';
  const why = st.kind === 'ended' ? `the ${bin} loop ended (${st.exit})`
    : `the ${st.kind === 'unknown' ? 'repository' : 'loop'} state cannot be read (${clip(String(st.why), 40)}), so the loop may have ended`;
  return clip(`FLW-5: blocked ending the turn: ${why}, but a loop wakeup is still scheduled (${ids.join(', ')}${more}). `
    + `Instead call ScheduleWakeup with stop: true, or CronDelete <id> for each (CronDelete ${ids[0]}), then end the turn.`, REASON_MAX);
}

// Registry handler: (hook input, { env, deadline }) → { stdout }.
export function stopGuard(input, { env = process.env, deadline = Infinity } = {}) {
  if (input.stop_hook_active === true || !Array.isArray(input.session_crons)) return NONE;
  const pending = input.session_crons.filter((c) => c && typeof c === 'object' && isLoopPrompt(c.prompt));
  if (pending.length === 0) return NONE;
  const st = loopStatus(input, env, deadline);
  if (!ENDED.has(st.kind)) return NONE;
  return { stdout: `${JSON.stringify({ decision: 'block', reason: reason(st, pending, loadNames().bin) })}\n` };
}
