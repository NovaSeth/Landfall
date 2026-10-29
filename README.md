<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo.svg" width="120" alt="Landfall logo">
  </picture>
</p>

# Landfall (2.5.1)

Landfall is a Claude Code plugin that turns one session into a small engineering team and accepts its work only when code has checked the outcome. The session sizes the task, writes a brief and hands the work to a fresh implementer in its own worktree (a Claude agent, or an external CLI such as Codex, which can also review). Every run gets a row in the agent panel. Each role runs on the cheapest model that can do it, the result is reviewed, and the task closes only after `landfall verify` has re-run the project's gates on the code. A trivial change skips all of this. Every task leaves a receipt of what it cost. Landfall was formerly called `caw`.

## Install

```
claude plugin install landfall --marketplace NovaSeth/Landfall
```

Then type `/reload-plugins` or restart Claude Code. If the command fails, add the marketplace first:

```
claude plugin marketplace add NovaSeth/Landfall
claude plugin install landfall@landfall-plugins
```

If Claude Code says `landfall-plugins` is already known from another source, such as a local clone, run `claude plugin marketplace remove landfall-plugins` and install again. Removing the marketplace also uninstalls the plugin.

To start, open Claude Code in your repository and ask for a change, as in the demo below. You don't need to invoke anything. There are three slash commands: `/landfall:start` turns on tracking in the repository right away, `/landfall:status` shows the state and `/landfall:doctor` checks the setup.

An agent can confirm the install by finding `"id":"landfall@landfall-plugins","enabled":true` in `claude plugin list --json` and then running `landfall doctor`. Installing writes nothing into your projects. You need Claude Code and git. First steps are in [docs/getting-started.md](docs/getting-started.md).

## 60-second demo

An abridged session in a repository Landfall has not seen before. The square brackets show what Landfall does; the agent runs those commands itself, with `--json`.

```text
You     Add a CSV export to the monthly report page.

Claude  This touches two files and about 80 lines, a standard-size change, so I'll
        track it with Landfall.
          [Landfall sizes the change: $ landfall route --probe \
              --paths src/reports/export.ts,src/reports/page.tsx --loc 80 → standard]
        Its state goes in .landfall/ in this repository. If you'd rather I work
        without it, say "no landfall here".

You     OK.

Claude  I've started tracking. Your handle is AB, so your tasks are T-AB-1, T-AB-2
        and so on.
          [Landfall sets up .landfall/: $ landfall init --yes]
        It's a Node project, and npm test is the gate.
          [Landfall reads the stack and the test command: $ landfall profile observe --yes]
        Two questions before I start: is this app deployed to users? Is there a
        deadline?

You     Yes, about 40 customers use it. No deadline.

Claude  Noted. I've opened a task for the export.
          [Landfall records your answer as evidence: $ landfall profile set deployedToUsers true \
              --source said --evidence "Yes, about 40 customers use it" --yes]
          [Landfall opens T-AB-1: $ landfall task new "CSV export on the monthly report page" --yes]
        It's standard, so the test comes first and the plan lives in the task.
          [Landfall routes the task: $ landfall route T-AB-1 \
              --paths src/reports/export.ts,src/reports/page.tsx --loc 80 --yes]

        The new test, "exports report rows as CSV", fails because there is no
        export yet. With the export written, all tests pass, and I've committed
        the change. The task report in .landfall/tasks/T-AB-1/ holds both runs and
        is committed too.

        Then Landfall re-ran the gates on its own: no test was removed, and there
        is one test more than before.
          [Landfall re-runs the gates against the baseline: $ landfall verify T-AB-1 --yes → pass]
        The check passed for the code at HEAD, so I've closed the task.
          [Landfall closes the task: $ landfall task done T-AB-1 --yes]
```

## What it does

- **Orchestration.** Skills take each task through `landfall task start` (worktree, branch, base) → brief → implementer → `landfall report` → verify → `landfall review brief` → reviewer → at most two fix rounds → merge → `landfall commit`, and name the exact command for every step. An agent gets a brief file with exact values and never sees the session history; a session resumes from the card that `landfall task show` prints.
- **Verification.** `landfall verify` re-runs the gate commands itself and compares the test inventory with a baseline: a removed or newly skipped test fails unless a decision records it, and a test whose title alone changed is reported as renamed. `landfall task done` and `landfall task merge` refuse without a passing verify, and a merge commits only if the gates pass on the merged tree. The state directory is not code, so a decision or report written after verify needs no new commit.
- **Task sizing.** `landfall route` classes a change as trivial, standard or critical from its paths, size and risk flags. It counts only the task's own commits, not main merged into it, and gives documentation and images no weight. The profile holds the project's risk globs and review focus, the review need follows the project tier (`landfall tier`), and a critical change gets a spec, a plan and a review from another provider.
- **Decisions.** `landfall decide` records what was decided, why, and the cost if it is wrong, under an ID such as `D-AB-3`. An agent that edits code citing a decision sees that decision.
- **Loops and machine load.** An unattended run ends with a typed exit (done, stalled or budget) and never reschedules after that. `landfall heavy` queues full test suites and builds per machine, so parallel agents take turns.
- **Security review.** A change on a risk path (auth, money, migrations, CI, agent instructions) or with the security flag gets the security reviewer, which works through the OWASP Top 10:2025, the OWASP Top 10 for LLM Applications 2025 and the OWASP Top 10 for Agentic Applications (rules `OWA-*`, `LLM-*` and `AGT-*`, read with `landfall rule`). A critical change is also reviewed by another model provider when one is installed (`landfall providers`).
- **Guards.** A Bash guard blocks destructive and unproven commands, and `landfall secrets` scans a report before it leaves the worktree. Agents see repository text only as quoted data, and a cloned repository's gate commands run only after `landfall trust`.
- **Learning.** Review findings still open at the round cap go to a backlog (`landfall findings list`). A lesson (`landfall lessons add`) is admitted only with evidence that exists in the state and becomes active only when later receipts show its effect. `landfall route --executor` suggests an executor only once the receipts tell the executors apart.
- **External executors.** `landfall exec`, `landfall wait` and `landfall runs` run Codex or Gemini CLI as a reviewer or an implementer, in supervised, recorded runs that get rows in the agent panel. The provider gets a minimal environment and is started by the path exec resolved.
- **Dashboard.** In a wide fullscreen terminal, `/landfall:dashboard` opens the `Landfall` pane beside the transcript. From the overview down to the detail, it shows the project and its loop, how many tasks are open and at which stage, the agents at work (Claude subagents and external runs) with role, task, round, elapsed time and where each result landed, the slots in use and the next step. A narrower terminal gets one line in the status bar. The pane reads the plugin's own `status --json`, never the model's context.
- **Model tiers and cost.** The implementer and the reviewer run on Sonnet, the external wrapper on Haiku and the designer on Opus; the orchestrating session plans, dispatches and merges but never implements. Method rules load by ID on demand, so the always-on context is about 550 tokens, and trivial work calls nothing. `landfall receipt` shows tokens and cost per task, loop, class or executor, and unattended loops have a dollar cap.
- **Footprint.** Landfall is installed once per user. A project gets one `.landfall/` directory only when real work starts there and you agree.

## What's new in 2.5.1

- Dashboard task rows show a short description, a progress bar of the time spent against the expected time with the expected finish, and an icon: a pulsing ▶ while an agent works on the task, ⏸ when nobody does, and a grey ■ when nobody has picked it up this session.
- Clocks in the pane count live every second. A working agent's row turns from blue to orange as it nears its time limit and red past it.
- `landfall status --json` gives each task `startedAt`, `lastEventAt` and `expectedMs`.

## What's new in 2.5.0

- External implementers. `landfall exec --role implementer` runs Codex, Gemini or a declared provider in the task's worktree, and the dashboard shows the run like a review (ORC-26).
- Hardened external runs. Each run gets a minimal environment, the provider binary by absolute path, redacted and bounded output, and records bound to what exec started. An external review is recorded only from its run.
- Lessons. `landfall lessons add|find|promote` add, find and promote lessons backed by evidence. A lesson becomes active only when receipts show its effect, and briefs list the lessons that match.
- Executor suggestion. `landfall route --executor` suggests an executor from your receipts once they tell the executors apart.
- Also new: context headroom warnings (shadow), an opt-in mirror of tasks in Claude Code's task list with a completion gate, a one-way GitHub issue mirror (`landfall mirror github`) and `landfall import-1x` for 1.x ledgers.
- An example project, [examples/notes-api](examples/notes-api), built end to end with Landfall and committed with its state.

## What's new in 2.4.1

- Security audit fixes:
  - The Bash guard scans in linear time, blocks globbed git subcommands and split state paths, and treats repository text as data.
  - The secrets scanner knows more formats, matches long lines in linear time, streams large files and fails closed past 64 MiB.
  - `gen apply` never writes into `.git` and refuses `${{` in CI gate commands; `--commit <sha>` pins CI to a commit.
  - `verify` redacts with project patterns, signs its gate cache with a machine key and reads `--from` files safely.
  - Agent-instruction files (CLAUDE.md, AGENTS.md, SKILL.md, `.claude/**`, prompts) are risk paths, and the external wrapper agent may run only `landfall exec|wait|runs|rule|method`.
- Machine trust. A repository's gate commands and threshold overrides run or count only after this machine has set or trusted them. `landfall trust` asks for confirmation in a terminal (`! landfall trust` in Claude Code) and refuses `--yes`. An existing repository with a machine-side record is adopted once; a `local/` directory shipped inside a repository is ignored and moved aside to `local.foreign-*`.
- Findings backlog. Review findings still open when a review closes at the round cap go to `landfall findings list`. `landfall findings take` turns them into a task, and that task's `task done` closes them.
- Batch merge. `landfall task merge <ids…>` or `--ready` merges ready tasks as one batch with one gate run on the integrated tree, and bisects the batch on a failure. Every merge is recorded on the task: `status`, `tick` and `doctor` report a merge done by hand, and `task merge --adopt` records it. The Bash guard blocks a plain `git merge` of a task branch on the target.
- Orchestrator watchdog. The orchestrator checks agents, gates and load on a schedule and unblocks slow work. `status` and `tick` flag high load and a long wait in the heavy queue.
- External reviews. `landfall exec --role reviewer` passes the stored review brief (`--round <k>`) and Codex's review schema to the run.
- Dashboard. TASKS marks each open task `▶ working` or `⏸ waiting`, and AGENTS lists only the agents and runs at work.

Command details are in [docs/cli.md](docs/cli.md).

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
| Security review by the OWASP lists (web, LLM, agentic) | `/security-review` | — | — | — | — | ✓ |
| Review by another model provider | — | — | — | — | — | ✓ (critical tasks) |
| Secrets scan before work leaves the worktree | — | — | — | — | — | ✓ |
| Open review findings kept as a backlog | — | — | — | — | — | ✓ |
| Lessons admitted on evidence, promoted by receipts | — | — | — | — | — | ✓ |
| Example project with its process state committed | — | — | — | — | — | ✓ |
| Roles routed to model tiers, cost receipts per task | manual | — | — | — | manual | ✓ |
| Agent cockpit or IDE integration | — | — | — | — | ✓ | — |

The table shows what each tool documents, which says nothing about how well it works. The sources are the public READMEs, read on 2026-10-19, and on 2026-10-29 for the security, review, findings, lessons and example rows. Corrections are welcome as issues. Claude Code's `/security-review` reviews pending changes without a checklist. BMAD carries decisions forward as durable context, without the evidence gate. Landfall adds process, cost tracking and enforcement to Claude Code sessions. It can run inside an editor or a cockpit such as orca and does not replace one. A measured comparison with these tools is pre-registered in [docs/benchmark.md](docs/benchmark.md) but not run yet.

## Measured

A with/without evaluation on the plugin's own suite (10 small tasks with hidden tests, 5 runs per arm, 2026-10-19) found that the plugin does not improve these small tasks and costs more on them. The quality delta was 0 (49/50 complete in both arms), cost rose 29 % with the plugin, and two of the three trivial cases went over the suite's overhead limits. After a skill change the same day, the token overhead of two of the three trivial cases is at or near the limit. The rest of the extra time is the test run the plugin asks for after every change. Details and how to read them: [docs/evaluation.md](docs/evaluation.md).

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

Commands that change files need a terminal or `--yes`. With `--json`, every command prints one JSON line, and exit codes are typed. The full reference is [docs/cli.md](docs/cli.md) or `landfall <command> --help`.

## Known limitations

See [docs/known-limitations.md](docs/known-limitations.md). The Bash guard is a seat belt, not a security boundary. Outcomes are enforced in code by `verify`.

## Update, uninstall, contribute

To update, run `claude plugin update landfall@landfall-plugins`, then `/reload-plugins`. To uninstall, run `claude plugin uninstall landfall@landfall-plugins`. A project's `.landfall/` stays until you run `landfall deactivate` there. Run `npm test` before a pull request, and attach `landfall doctor --json` to a bug report.

## License

MIT
