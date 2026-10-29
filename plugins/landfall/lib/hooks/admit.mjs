// Admission hooks (spec §7.8 admission points, §14 capability `admission`), the scheduler is called; in shadow mode (the default)
// the hook never blocks, in on mode a full agent table is a PreToolUse deny naming ORC-11 and the `slots` hint. admit-agent (PreToolUse Agent) asks for an agent lease and appends the would-deny record to
// local/shadow.jsonl; bind-agent (PostToolUse Agent) attaches tool_response.agentId to the lease keyed by tool_use_id;
// release-agent (SubagentStop) frees the lease of agent_id. Malformed input, an inactive repository or a scheduler error:
// allow, no output (GC8). The capability flag (off → pass-through) is applied by the registry.
import { isAbsolute } from 'node:path';
import { modeOf, readConfig, rollout } from '../config/index.mjs';
import { open } from '../state/index.mjs';
import { admitAgent, bindAgent, releaseAgent } from '../sched/index.mjs';
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
    return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n` };
  }
  if (r.action === 'allow' && r.shadow) {
    open(where.dir, { names, lockTimeoutMs: LOCK_MS }).append('shadow', r.shadow);
  }
  return NONE;
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
