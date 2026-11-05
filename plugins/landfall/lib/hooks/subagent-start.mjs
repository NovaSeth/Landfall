// SubagentStart → `subagent-start` (spec §7.13, §8.3): the executor rules for the plugin's own agents (agent_type
// `<plugin>:<agent>`) in an active repository, at most EXECUTOR_MAX characters: the brief file first, rules by ID on
// demand, the report to the file the brief names, no `git stash`, no subagents. Any other agent, an inactive
// repository or malformed input: no output. Nothing is written.
import { isAbsolute } from 'node:path';
import { holderOf, mint } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

export const EXECUTOR_MAX = 800;

export function executorRules(bin) {
  return `${bin} executor rules: read the brief file named in your task first and take its values literally (PRI-3, ORC-2). `
    + `Read method rules by ID when you need them: \`${bin} rule <ID…>\`. Write your report (a reviewer: the review) to the file `
    + 'the brief names and reply in 5 lines (ORC-2). Never use `git stash`: the stash is shared by all worktrees (ORC-13). '
    + `Do not spawn subagents (ORC-2). Task state changes only through \`${bin}\` commands (FLW-7).`;
}

// SEC-13: the one-use review token of a reviewer role (the live orchestrator entry of this session and holder), or why none.
function reviewToken(role, input, dir, names, host = holderOf()) {
  if (role !== 'reviewer' && role !== 'security-reviewer') return '';
  const r = host ? mint({ dir, names, role, session: input.session_id, agent: input.agent_id, host }) : { none: 'unreadable' };
  return r.token ? `\nReview token (SEC-13; never in a file or reply): ${r.token}. printf %s <token> | ${names.bin} review record … --token -`
    : `\nReview token: none (${r.none}); report to the orchestrator, who dispatches again.`;
}

// Registry handler: (hook input, { env, deadline, host }) → { stdout }.
export function subagentStart(input, { env = process.env, deadline = Infinity, host } = {}) {
  const names = loadNames();
  const type = input.agent_type;
  if (typeof type !== 'string' || !type.startsWith(`${names.plugin}:`) || type.length === names.plugin.length + 1) return { stdout: '' };
  const cwd = [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d));
  if (!cwd) return { stdout: '' };
  const where = stateOf(cwd, env, deadline).where;
  if (!where?.active) return { stdout: '' }; // git bounded by the budget
  const text = `${executorRules(names.bin)}${reviewToken(type.slice(names.plugin.length + 1), input, where.dir, names, host)}`.slice(0, EXECUTOR_MAX);
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } })}\n` };
}
