export const EXIT_CODES = [
  { code: 0, name: 'OK', meaning: 'success; for `tick`: do the listed steps now (ACTION)' },
  { code: 1, name: 'FAIL', meaning: 'the command ran and the checked condition is false (verify failed, check found problems, claim held, merge conflict)' },
  { code: 2, name: 'USAGE', meaning: 'unknown command or flag, invalid value, limit exceeded' },
  { code: 3, name: 'WAIT', meaning: '`tick`: work in progress; `wait`: run still running; `heavy`: no slot within --wait' },
  { code: 4, name: 'DONE', meaning: '`tick`: loop complete' },
  { code: 5, name: 'STALLED', meaning: '`tick`: no progress within the stall window; `heavy`: no output within --idle' },
  { code: 6, name: 'BUDGET', meaning: '`tick`: a cap was reached; `heavy`: the --timeout was reached' },
  { code: 7, name: 'REFUSED', meaning: 'newer state schema, inactive repository for a write command, missing consent (no terminal and no `--yes`)' },
  { code: 8, name: 'ENV', meaning: 'environment problem: not a git repository, git, claude or a provider CLI missing, network for lanes' },
  { code: 70, name: 'INTERNAL', meaning: 'bug; the message asks for `doctor --json` output in an issue' },
];
export const EXIT = Object.fromEntries(EXIT_CODES.map((e) => [e.name, e.code]));
