// Hook registry (spec §7.13, §8.3, SD-44, GC8): the single source of the plugin's hooks: name, event, matcher,
// timeout, handler time budget and handler. scripts/gen-names.mjs renders hooks/hooks.json from hooksConfig()
// (exec form: node <launcher> hook <name>); `<bin> hook <name>` calls runHook(). A hook is a no-op until its unit lands.
// Input that is not a JSON object, an unknown hook name, or no input at all → allow: no output.
// Error policy, one field per hook (onError, brief I3.1 g): when the handler throws, answers after its time budget, or
// the input is over the size cap, 'allow' fails open (GC8); 'block-if-guarded' blocks with exit 2 and an "unverifiable"
// reason when the raw command text holds a guarded token (lib/guard/tokens.mjs) or names a state file or the state
// directory (lib/guard hasToken), and allows otherwise. Malformed input
// is allowed under both. Input over the size cap: 'block-if-guarded' blocks whatever the content ("command too large to
// verify"; a real Bash command never comes near the cap), 'allow' allows; the same for input still incomplete at the
// input deadline ("could not read the whole command in time"). The launcher (bin/) applies the same policy when the code
// cannot load at all.
// Capability (spec §14 rollback, SD-38): a hook with a `capability` passes through while that capability's flag is off
// for the repository of the event's cwd (else CLAUDE_PROJECT_DIR): lib/config with the machine override, config.json and
// the default; `whenOff` is the part that runs anyway (the state-file protection of the edit hook). A flag that cannot
// be read counts as the capability's default (a broken config.json never turns a guard off).
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { modeOf, readConfig, rollout } from '../config/index.mjs';
import { hasToken } from '../guard/index.mjs';
import { MSG } from '../guard/messages.mjs';
import { stateDirName } from '../state/index.mjs';
import { decisionsContext } from './edit-decisions.mjs';
import { editProtect } from './edit-protect.mjs';
import { guardBash } from './guard-bash.mjs';
import { guardWakeup } from './guard-wakeup.mjs';
import { loadNames, stateOf } from './loop-state.mjs';
import { sessionStart } from './session-start.mjs';
import { stopGuard } from './stop-guard.mjs';
import { subagentStart } from './subagent-start.mjs';

export const ON_ERROR = Object.freeze(['allow', 'block-if-guarded']);

export const DEADLINE_MS = 800; // the longest handler time budget, measured from the start of the handler
export const INPUT_DEADLINE_MS = 2000; // stdin must end by then, measured from the start of reading (S3 ruling, fix round 1)
const TIMEOUT_S = 5; // Claude Code kills the hook after this; the internal deadline ends it first
// Handler time budget per hook (budgetMs, default the whole internal deadline), enforced by runHook.
const BUDGET_MS = DEADLINE_MS;
const GUARD_BUDGET_MS = 500; // the guard runs after the input; up to 16 git calls fit, the rest is the deadline's margin

const noop = () => ({ stdout: '' });
// PreToolUse Edit|Write|MultiEdit: state-file protection first (a deny ends it), then the decision context (spec §7.13;
// MultiEdit added in fix round 1: it writes files like Edit).
const editHook = (input, opts) => editProtect(input, opts) ?? decisionsContext(input, opts);

export const HOOKS = [
  { name: 'session-start', event: 'SessionStart', matcher: 'startup|resume|clear|compact', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: sessionStart, onError: 'allow' },
  { name: 'subagent-start', event: 'SubagentStart', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: subagentStart, onError: 'allow' },
  { name: 'guard-bash', event: 'PreToolUse', matcher: 'Bash', timeout: TIMEOUT_S, budgetMs: GUARD_BUDGET_MS, handler: guardBash, onError: 'block-if-guarded', capability: 'guard-bash' },
  { name: 'guard-wakeup', event: 'PreToolUse', matcher: 'ScheduleWakeup|CronCreate', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: guardWakeup, onError: 'allow' },
  { name: 'decisions-context', event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: editHook, onError: 'allow', capability: 'edit-retrieval', whenOff: editProtect },
  { name: 'admit-agent', event: 'PreToolUse', matcher: 'Agent', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: noop, onError: 'allow', capability: 'admission' },
  { name: 'bind-agent', event: 'PostToolUse', matcher: 'Agent', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: noop, onError: 'allow', capability: 'admission' },
  { name: 'release-agent', event: 'SubagentStop', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: noop, onError: 'allow', capability: 'admission' },
  { name: 'stop-guard', event: 'Stop', timeout: TIMEOUT_S, budgetMs: BUDGET_MS, handler: stopGuard, onError: 'allow' },
];

// hooks/hooks.json content; `launcher` is the launcher path as Claude Code expands it.
export function hooksConfig(launcher) {
  const hooks = {};
  for (const h of HOOKS) {
    if (!hooks[h.event]) hooks[h.event] = [];
    hooks[h.event].push({
      ...(h.matcher ? { matcher: h.matcher } : {}),
      hooks: [{ type: 'command', command: 'node', args: [launcher, 'hook', h.name], timeout: h.timeout }],
    });
  }
  return { description: 'Generated from lib/hooks/registry.mjs by scripts/gen-names.mjs; do not edit.', hooks };
}

// Whether the hook's capability is off for the event's repository (false for a hook without one). Read errors and a
// state that cannot be resolved fall to the machine override and the default.
function capabilityOff(hook, input, env, deadline) {
  if (!hook.capability) return false;
  const names = loadNames();
  try {
    const cwd = [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d));
    const where = cwd ? stateOf(cwd, env, deadline).where ?? null : null;
    return modeOf(hook.capability, readConfig(where, { names, env })) === 'off';
  } catch {
    return rollout(hook.capability)?.default === 'off';
  }
}

// The hook event as an object, or null when the input is missing or malformed.
export function parseInput(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// One row run under its error policy. Result { stdout, stderr?, code? }: code 2 is Claude Code's blocking exit code.
// opts: oversize (the input passed the size cap; text is what was read), incomplete (the input deadline came before its
// end: unverifiable, so block-if-guarded blocks and the others allow), deadline (performance.now() ms; default the
// handler budget from now, at most DEADLINE_MS), and handler options (tests, state).
export function runRow(hook, text, { oversize = false, incomplete = false, ...opts } = {}) {
  const guarded = (raw) => { try { return hasToken(raw, stateDirName(loadNames())); } catch { return true; } };
  const fail = (why, raw) => (hook.onError === 'block-if-guarded' && raw && guarded(raw)
    ? { stdout: '', stderr: `${MSG.unverifiable(why)}\n`, code: 2 } : { stdout: '' });
  if (oversize) return hook.onError === 'block-if-guarded' ? { stdout: '', stderr: `${MSG.tooLarge}\n`, code: 2 } : { stdout: '' };
  if (incomplete) return hook.onError === 'block-if-guarded' ? { stdout: '', stderr: `${MSG.incomplete}\n`, code: 2 } : { stdout: '' };
  const input = parseInput(text);
  if (!input) return { stdout: '' };
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const deadline = opts.deadline ?? performance.now() + Math.min(hook.budgetMs, DEADLINE_MS);
  const handler = capabilityOff(hook, input, opts.env ?? process.env, deadline) ? hook.whenOff ?? noop : hook.handler;
  let result;
  try { result = handler(input, { ...opts, deadline }) ?? { stdout: '' }; } catch (e) { return fail(`the hook failed: ${e?.message ?? e}`, command); }
  // late: a deny or block is kept (blocking is the safe side); a late allow goes to the error policy
  const blocks = result.code === 2 || /"permissionDecision":"deny"|"decision":"block"/.test(result.stdout ?? '');
  if (performance.now() > deadline && !blocks) return fail('over its time budget', command);
  return result;
}

export function runHook(name, text, opts = {}) {
  const hook = HOOKS.find((h) => h.name === name);
  return hook ? runRow(hook, text, opts) : { stdout: '' };
}
