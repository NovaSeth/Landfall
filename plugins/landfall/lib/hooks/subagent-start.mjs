// SubagentStart → `subagent-start` (spec §7.13, §8.3): the executor rules for the plugin's own agents (agent_type
// `<plugin>:<agent>`) in an active repository, at most EXECUTOR_MAX characters: the brief file first, rules by ID on
// demand, the report to the file the brief names, no `git stash`, no subagents. Any other agent, an inactive
// repository or malformed input: no output. Nothing is written.
import { isAbsolute } from 'node:path';
import { loadNames, stateOf } from './loop-state.mjs';

export const EXECUTOR_MAX = 800;

export function executorRules(bin) {
  return `${bin} executor rules: read the brief file named in your task first and take its values literally (PRI-3, ORC-2). `
    + `Read method rules by ID when you need them: \`${bin} rule <ID…>\`. Write your report (a reviewer: the review) to the file `
    + 'the brief names and reply in 5 lines (ORC-2). Never use `git stash`: the stash is shared by all worktrees (ORC-13). '
    + `Do not spawn subagents (ORC-2). Task state changes only through \`${bin}\` commands (FLW-7).`;
}

// Registry handler: (hook input, { env }) → { stdout }.
export function subagentStart(input, { env = process.env, deadline = Infinity } = {}) {
  const names = loadNames();
  const type = input.agent_type;
  if (typeof type !== 'string' || !type.startsWith(`${names.plugin}:`) || type.length === names.plugin.length + 1) return { stdout: '' };
  const cwd = [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d));
  if (!cwd) return { stdout: '' };
  if (!stateOf(cwd, env, deadline).where?.active) return { stdout: '' }; // git bounded by the budget
  const text = executorRules(names.bin).slice(0, EXECUTOR_MAX);
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } })}\n` };
}
