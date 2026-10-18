// PreToolUse ScheduleWakeup|CronCreate → `guard-wakeup` (spec §7.7, §7.13, §8.3, SD-18, ruling R73, GC4, FLW-5; port of
// the 1.5.2 schedule guard). Input read: tool_input.prompt and tool_input.stop. Order:
// 1. tool_input not an object, or prompt not a string → allow (malformed input, GC8); stop: true → allow (always).
// 2. The loop status (lib/hooks/loop-state.mjs; git bounded by the hook's budget): no active repository → allow (R73:
//    the plugin stays out of repositories where it is not used); a repository state or loop document that cannot be
//    read → deny (every loop ends); a terminal exit (DONE, STALLED, BUDGET) → deny a loop prompt, allow any other.
// 3. While no plugin loop runs, a prompt that is not a loop prompt passes (R73: the user's own /loop); while one runs it
//    is denied. A loop prompt must be exact: the fixed prompt (case, quotes, whitespace, a trailing period, hidden
//    characters and Unicode compatibility forms normalized), optionally with `--plan <one regular docs/plans/*.md under
//    the repository root>`; `/<plugin>:<command>` on one line; a Claude Code loop sentinel. A prompt with task state
//    appended goes stale.
// isLoopPrompt is the one classifier of loop prompts (also the stop guard's): the whole prompt normalized first, then
// its first 200 characters tested by prefix, so neither padding in front (findings-r2 B1) nor a copy clipped to 1,000
// characters in session_crons hides one. A deny is the PreToolUse permission decision JSON (≤ 300 characters).
import { realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { forModel } from '../text/clean.mjs';
import { loadNames, loopStatus } from './loop-state.mjs';

const names = loadNames();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bin = esc(names.bin.toLowerCase());
export const FIXED_PROMPT = `Run \`${names.bin} tick\` and do the listed steps.`;
// The prompts Claude Code's /loop schedules itself (2.1.300): autonomous or from loop.md, each also "-dynamic".
export const LOOP_SENTINELS = Object.freeze(['<<autonomous-loop>>', '<<autonomous-loop-dynamic>>', '<<loop.md>>', '<<loop.md-dynamic>>']);
const TICK = new RegExp(`^run ${bin} tick( --plan [^\\s;&|]+)? and do the listed steps$`);
const TICK_PREFIX = new RegExp(`^(run )?${bin} tick(?![a-z0-9-])`);
const OWN_COMMAND = new RegExp(`^/${esc(names.plugin)}:[a-z0-9][a-z0-9:-]*( [^\\n]*)?$`);
const OWN_PREFIX = new RegExp(`^/${esc(names.plugin.toLowerCase())}:`);
const SENTINEL_PREFIX = /^<<(autonomous-loop|loop\.md)/;
const PLAN = /^[^-\s'"$`;|&„”][^\s'"$`;|&„”]*$/;
const REASON_MAX = 300;

// Hidden characters (zero-width, bidi, controls but \n and \t: lib/text/clean.mjs) removed, compatibility forms folded.
const compat = (s) => forModel(s).normalize('NFKC').trim();
const normalize = (s) => compat(s).toLowerCase().replace(/[`'"„”“‘’]/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
// The fixed tick prompt (with or without --plan), exactly.
export const isFixedPrompt = (prompt) => typeof prompt === 'string' && TICK.test(normalize(prompt));
// A loop prompt of any form, by the start of the normalized prompt (clipped after normalizing, never before): the tick
// prompt, /<plugin>:…, a sentinel.
export function isLoopPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const head = normalize(prompt).slice(0, 200);
  return TICK_PREFIX.test(head) || OWN_PREFIX.test(head) || SENTINEL_PREFIX.test(head);
}
const exactLoopPrompt = (prompt) => isFixedPrompt(prompt) || OWN_COMMAND.test(compat(prompt)) || LOOP_SENTINELS.includes(prompt.trim());

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const MSG = {
  ended: (exit) => `FLW-5: blocked the wakeup: the ${names.bin} loop ended (${exit}); after DONE, STALLED or BUDGET nothing is rescheduled. `
    + 'Instead stop the loop (ScheduleWakeup with stop: true) and report the exit.',
  unreadable: (why) => `FLW-5: blocked the wakeup: the loop state cannot be read (${clip(why, 60)}), so the loop may have ended. Instead run `
    + `\`${names.bin} tick\` by hand and follow its exit, or stop the loop (ScheduleWakeup with stop: true).`,
  unknown: (why) => `FLW-5: blocked the wakeup: the repository state cannot be read (${clip(why, 60)}), so the loop may have ended. Instead run `
    + `\`${names.bin} doctor\`, or stop the loop (ScheduleWakeup with stop: true).`,
  contract: 'FLW-5: blocked the wakeup: its prompt must be fixed and carry no task state. '
    + `Instead use "${FIXED_PROMPT}" (optionally --plan docs/plans/<plan>.md), /${names.plugin}:<command>, `
    + `a /loop sentinel (${LOOP_SENTINELS[0]}, ${LOOP_SENTINELS[2]}, also -dynamic) or stop: true.`,
  plan: 'FLW-5: blocked the wakeup: --plan must name one regular docs/plans/*.md file under the repository root as a plain relative path. '
    + `Instead fix the path, or schedule "${FIXED_PROMPT}" without --plan.`,
};

const deny = (reason) => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: clip(reason, REASON_MAX) } })}\n`,
});

// The plan of a tick prompt (the flag in any case) is one regular docs/plans/*.md file under the repository root (the
// worktree's top level: a plan is a file of the checkout, as for `tick --plan`).
function planOk(prompt, root) {
  const m = /--plan\s+(\S+)/i.exec(compat(prompt));
  if (!m) return true;
  let v = m[1];
  if (v.endsWith('`')) v = v.slice(0, -1); // the end of the command in `…`
  if (v.endsWith('.') && compat(prompt).trimEnd().endsWith(m[1])) v = v.slice(0, -1); // the period that ends the sentence
  if (!PLAN.test(v) || !/^docs\/plans\/[^/]+(\/[^/]+)*\.md$/.test(v)) return false;
  try {
    const real = realpathSync(join(root, v));
    return real.startsWith(join(realpathSync(root), 'docs', 'plans') + sep) && statSync(real).isFile();
  } catch { return false; }
}

// Registry handler: (hook input, { env, deadline }) → { stdout }.
export function guardWakeup(input, { env = process.env, deadline = Infinity } = {}) {
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti) || ti.stop === true || typeof ti.prompt !== 'string') return { stdout: '' };
  const st = loopStatus(input, env, deadline);
  if (st.kind === 'inactive') return { stdout: '' };
  if (st.kind === 'unknown') return deny(MSG.unknown(st.why));
  if (st.kind === 'unreadable') return deny(MSG.unreadable(st.why));
  const loop = isLoopPrompt(ti.prompt);
  if (st.kind === 'ended') return loop ? deny(MSG.ended(st.exit)) : { stdout: '' };
  if (!loop) return st.kind === 'running' ? deny(MSG.contract) : { stdout: '' };
  if (!exactLoopPrompt(ti.prompt)) return deny(MSG.contract);
  return planOk(ti.prompt, st.where.worktree) ? { stdout: '' } : deny(MSG.plan);
}
