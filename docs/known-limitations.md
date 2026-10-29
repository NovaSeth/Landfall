# Known limitations (2.4.0)

## Not in this release
- The adaptive engine runs in shadow mode: `landfall tier` explains the recommended tier; tier changes are not applied automatically.
- No example project; the evaluation covers small tasks only ([evaluation.md](evaluation.md)).
- A task created `--after` others waits until they are done or cancelled; the loop does not merge them for it, and the brief's base is still the orchestrator's to fill.
- Dashboard: rows only, no buttons; no round-by-round view of a task's findings; no agent transcript opened from the pane; no band above the prompt. No `qa` pack or agent.

## Dashboard
- The pane is a Claude Code hooks module (function hooks, Claude Code 2.1.30x or newer); an older Claude Code ignores it and shows no pane and no status line.
- The pane opens unasked only in the fullscreen terminal from 144 columns; from 110 columns `/landfall:dashboard` opens it; narrower, only the status line shows.
- An agent's elapsed time counts from the moment the module first saw it; a reload of the module (a plugin update, a hot reload) starts the counters again and forgets the agents that had ended. The result path is the last `.json` or `.md` path in the agent's prompt or answer.
- The task rows come from `landfall status --json` in the session's working directory: a task in another repository is not shown.

## Edge cases
- Secrets scan: built-in patterns match bounded forms (very long keys, JWT segments over the window size or URL fields over 1 KiB can escape); project patterns run on the first 4 KiB of a line, and a pattern with two adjacent unbounded wildcards is refused (overlapping character classes are checked conservatively even across delimiters); anchors apply to that prefix, so `$` can match its end and patterns requiring more than 4096 characters cannot match; a file over 64 MiB makes the scan incomplete (exit 1), never clean.
- The npm package ships the eval suite (`plugins/landfall/evals/`, with its fixture tests) and the dashboard's own test on purpose: they belong to the plugin. A test runner started inside an installed package's `plugins/` directory would pick them up; run your tests from your project root.
- External executors: `landfall exec --role implementer` is refused in this release (reviewer runs only, read-only sandbox in the task worktree); the implementer role with its own worktree follows.
- Rename detection reads JS and TS sources only; a Python, Go or Rust test that changes its title is still a removal and needs a decision. Titles built at run time, tests declared in loops and template literals with nested braces are not read.
- Profile scan: `llm` is read from dependency manifests by a section-aware reader, not a TOML parser; a malformed pyproject.toml may still yield the fact, and multi-line inline tables or arrays inside inline tables are not read. Override with `landfall profile set llm true|false`.
- `task merge` still needs a clean tree, the state directory included (verify and task done do not): run `landfall commit` before the merge.
- Scheduler admission hooks run in shadow mode: a would-be denial is logged to `local/shadow.jsonl`, agent spawns are not refused yet.
- Run records are command-owned and the supervisor derives sandbox and cwd from the role; a deliberate rewrite of a record between that check and the spawn is not defended (R90).
- Bash guard: `mv <dir> …` and `rsync --delete` are not modelled as removals; a state path hidden in `--pathspec-from-file`, created through a link on the same line, or built only from variables is not detected. With the shell's working directory inside the state directory, every non-read command is blocked. The guard is a seat belt, not a security boundary.
- Bash guard: a push without an explicit `<src>:<dst>` refspec is blocked when an earlier command on the same line may change the branch (for example `npm test && git push origin feat/x`); push in a separate command.
- Bash guard: the CLI run from a checkout by its path (`plugins/landfall/bin/landfall commit`) is a script with a guarded argument unless the session's environment names that launcher in `LANDFALL_LAUNCHERS` (set it in the shell before starting Claude Code); the installed plugin's own launcher and `landfall` on PATH need nothing.
- Loop: an agent that runs `landfall deactivate` and then `landfall init` starts a new loop with default caps.
- State: lock liveness uses the local process id; a reused pid can keep a dead lock looking alive until `landfall state unlock --stale`.
- State: after a crash right after a multi-file write commits, the next write completes it; a decision file saved in an editor during that recovery can be overwritten, and recovery does not check log schema versions written by a newer plugin version.
- Generated files: after a crash in the middle of `landfall gen apply`, a line you removed meanwhile can come back without a side file; deleting a recorded side file accepts its proposal.
- Lanes: lane names that git rejects in ref names (`..`, a trailing `.` or `.lock`) fail at push time with a git error; a far-future `expires` is not capped.
- Receipts: tier, gates, defects before merge and hook-injected characters are not filled yet; `null` means not measured.
- A review-close decision takes effect when a later round reaches the cap and all its blocking IDs are listed, not when it is recorded.
- Verify: the base gates run once more whenever no stored baseline describes the task base; with in-repo state the temporary worktree sits under `.landfall/local/` meanwhile.
- Verify: a hand-edited `verify.json` (for example dropping tests from `inventory.tests`) changes the reference of that task.
- Verify: the integration line is origin's HEAD branch, `origin/main`, `origin/master` or a local `main` or `master`; in a repository with none of them, work merged into the task branch from its integration branch counts as the task's own (the class may rise, never fall).
- Worktrees: `gen apply` from a linked worktree writes into the main checkout; state files edited after verify do not make the worktree dirty for `task done`.
- Lease: after SIGKILL a stale lease lock stays until `landfall slots --unlock-stale`.
- Flags: `landfall flags set guard-bash off --local --yes` turns the guard off on that machine (the intended rollback); a mixed team on older plugin versions does not see `config.json`.
- `landfall doctor` does not check branch protection; there is no degraded mode below the minimum Claude Code version (doctor reports it).
- Terminal output: an unterminated escape sequence in data hides the rest of that text (nothing unsafe is printed).
- Secrets scan: files over 16 MiB in a diff are listed as not scanned (`--staged`, `--range`, the pre-push hook and the CI pull request step); the working tree and artifact modes read them from disk.
- Emoji in decision titles show in text presentation.
