// Admission hooks (spec §7.8 admission points, §14 capability `admission`), the scheduler is called; in shadow mode (the default)
// the hook never blocks, in on mode a full agent table is a PreToolUse deny naming ORC-11 and the `slots` hint. admit-agent (PreToolUse Agent) asks for an agent lease and appends the would-deny record to
// local/shadow.jsonl, and in on mode opens a session's load wait at its deny and closes it at its next admit
// (local/waits.jsonl, lib/loop/waits.mjs; a skipped line never changes the decision); bind-agent (PostToolUse Agent) attaches tool_response.agentId to the lease keyed by tool_use_id;
// release-agent (SubagentStop) frees the lease of agent_id. Malformed input, an inactive repository or a scheduler error:
// allow, no output (GC8). The capability flag (off → pass-through) is applied by the registry.
import { isAbsolute } from 'node:path';
import { modeOf, readConfig, rollout } from '../config/index.mjs';
import { open } from '../state/index.mjs';
import { admitAgent, bindAgent, releaseAgent } from '../sched/index.mjs';
import { closeLoadWait, openLoadWait } from '../loop/waits.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const NONE = { stdout: '' };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCK_MS = 300;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cwdOf = (input, env) => [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d));

export function admitHook(input, { env = process.env, deadline = Infinity } = {}) {
  const names = loadNames();
  const cwd = cwdOf(input, env);
  if (!cwd || !isObj(input.tool_input)) return NONE;
  const where = stateOf(cwd, env, deadline).where;
  if (!where?.active) return NONE;
  let mode;
  try { mode = modeOf('admission', readConfig(where, { names, env })); } catch { mode = rollout('admission').default; }
  if (mode === 'off') return NONE;
  const r = admitAgent({ ...input, cwd }, { names, env, mode, lockTimeoutMs: LOCK_MS });
  if (r.action === 'deny') {
    const reason = `ORC-11: ${r.message}`.slice(0, 600);
    const deny = { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n` };
    // the decision is fixed: the load wait of this session opens after it (plan M1.7, D1, D2)
    try {
      if (typeof input.session_id === 'string') logWait(where, names, deadline, (store) => openLoadWait(store, { key: input.session_id, at: new Date().toISOString() }));
    } catch {
      // any other failure of the waits line: a throw would reach the registry's `allow` error policy and turn this deny
      // into an allow, so it is dropped here; the line is lost, the decision stands (GC8)
    }
    return deny;
  }
  if (r.action === 'allow' && r.shadow) {
    open(where.dir, { names, lockTimeoutMs: LOCK_MS }).append('shadow', r.shadow);
  }
  // an admit in on mode closes this session's open load wait; a shadow would-deny ran its agent, so it waited for nothing
  if (r.action === 'allow' && mode === 'on' && typeof input.session_id === 'string') {
    logWait(where, names, deadline, (store) => closeLoadWait(store, { key: input.session_id, at: new Date().toISOString() }));
  }
  return NONE;
}

// The waits line is skipped when its lock wait cannot end WAIT_MARGIN_MS before the deadline, and on these expected
// refusals (COD-23): locked (another process holds the store lock past the wait), stale-lock (a dead holder's lock),
// store-busy (named by plan M1.7; the lock refusal of state unlock), inactive (deactivated meanwhile), state-invalid (a
// link or a non-regular file in the path), schema-newer (a newer plugin owns the store), write-failed (permissions or a
// full volume), limit-exceeded (an oversized line). The key (session_id) was checked by admitAgent (its ID pattern).
const WAIT_MARGIN_MS = 100;
const WAIT_SKIP = new Set(['locked', 'stale-lock', 'store-busy', 'inactive', 'state-invalid', 'schema-newer', 'write-failed', 'limit-exceeded']);
function logWait(where, names, deadline, write) {
  const lockTimeoutMs = Math.floor(Math.min(LOCK_MS, deadline - performance.now() - WAIT_MARGIN_MS));
  if (!(lockTimeoutMs >= 0)) return;
  try {
    write(open(where.dir, { names, lockTimeoutMs }));
  } catch (err) {
    if (!WAIT_SKIP.has(err?.code)) throw err;
  }
}

export function bindHook(input, { env = process.env } = {}) {
  const names = loadNames();
  const agentId = input.tool_response?.agentId;
  if (!ID.test(String(input.tool_use_id)) || !ID.test(String(agentId)) || input.tool_input?.subagent_type !== `${names.plugin}:implementer`) return NONE;
  bindAgent({ key: input.tool_use_id, agentId }, { names, env, lockTimeoutMs: LOCK_MS });
  return NONE;
}

export function releaseHook(input, { env = process.env } = {}) {
  const names = loadNames();
  if (!ID.test(String(input.agent_id))) return NONE;
  releaseAgent(input.agent_id, { names, env, lockTimeoutMs: LOCK_MS });
  return NONE;
}
