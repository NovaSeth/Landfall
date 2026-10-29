# Known limitations (2.5.1)

## Not in this release
- The adaptive engine runs in shadow mode. `landfall tier` explains the recommended tier. Nothing applies tier changes automatically.
- The evaluation covers small tasks only ([evaluation.md](evaluation.md)). The outcome benchmark against other frameworks is pre-registered ([benchmark.md](benchmark.md)) but not run yet.
- Context headroom warnings run in shadow. They are logged, not shown, until a decision turns them on. The native task mirror is off by default (`landfall flags set task-mirror on`).
- Lessons become active only through `landfall lessons promote`, which needs 20 or more receipts on each side. Matching lessons appear in briefs only, never at edit time.
- A task created `--after` others waits until they are done or cancelled. The loop does not merge them. The orchestrator fills in the brief's base.
- Dashboard: rows only, no buttons. No round-by-round view of a task's findings, no agent transcript from the pane, no band above the prompt.
- No `qa` pack or agent.

## Dashboard
- The pane is a Claude Code hooks module (function hooks, Claude Code 2.1.30x or newer). An older Claude Code shows no pane and no status line.
- The pane opens unasked only in the fullscreen terminal from 144 columns. From 110 columns, `/landfall:dashboard` opens it. In a narrower terminal only the status line shows.
- An agent's elapsed time counts from the moment the module first saw it. A module reload (a plugin update, a hot reload) restarts the counters and forgets ended agents.
- The result path is the last `.json` or `.md` path in the agent's prompt or answer.
- The task rows come from `landfall status --json` in the session's working directory. A task in another repository is not shown.

## Edge cases
- Secrets scan:
  - Built-in patterns match bounded forms. Very long keys, JWT segments over the window size and URL fields over 1 KiB can escape.
  - Project patterns run on the first 4 KiB of a line. Anchors apply to that prefix, so `$` can match its end, and patterns that require more than 4096 characters cannot match.
  - A pattern with two adjacent unbounded wildcards is refused. Overlapping character classes are checked conservatively, even across delimiters.
  - A file over 64 MiB makes the scan incomplete (exit 1) and never clean.
  - Files over 16 MiB in a diff are listed as not scanned (`--staged`, `--range`, the pre-push hook and the CI pull request step). The working tree and artifact modes read them from disk.
- The npm package ships the eval suite (`plugins/landfall/evals/`, with its fixture tests) and the dashboard's own test. A test runner started inside an installed package's `plugins/` directory would pick them up, so run your tests from your project root.
- External executors: an implementer run writes only inside the task's worktree, under the provider's own write sandbox (Codex workspace-write, Gemini auto_edit, a declared provider's implementer mapping). Git metadata lies outside the worktree, so the provider cannot commit, and the orchestrator commits from its tree. A provider started by hand, outside `landfall exec`, has no run record and is not shown in the dashboard (ORC-26).
- Rename detection reads JS and TS sources only. A Python, Go or Rust test that changes its title still counts as a removal and needs a decision. Titles built at run time, tests declared in loops and template literals with nested braces are not read.
- Profile scan: a section-aware reader takes `llm` from dependency manifests. It is a reader and not a TOML parser, so a malformed pyproject.toml may still yield the fact. Multi-line inline tables and arrays inside inline tables are not read. Override the result with `landfall profile set llm true|false`.
- Scheduler admission works in on mode: a full agent table denies a spawn and names `landfall slots`. The default stays shadow until the 50-spawn false-deny check. Shadow logs a would-be denial to `local/shadow.jsonl` and refuses nothing.
- Run records are command-owned, and the supervisor derives sandbox and cwd from the role. A deliberate rewrite of a record between that check and the spawn is not defended against (R90).
- External runs:
  - Gemini as an implementer (`auto_edit`) is tested with a fake provider only.
  - An implementer run does not check that the worktree is on the task's branch or clean.
  - Run temp directories are not removed.
  - A provider binary replaced at the same path between the check and the spawn is not detected.
- Leases and run records gained optional fields (`bin`, `outDirId`, `briefSha256`, `members`) without a schema bump (D-MG-24). With two plugin versions on one machine while runs are live, the older one drops such records and can admit one run too many.
- GitHub mirror: the issue label and marker derive from the plugin's name. After a rename, the mirror creates new issues and leaves the old ones as they are.
- Bash guard: a seat belt, no security boundary.
  - `mv <dir> …` and `rsync --delete` are not modelled as removals. Not detected: a state path hidden in `--pathspec-from-file`, created through a link on the same line, or built only from variables. With the shell's working directory inside the state directory, every non-read command is blocked.
  - A push without an explicit `<src>:<dst>` refspec is blocked when an earlier command on the same line may change the branch (for example `npm test && git push origin feat/x`). Push in a separate command.
  - The CLI run from a checkout by its path (`plugins/landfall/bin/landfall commit`) is a script with a guarded argument, unless the session's environment names that launcher in `LANDFALL_LAUNCHERS`. Set it in the shell before starting Claude Code. The installed plugin's launcher and `landfall` on PATH need nothing.
    - A checkout launcher is not trusted by its location or by a `name.json` in its plugin root. An agent can write both files, so only the operator's `LANDFALL_LAUNCHERS` makes it the own command (T-MG-95).
- Loop: an agent that runs `landfall deactivate` and then `landfall init` starts a new loop with default caps.
- State: every reader ignores a `local/` shipped in a repository. That means one with an unchanged file tracked by git, one marked by another machine, or one whose marker is not a regular file. The next command's state write moves it aside to the gitignored `local.foreign-<time>/`.
  - A `local/` whose owner git cannot tell (an error or a timeout) is ignored too, and commands refuse to write instead of moving it.
  - Hooks never move a `local/` and skip their writes there.
  - The machine id comes from the host name, the user id and the home directory, so it is guessable. A tracked `local/` counts as foreign whatever its marker says.
  - Moved-aside copies stay until deleted by hand (`landfall doctor` counts them).
- Trust: a repository's gate commands run (verify, baseline pin, task merge) and its threshold overrides count (route) only after this machine set or trusted them. Use `landfall trust` in a terminal; `--yes` is refused.
  - Trust lives in `trust.json` in the plugin data directory, per repository and config directory.
  - An existing repository is trusted once, as it is, and only on evidence this machine holds: its state directory linked in `projects.json` (`init --state-dir`).
  - A write trusts a changed set only when the set it replaces was empty or trusted.
  - An override counts only when its decision is a route-override or is scoped to `config.json`.
- State: lock liveness uses the local process id. A reused pid can keep a dead lock looking alive until `landfall state unlock --stale`.
- State: after a crash right after a multi-file write commits, the next write completes it. A decision file saved in an editor during that recovery can be overwritten, and recovery does not check log schema versions written by a newer plugin version.
- Generated files: after a crash in the middle of `landfall gen apply`, a line you removed meanwhile can come back without a side file. Deleting a recorded side file accepts its proposal.
- Lanes: lane names that git rejects in ref names (`..`, a trailing `.` or `.lock`) fail at push time with a git error. A far-future `expires` is not capped.
- Receipts: tier, gates, defects before merge and hook-injected characters are not filled yet. `null` means not measured.
- A review-close decision takes effect when a later round reaches the cap and lists all its blocking IDs, not when it is recorded.
- Verify: the base gates run once more whenever no stored baseline describes the task base. With in-repo state, the temporary worktree sits under `.landfall/local/` meanwhile.
- Verify: a hand-edited `verify.json` (for example dropping tests from `inventory.tests`) changes the reference of that task.
- Verify: the integration line is origin's HEAD branch, `origin/main`, `origin/master` or a local `main` or `master`. In a repository with none of them, work merged into the task branch from its integration branch counts as the task's own. The class may rise, never fall.
- Git: `task merge --batch` uses `--end-of-options`, which needs git 2.24 or later. `landfall doctor` warns on an older git.
- Worktrees: `gen apply` from a linked worktree writes into the main checkout. State files edited after verify do not make the worktree dirty for `task done` or `task merge`; both check the code tree only. `landfall commit` commits the pending state writes after the merge.
- Lease: after SIGKILL a stale lease lock stays until `landfall slots --unlock-stale`.
- Flags: `landfall flags set guard-bash off --local --yes` turns the guard off on that machine, which is the intended rollback. A mixed team on older plugin versions does not see `config.json`.
- `landfall doctor` does not check branch protection. There is no degraded mode below the minimum Claude Code version, and doctor reports it.
- Terminal output: an unterminated escape sequence in data hides the rest of that text. Nothing unsafe is printed.
- Emoji in decision titles show in text presentation.
