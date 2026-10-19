# Known limitations (2.0.0)

## Not in this release
- The adaptive engine runs in shadow mode: `landfall tier` explains the recommended tier; tier changes are not applied automatically.
- No published evaluation numbers yet; no example project.

## Edge cases
- External executors: `landfall exec --role implementer` is refused in this release (reviewer runs only, read-only sandbox in the task worktree); the implementer role with its own worktree follows.
- Scheduler admission hooks run in shadow mode: a would-be denial is logged to `local/shadow.jsonl`, agent spawns are not refused yet.
- Run records are command-owned and the supervisor derives sandbox and cwd from the role; a deliberate rewrite of a record between that check and the spawn is not defended (R90).
- Bash guard: `mv <dir> …` and `rsync --delete` are not modelled as removals; a state path hidden in `--pathspec-from-file`, created through a link on the same line, or built only from variables is not detected. With the shell's working directory inside the state directory, every non-read command is blocked. The guard is a seat belt, not a security boundary.
- Bash guard: a push without an explicit `<src>:<dst>` refspec is blocked when an earlier command on the same line may change the branch (for example `npm test && git push origin feat/x`); push in a separate command.
- Loop: an agent that runs `landfall deactivate` and then `landfall init` starts a new loop with default caps.
- State: lock liveness uses the local process id; a reused pid can keep a dead lock looking alive until `landfall state unlock --stale`.
- State: after a crash right after a multi-file write commits, the next write completes it; a decision file saved in an editor during that recovery can be overwritten, and recovery does not check log schema versions written by a newer plugin version.
- Generated files: after a crash in the middle of `landfall gen apply`, a line you removed meanwhile can come back without a side file; deleting a recorded side file accepts its proposal.
- Lanes: lane names that git rejects in ref names (`..`, a trailing `.` or `.lock`) fail at push time with a git error; a far-future `expires` is not capped.
- Receipts: tier, gates, defects before merge and hook-injected characters are not filled yet; `null` means not measured.
- A review-close decision takes effect when a later round reaches the cap and all its blocking IDs are listed, not when it is recorded.
- Verify: the base gates run once more whenever no stored baseline describes the task base; with in-repo state the temporary worktree sits under `.landfall/local/` meanwhile.
- Verify: a hand-edited `verify.json` (for example dropping tests from `inventory.tests`) changes the reference of that task.
- Worktrees: `gen apply` from a linked worktree writes into the main checkout; state files edited after verify do not make the worktree dirty for `task done`.
- Lease: after SIGKILL a stale lease lock stays until `landfall slots --unlock-stale`.
- Flags: `landfall flags set guard-bash off --local --yes` turns the guard off on that machine (the intended rollback); a mixed team on older plugin versions does not see `config.json`.
- `landfall doctor` does not check branch protection; there is no degraded mode below the minimum Claude Code version (doctor reports it).
- Terminal output: an unterminated escape sequence in data hides the rest of that text (nothing unsafe is printed).
- Secrets scan: files over 16 MiB in a diff are listed as not scanned (`--staged`, `--range`, the pre-push hook and the CI pull request step); the working tree and artifact modes read them from disk.
- Emoji in decision titles show in text presentation.
