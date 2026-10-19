# Known limitations (2.0.0-beta.1)

## Not in this beta yet
- External executors (Codex, Gemini) as rows in the Claude Code agent panel, and the `caw exec / wait / runs / providers` commands. You can still run another provider yourself.
- The scheduler's admission check is not wired into the hooks: `caw heavy` and `caw slots` work from the CLI; agent spawns are not gated.
- Threshold overrides (`caw config set thresholds.…`) are recorded and shown by `caw config show`; the router and the engine still read their shipped thresholds (T-MG-40).
- Skills mostly point to `caw rule` and `caw doctor`; they do not yet walk the whole activation → task → verify → merge flow step by step.
- The adaptive engine runs in shadow mode: `caw tier` explains the recommended tier; tier changes are not applied automatically.
- No published evaluation numbers yet; no example project.

## Edge cases
- Bash guard: `mv <dir> …` and `rsync --delete` are not modelled as removals; a state path hidden in `--pathspec-from-file`, created through a link on the same line, or built only from variables is not detected. With the shell's working directory inside the state directory, every non-read command is blocked. The guard is a seat belt, not a security boundary.
- Bash guard: a push without an explicit `<src>:<dst>` refspec is blocked when an earlier command on the same line may change the branch (for example `npm test && git push origin feat/x`); push in a separate command.
- Loop: an agent that runs `caw deactivate` and then `caw init` starts a new loop with default caps.
- State: lock liveness uses the local process id; a reused pid can keep a dead lock looking alive until `caw state unlock --stale`.
- State: after a crash right after a multi-file write commits, the next write completes it; a decision file saved in an editor during that recovery can be overwritten, and recovery does not check log schema versions written by a newer plugin version.
- Generated files: after a crash in the middle of `caw gen apply`, a line you removed meanwhile can come back without a side file; deleting a recorded side file accepts its proposal.
- Lanes: lane names that git rejects in ref names (`..`, a trailing `.` or `.lock`) fail at push time with a git error; a far-future `expires` is not capped.
- Receipts: tier, gates, defects before merge and hook-injected characters are not filled yet; `null` means not measured.
- Review: without provider detection (`caw providers` does not exist), a critical L1 review is accepted from a Claude review.
- A review-close decision takes effect when a later round reaches the cap and all its blocking IDs are listed, not when it is recorded.
- Verify: the base gates run once more whenever no stored baseline describes the task base; with in-repo state the temporary worktree sits under `.caw/local/` meanwhile.
- Verify: a hand-edited `verify.json` (for example dropping tests from `inventory.tests`) changes the reference of that task.
- Worktrees: `gen apply` from a linked worktree writes into the main checkout; state files edited after verify do not make the worktree dirty for `task done`.
- Lease: after SIGKILL a stale lease lock stays until `caw slots --unlock-stale`.
- Flags: `caw flags set guard-bash off --local --yes` turns the guard off on that machine (the intended rollback); a mixed team on older plugin versions does not see `config.json`.
- `caw doctor` does not check branch protection; there is no degraded mode below the minimum Claude Code version (doctor reports it).
- Terminal output: an unterminated escape sequence in data hides the rest of that text (nothing unsafe is printed).
- Secrets scan: files over 16 MiB in a diff are listed as not scanned (`--staged`, `--range`, the pre-push hook and the CI pull request step); the working tree and artifact modes read them from disk.
- Emoji in decision titles show in text presentation.
