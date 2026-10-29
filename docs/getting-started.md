# Getting started

Landfall is a Claude Code plugin. You talk to Claude Code as usual; the plugin sizes the work and checks the outcome.

## 1. Install

```
claude plugin install landfall --marketplace NovaSeth/Landfall
```

Type `/reload-plugins`. If the install fails, run `claude plugin marketplace add NovaSeth/Landfall`, then `claude plugin install landfall@landfall-plugins`. Check the setup with `landfall doctor`; every row that is not OK has a fix hint.

## 2. Ask for a change

Open Claude Code in a git repository and describe the change. A trivial change runs as plain Claude Code and writes no files. For larger work the agent says it will track the repository and runs `landfall init`; the state goes in `.landfall/`. Say "no landfall here" to opt out; the choice is remembered outside the repository. To activate tracking yourself, type `/landfall:start`; `/landfall:status` shows the state and `/landfall:doctor` checks the setup.

## 3. What happens next

1. `landfall profile observe` scans the repository (stack, test command, CI); the agent asks at most three questions and records the answers with `landfall profile set`.
2. `landfall task new "<title>"` creates a task such as `T-AB-1`; `landfall route T-AB-1` classes it trivial, standard or critical.
3. The agent writes a failing test, then the change, and a report with a RED and a GREEN result.
4. `landfall verify T-AB-1` re-runs the gates itself and compares the tests with the baseline. `landfall task done T-AB-1` works only after a passing verify for the code at HEAD.

The full session is in the README demo. In a fullscreen terminal wide enough (144 columns) the `Landfall` pane opens beside the transcript and shows the open tasks, the agents at work with their task, role and time, the slots and the next step; `/landfall:dashboard` opens it from 110 columns, and narrower terminals get its one-line summary in the status bar.

### First run in a cloned repository

A repository's gate commands run only once this machine trusts them. In a terminal run `landfall trust` before `landfall verify` (in Claude Code type `! landfall trust`); it asks for confirmation and refuses `--yes`.

### Merging finished work

`landfall task merge --ready` merges every ready task as one batch, runs the gates once on the integrated tree and bisects on a failure. `landfall task merge <id…>` merges the tasks you name. If you merged a branch by hand, `landfall task merge <id> --adopt` records it.

### The findings backlog

Review findings still open when a review closes at the round cap are kept. `landfall findings list` shows them, `landfall findings show <id>` reads one, and `landfall findings take <id>` turns it into a task; that task's `task done` closes the finding. `findings close <ids…> --task <id>` records that an existing task fixed them; `findings drop` drops one with a reason (a decision).

## 4. Useful commands

- `landfall status` shows open tasks and their next step; `landfall task show <task>` is the card of one task (branch, rounds, last verify, next step).
- `landfall task start <task>` creates the worktree and the branch; `landfall report <task> --from <file>` stores the report; `landfall review brief <task>` renders the review brief; `landfall commit` commits the state directory. With the state inside the repository, commit it once (`landfall commit --yes`) before the first `task start`.
- `landfall exec --task <task> --role reviewer|implementer` runs Codex, Gemini or a declared provider (`landfall providers` lists them); `landfall wait <run>` waits for it, and `landfall review record <task> --kind external --run <run>` records its review.
- `landfall lessons add` records a lesson with its evidence; `landfall lessons find <words>` looks one up.
- A change on a risk path or with the security flag is reviewed by the security reviewer against the OWASP lists; `landfall rule OWA-1 LLM-1 AGT-1` prints the first rule of each (web, LLM, agentic). `landfall secrets` scans the tree before a report leaves the worktree.
- `landfall decide` records a decision; `landfall decide --from-verify <task>` allows the tests verify saw removed; `landfall decisions check` fails on a cited decision that is unknown or retired.
- `landfall heavy <command>` runs a full suite or build from the machine queue.
- `landfall <command> --help` prints help; the reference is [cli.md](cli.md).

## 5. Update, uninstall

`claude plugin update landfall@landfall-plugins`, then `/reload-plugins`. To uninstall: `claude plugin uninstall landfall@landfall-plugins`. A project's `.landfall/` stays; run `landfall deactivate` in the repository first to remove it.

Limits of this release: [known-limitations.md](known-limitations.md).
