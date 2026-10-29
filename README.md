<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo.svg" width="120" alt="Landfall logo">
  </picture>
</p>

# Landfall

Landfall is a Claude Code plugin that turns one session into a small engineering team and holds it to outcomes checked in code. The session orchestrates: it sizes the task, writes a brief, hands the work to a fresh implementer in its own worktree (a Claude agent, or an external CLI such as Codex, which can also review; every run is a row in the agent panel), routes each role to the cheapest model that can do it, has the result reviewed, and closes the task only when `landfall verify` has re-run the project's gates on the code. A trivial change skips all of that, and every task leaves a receipt of what it cost. Formerly `caw`.

## Install

```
claude plugin install landfall --marketplace NovaSeth/Landfall
```

Then type `/reload-plugins` (or restart Claude Code). If the command fails, add the marketplace first:

```
claude plugin marketplace add NovaSeth/Landfall
claude plugin install landfall@landfall-plugins
```

If Claude Code says `landfall-plugins` is already known from another source (for example a local clone), run `claude plugin marketplace remove landfall-plugins`, which also uninstalls the plugin, then install again.

First use: open Claude Code in your repository and ask for a change, as in the demo below; nothing needs to be invoked. Three slash commands are yours: `/landfall:start` activates tracking in the repository now, `/landfall:status` shows the state, `/landfall:doctor` checks the setup.

Agents: check `claude plugin list --json` for `"id":"landfall@landfall-plugins","enabled":true`, then run `landfall doctor`. Installing writes nothing into your projects. Requirements: Claude Code and git. First steps: [docs/getting-started.md](docs/getting-started.md).

## 60-second demo


An abridged session in a repository the plugin has not seen before. The agent runs each `landfall` command with `--json`; output is shortened here.

```text
You     Add a CSV export to the monthly report page.

Claude  $ landfall route --probe --paths src/reports/export.ts,src/reports/page.tsx --loc 80
        standard
        This is a standard-size change, so I will track it with Landfall; its state
        goes in .landfall/ in this repository. Say "no landfall here" to work without it.

You     OK.

Claude  $ landfall init --yes
        handle AB
        $ landfall profile observe --yes
        stack: node · gate: npm test
        Two questions: is this app deployed to users? Is there a deadline?

You     Yes, about 40 customers use it. No deadline.

Claude  $ landfall profile set deployedToUsers true --source said \
            --evidence "Yes, about 40 customers use it" --yes
        $ landfall task new "CSV export on the monthly report page" --yes
        T-AB-1
        $ landfall route T-AB-1 --paths src/reports/export.ts,src/reports/page.tsx \
            --loc 80 --yes
        standard: test first, plan in the task
        RED    npm test: 1 failing, "exports report rows as CSV" (no export yet)
        GREEN  npm test: all passing; committed
        report with RED and GREEN written to .landfall/tasks/T-AB-1/ and committed
        $ landfall verify T-AB-1 --yes
        pass: gates re-run, no test removed, baseline +1
        $ landfall task done T-AB-1 --yes
        T-AB-1 done

        Done: CSV export added test-first; verify passed for the code at HEAD.
```

## What it does

- **Orchestration built in.** `landfall task start` (worktree, branch, base) → brief → implementer → `landfall report` → verify → `landfall review brief` → reviewer → at most two fix rounds → merge → `landfall commit`, driven by skills that name the exact commands; an agent gets a brief file with exact values, never the session history, and `landfall task show` is the card a session resumes from.
- **Done means verified.** `landfall verify` re-runs the gate commands itself and compares the test inventory with a baseline: a removed or newly skipped test fails without a recorded decision, while a test that only changed its title is reported as renamed. `landfall task done` and `landfall task merge` refuse otherwise; the merge commits only when the gates pass on the merged tree. The state directory is not code: a decision or a report written after verify needs no new commit.
- **Ceremony scaled to the task and the project.** `landfall route` classes a change trivial, standard or critical from its paths, size and risk flags; documentation and images weigh nothing, the project's own risk globs and review focus live in the profile, and a task is classed from its own commits, not from main merged into it. The review need follows the project tier (`landfall tier`); a critical change gets a spec, a plan and a review from another provider.
- **Decisions with IDs.** `landfall decide` records what, why and the cost if wrong under an ID such as `D-AB-3`; an agent that edits the code citing it sees the decision.
- **A loop that ends, a machine that stays usable.** Unattended runs end with a typed exit (done, stalled, budget) and never reschedule after the end; `landfall heavy` queues full suites and builds per machine so parallel agents wait their turn.
- **External executors as first-class agents.** `landfall exec`, `landfall wait` and `landfall runs` run Codex or Gemini CLI as reviewers or implementers, in supervised, recorded runs with agent-panel rows; `landfall secrets` scans before a report leaves the worktree.
- **A dashboard beside the transcript.** In a wide fullscreen terminal the `Landfall` pane shows, from general to detail, the project and its loop, how many tasks are open and in which stage, the agents at work (Claude subagents and external runs) with role, task, round, elapsed time and where their result landed, the slots in use and the next step; `/landfall:dashboard` opens it, and a narrower terminal gets its one line in the status bar. It reads the plugin's own `status --json`, never the model's context.
- **Tokens spent where they count.** Roles are routed to model tiers: the orchestrating session plans, dispatches and merges but never implements; the implementer and the reviewer run on Sonnet, the external wrapper on Haiku, the designer on Opus. Method rules load by ID on demand (always-on context about 550 tokens), trivial work calls nothing, and `landfall receipt` shows tokens and cost per task, loop, class or executor, with a dollar cap on unattended loops.
- **Zero footprint until you say yes.** Installed once per user; a project gets one `.landfall/` directory only when real work starts there and you agree.

## What's new in 2.5.0

- External implementers. `landfall exec --role implementer` runs Codex, Gemini or a declared provider in the task's worktree, and the run shows in the dashboard like a review (ORC-26). External runs are hardened: a minimal environment, the provider binary by absolute path, output redacted and bounded, and records bound to what exec started. An external review is recorded only from its run.
- Lessons. `landfall lessons add|find|promote` keep evidence-gated lessons. A lesson becomes active only when receipts show its effect, and briefs list the ones that match.
- Executor suggestion. `landfall route --executor` suggests an executor from your receipts once the data separates.
- Context headroom warnings (shadow), an opt-in mirror of tasks in Claude Code's task list with a completion gate, a one-way GitHub issue mirror (`landfall mirror github`), and `landfall import-1x` for 1.x ledgers.
- An example project in [examples/notes-api](examples/notes-api), built end to end with Landfall, its state committed.

## What's new in 2.4.1

- Security audit fixes. The Bash guard scans in linear time, blocks globbed git subcommands and split state paths, and treats repository text as data. The secrets scanner knows more formats, matches long lines in linear time, streams large files and fails closed past 64 MiB. `gen apply` never writes into `.git`, refuses `${{` in CI gate commands, and `--commit <sha>` pins CI to a commit. `verify` redacts with project patterns, signs its gate cache with a machine key and reads `--from` files safely. Agent-instruction files (CLAUDE.md, AGENTS.md, SKILL.md, `.claude/**`, prompts) are risk paths, and the external wrapper agent may run only `landfall exec|wait|runs|rule|method`.
- Machine trust. A repository's gate commands and threshold overrides run or count only once this machine set or trusted them. `landfall trust` asks for confirmation in a terminal (`! landfall trust` in Claude Code) and refuses `--yes`. An existing repository with a machine-side record is adopted once, and a `local/` directory shipped inside a repository is ignored and moved aside to `local.foreign-*`.
- Findings backlog. Review findings still open when a review closes at the round cap go into `landfall findings list`; `landfall findings take` turns them into a task, and its `task done` closes them.
- Batch merge. `landfall task merge <ids…>` or `--ready` merges ready tasks as one batch with one gate run on the integrated tree, bisected on a failure. Every merge is recorded on the task; `status`, `tick` and `doctor` report a merge done by hand, and `task merge --adopt` records it. The Bash guard blocks a plain `git merge` of a task branch on the target.
- Orchestrator watchdog. The orchestrator checks agents, gates and load on a schedule and unblocks what is slow; `status` and `tick` flag a long heavy-queue wait and high load.
- External reviews. `landfall exec --role reviewer` feeds the stored review brief (`--round <k>`) and Codex's review schema.
- Dashboard. TASKS shows the open tasks as `▶ working` or `⏸ waiting`; AGENTS lists only the agents and runs at work.

Details: [docs/cli.md](docs/cli.md).

## How it compares

| Capability | Claude Code | Superpowers | Spec Kit | BMAD | orca | Landfall |
|---|---|---|---|---|---|---|
| Skills and process guidance | — | ✓ | ✓ | ✓ | — | ✓ |
| Spec and plan before code | — | ✓ | ✓ | ✓ | — | ✓ (critical tasks) |
| Task sizing: no ceremony for small changes | — | — | — | — | — | ✓ |
| Outcome gates re-run by code, not by the agent | — | — | — | — | — | ✓ |
| Test inventory baseline | — | — | — | — | — | ✓ |
| Decision records with stable IDs | — | — | — | — | — | ✓ |
| Loop with typed exits and caps | — | — | — | — | — | ✓ |
| Machine-wide queue for heavy commands | — | — | — | — | — | ✓ |
| External provider runs | — | — | — | — | ✓ | ✓ |
| Roles routed to model tiers, cost receipts per task | manual | — | — | — | manual | ✓ |
| Agent cockpit or IDE integration | — | — | — | — | ✓ | — |

The table lists what each tool documents (public READMEs as read on 2026-10-19; corrections are welcome as issues), not how well it works. Landfall adds a process, cost and enforcement layer to Claude Code sessions; it does not replace an editor or a cockpit such as orca, and can run inside one. A comparison with these tools will run under the pre-registered rules in [docs/benchmark.md](docs/benchmark.md).

## Measured

With/without evaluation on the plugin's own suite (10 small tasks with hidden tests, 5 runs per arm, 2026-10-19): quality delta **0** (49/50 complete in both arms), cost **+29 %** with the plugin, and two of three trivial cases over the suite's overhead limits. The plugin does not improve these small tasks and costs more on them. After a skill change the same day, the token overhead of two of the three trivial cases is at or near the limit; the remaining extra time is the test run the plugin asks for after every change. Details and the reading in [docs/evaluation.md](docs/evaluation.md).

## Commands at a glance

| Command | What it does |
|---|---|
| `landfall doctor` | Health report: Claude Code floor, plugin and hooks, state, context cost |
| `landfall init` | Start tracking this repository (state in `.landfall/`) |
| `landfall profile observe` | Scan the repository and merge the facts into the profile |
| `landfall task new <title>` | Create a task with the next ID of your handle |
| `landfall route <task>` | Class a task and print its route |
| `landfall task start <task>` | Create the task's worktree and branch, record the base |
| `landfall report <task> --from <file>` | Store the task report (RED/GREEN checked); `--round` appends a fix round |
| `landfall review brief <task>` | Render the review brief: range pinned to HEAD, diff file, acceptance, risks |
| `landfall verify <task>` | Re-run the gates and compare with the baseline (renames need no decision) |
| `landfall task done <task>` | Close a task; refused without a passing verify |
| `landfall task merge <task…>` or `--ready` | Merge ready tasks as one batch; commit only if the gates pass on the integrated tree; `--adopt` records a merge done by hand |
| `landfall trust` | Trust this repository's gate commands on this machine (terminal only) |
| `landfall findings list` | Open review findings left at the round cap; `take` turns one into a task |
| `landfall commit` | Commit the state directory as one chore commit |
| `landfall decide` | Record a decision (`--from-verify` allows the tests verify saw removed) |
| `landfall task show <task>` | The resume card: class, branch, rounds, last verify, next step |
| `landfall status` | Activation, open tasks, loop and leases |

Commands that change files need a terminal or `--yes`. With `--json` every command prints one JSON line; exit codes are typed. Full reference: [docs/cli.md](docs/cli.md) or `landfall <command> --help`.

## Known limitations

[docs/known-limitations.md](docs/known-limitations.md). The Bash guard is a seat belt, not a security boundary; `verify` enforces outcomes in code.

## Update, uninstall, contribute

Update: `claude plugin update landfall@landfall-plugins`, then `/reload-plugins`. Uninstall: `claude plugin uninstall landfall@landfall-plugins`; a project's `.landfall/` stays until you run `landfall deactivate` there. Before a pull request run `npm test`; for a bug report attach `landfall doctor --json`.

## License

MIT
