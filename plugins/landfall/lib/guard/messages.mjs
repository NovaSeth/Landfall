// Guard messages (spec §8.3): a permissionDecisionReason starts with the rule ID, says what was blocked, why, and what to
// do instead, in at most 300 characters. Rule IDs are v2 method IDs (method/index.json; the 1.x IDs map through
// method/legacy-ids.json: PUL-14 → ORC-13, BZP-16 → SEC-6, PUL-3 → TRP-2, PUL-17/ZAS-2 → PRI-1, PUL-48 → TRP-6,
// ZAS-20 → PRI-17, BZP-46 → SEC-4, BZP-51 → SEC-3).
export const REASON_MAX = 300;
export const short = (t, n = 50) => (t.length > n ? `${t.slice(0, n)}…` : t);
// Fits a variable detail into the limit by shortening the detail, never the rule ID or the advice.
const fit = (make, detail) => {
  const room = REASON_MAX - make('').length;
  return make(room <= 1 ? '' : short(detail, room - 1));
};

export const MSG = {
  stash: 'ORC-13: blocked `git stash`: the stash is shared by all worktrees. Instead commit work in progress (`git commit -m wip`); '
    + '`git stash list` and `git stash show` stay allowed.',
  hooks: 'SEC-4: blocked skipping git hooks (`--no-verify`, `commit -n`, `core.hooksPath`, `include.path`): the pre-push hook is the '
    + 'secrets gate. Instead run the command with its hooks; if a hook must be skipped, ask the human.',
  main: 'PRI-1: blocked a push to `main`: code reaches main only through a task branch and a pull request (COL-23). Instead `git switch -c '
    + '<branch>`, then `git push -u origin HEAD` and a pull request. A push without a refspec after cd or switch in the line counts as main.',
  force: 'TRP-6: blocked a force push to `main`: it rewrites shared history and needs a human decision (PRI-17). Instead revert through a '
    + 'pull request. After cd or switch in the line a push without a refspec counts as main: name an explicit refspec.',
  pipe: (gate, cmd) => fit((c) => `${gate.rule}: blocked a pipe after the gate command \`${c}\` (${gate.id}): the line would report the exit `
    + 'code of the last command. Instead run it without a pipe and check `$?`, or redirect it: `… > out.txt 2>&1; echo $?`.', cmd),
  execKey: (key) => fit((k) => `SEC-3: blocked setting \`${k}\`: git runs the value of this config key as a command or redirects through it, `
    + 'so a session never sets it, whatever the value. Instead ask the human to set it.', key),
  hookFiles: 'SEC-4: blocked writing, moving, removing or un-executing a git hook file or directory: the pre-push hook is the '
    + 'secrets gate. Instead leave the hook files as they are; if a hook must change, ask the human.',
  shape: (why) => fit((w) => `SEC-3: blocked a guarded operation with no recognized simple form (${w}). Instead write plain words, bare or `
    + 'quoted, without $, backticks, ( ), { }, aliases, eval, variables or a pipe to a shell.', why),
  timeout: 'SEC-3: blocked: cannot verify the command in time. Instead use a simpler, shorter form.',
  tooLarge: 'SEC-3: blocked: command too large to verify (SEC-3): the input is over the 16 MiB the guard reads. Instead split the work '
    + 'into smaller commands.',
  incomplete: 'SEC-3: blocked: could not read the whole command in time (the hook input arrived too slowly), so it is unverifiable. '
    + 'Instead retry the command.',
  unverifiable: (why) => fit((w) => `SEC-3: blocked: unverifiable (${w}): the guard could not check this command. Instead use a simpler, `
    + 'shorter form; if this repeats, repair the plugin installation.', why),
  // spec §7.13: the state directory (owned: an entry of lib/guard/protect.mjs OWNED, or null for another state path)
  stateFile: (path, owned, bin) => {
    if (owned?.edit) {
      return fit((p) => `${owned.rule}: blocked writing the project rules \`${p}\` from Bash: they switch guard rules on and off. Instead use `
        + `${owned.use()}.`, path);
    }
    if (!owned) {
      return fit((p) => `FLW-7: blocked a command on \`${p}\` in the state directory that is not a plain read (cat, head, grep, jq, ls, diff): only `
        + `\`${bin}\` commands write there. Instead change state with \`${bin}\` commands.`, path);
    }
    const use = owned.use(bin, short(owned.id ?? '<id>', 24));
    if (owned.field === 'status') {
      return fit((p) => `PRI-8: blocked a command on the decision record \`${p}\` that is not a plain read: its status changes only through `
        + `commands. Instead use ${use}; edit its body with the Edit tool.`, path);
    }
    return fit((p) => `FLW-7: blocked a command on \`${p}\` that is not a plain read: only \`${bin}\` commands write this state file. `
      + `Instead use ${use}; cat, grep or jq may read it.`, path);
  },
  stateGit: (sub, path, bin) => fit((p) => `FLW-7: blocked \`git ${short(sub, 20)}\` on \`${p}\`: it would rewrite the state directory, which only `
    + `\`${bin}\` commands write. Instead name paths outside it, or change state with \`${bin}\` commands.`, path),
  stateUnknown: (why, bin) => fit((w) => `FLW-7: blocked: the state of this repository cannot be resolved (${w}), and the command names its state `
    + `directory or a state file. Instead repair it (\`${bin} doctor\`), or run the command without the state path.`, why),
  removeTracked: (target, what) => fit((t) => `PRI-17: blocked removing \`${t}\` recursively: it is ${what}, and work in it that is not committed `
    + 'would be lost. Instead remove the files you mean inside it, or ask the human first.', target),
  rule: (line, msg) => fit((m) => `SEC-4: blocked by a project rule (guard-extra.txt:${line}): ${m} Instead follow the project rule or ask `
    + 'the human.', msg),
  ruleTimeout: (line, msg) => fit((m) => `SEC-4: blocked by a project rule (guard-extra.txt:${line}): ${m} Its pattern exceeded the match `
    + 'time limit. Instead simplify the pattern.', msg),
};
