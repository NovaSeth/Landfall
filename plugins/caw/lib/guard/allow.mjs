// Own-command auto-allow (spec SD-33, §11): the Bash guard may answer `permissionDecision: "allow"` only for a single
// simple command whose argv[0] is the plugin's own command (exactly, not a path) and whose subcommand is on this list —
// no shell operator, substitution, redirection, assignment or background job (a strict parse with the tokenizer), and
// only the global flag --json before the subcommand. The capability ships in shadow (SD-38): the hook logs the would-be
// allow and answers nothing.
import { parse } from './tokenizer.mjs';
import { BIN } from './tokens.mjs';

export const OWN_COMMANDS = Object.freeze(['status', 'tick', 'verify', 'exec', 'wait', 'runs', 'rule', 'method', 'receipt', 'doctor',
  'profile show', 'decisions check', 'decisions find', 'slots']);

// The allowlisted subcommand of a command, or null.
export function ownCommand(command) {
  if (typeof command !== 'string' || !command.startsWith(`${BIN} `)) return null;
  let cmds;
  try { cmds = parse(command); } catch { return null; }
  if (cmds.length !== 1) return null;
  const [c] = cmds;
  if (c.pipeIn || c.pipeOut || c.redirs.length || c.heredoc !== null || c.words.some((x) => x.q || x.glob)) return null;
  const w = c.words.map((x) => x.text);
  if (w[0] !== BIN) return null;
  let k = 1; while (w[k] === '--json') k++;
  return OWN_COMMANDS.find((s) => s.split(' ').every((x, j) => w[k + j] === x)) ?? null;
}
