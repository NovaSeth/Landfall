// The external wrapper agent's Bash policy (audit G2, AGT-2, AGT-3, SEC-14), applied by guard-bash (lib/hooks/guard-bash.mjs)
// to a call whose agent_type is `external` or `<plugin>:external`: plugin subagents ignore frontmatter hooks, so the
// plugin-level hook is the place. The agent only starts a provider run and waits for it, so its Bash is limited to one
// simple command of the plugin's own CLI: exec, wait, runs list, runs show, rule or method, with their flags (and the
// global --json before the subcommand). Parsed with the guard's tokenizer: no pipe, `;`, `&&`, `||`, background job,
// substitution, redirection, heredoc, assignment or glob. Anything else is denied with exit 2 and a reason that names the
// agent's job. Input that is not a Bash command is allowed (GC8).
import { parse } from '../guard/tokenizer.mjs';
import { loadNames } from './loop-state.mjs';

const SUBCOMMANDS = Object.freeze(['exec', 'wait', 'runs list', 'runs show', 'rule', 'method']);

// The subcommand of a command that is exactly one simple command of the plugin CLI, or null.
export function externalCommand(command, bin) {
  let cmds;
  try { cmds = parse(command); } catch { return null; }
  if (cmds.length !== 1) return null;
  const [c] = cmds;
  if (c.pipeIn || c.pipeOut || c.after !== null || c.redirs.length || c.heredoc !== null || c.words.some((x) => x.glob || x.at)) return null;
  const w = c.words.map((x) => x.text);
  if (w[0] !== bin) return null;
  let k = 1; while (w[k] === '--json') k++;
  return SUBCOMMANDS.find((s) => s.split(' ').every((x, j) => w[k + j] === x)) ?? null;
}

// Whether the hook input comes from the external agent (agent_type `external` or `<plugin>:external`).
export function isExternalAgent(input, plugin = loadNames().plugin) {
  const t = input?.agent_type;
  return typeof t === 'string' && (t === 'external' || t === `${plugin}:external`);
}

// The policy: (hook input) → { stdout, stderr?, code? }; code 2 denies.
export function externalBash(input) {
  const command = input.tool_input?.command;
  if ((input.tool_name !== undefined && input.tool_name !== 'Bash') || typeof command !== 'string' || command.trim() === '') return { stdout: '' };
  const bin = loadNames().bin;
  if (externalCommand(command, bin)) return { stdout: '' };
  return {
    stdout: '',
    stderr: `AGT-2: blocked: this agent runs one provider call. Instead use one plain command per call: \`${bin} exec --task <id> --role <role> --json\`, \`${bin} wait <run> --timeout 540 --json\`, \`${bin} runs list|show\`, \`${bin} rule <ID>\` or \`${bin} method <topic>\`; no pipe, \`;\`, \`&&\`, substitution or redirection.\n`,
    code: 2,
  };
}
