# Landfall

Landfall is a Claude Code plugin that turns one session into a small engineering team and holds it to outcomes checked in code. The session orchestrates: it sizes the task, writes a brief, hands the work to a fresh implementer in its own worktree (a Claude agent or an external CLI such as Codex, visible as a row in the agent panel), has the result reviewed, and closes the task only when `landfall verify` has re-run the project's gates on the code. A trivial change skips all of that. Formerly `caw`.

## Install

```
claude plugin install landfall --marketplace NovaSeth/Landfall
```

Then type `/reload-plugins` (or restart Claude Code). If the command fails, add the marketplace first:

```
claude plugin marketplace add NovaSeth/Landfall
claude plugin install landfall@landfall-plugins
```

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

- **Orchestration built in.** Brief → implementer in a worktree → verify → reviewer → at most two fix rounds → merge, driven by skills that name the exact commands; an agent gets a brief file with exact values, never the session history.
- **Done means verified.** `landfall verify` re-runs the gate commands itself and compares the test inventory with a baseline: a removed or newly skipped test fails without a recorded decision. `landfall task done` and `landfall task merge` refuse otherwise; the merge commits only when the gates pass on the merged tree.
- **Ceremony scaled to the task and the project.** `landfall route` classes a change trivial, standard or critical from its paths, size and risk flags; the review need follows the project tier (`landfall tier`); a critical change gets a spec, a plan and a review from another provider.
- **Decisions with IDs.** `landfall decide` records what, why and the cost if wrong under an ID such as `D-AB-3`; an agent that edits the code citing it sees the decision.
- **A loop that ends, a machine that stays usable.** Unattended runs end with a typed exit (done, stalled, budget) and never reschedule after the end; `landfall heavy` queues full suites and builds per machine so parallel agents wait their turn.
- **External executors as first-class agents.** `landfall exec`, `landfall wait` and `landfall runs` run Codex or Gemini CLI as supervised, recorded runs with agent-panel rows; `landfall secrets` scans before a report leaves the worktree.
- **Zero footprint until you say yes.** Installed once per user; a project gets one `.landfall/` directory only when real work starts there and you agree.

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
| Agent cockpit or IDE integration | — | — | — | — | ✓ | — |

The table lists what each tool documents (public READMEs as read on 2026-10-19; corrections are welcome as issues), not how well it works. Landfall adds a layer to Claude Code sessions; it does not replace an editor or a cockpit. A comparison with these tools will run under the pre-registered rules in [docs/benchmark.md](docs/benchmark.md).

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
| `landfall verify <task>` | Re-run the gates and compare with the baseline |
| `landfall task done <task>` | Close a task; refused without a passing verify |
| `landfall task merge <task>` | Merge a branch; commit only if the gates pass on the merged tree |
| `landfall decide` | Record a decision |
| `landfall status` | Activation, open tasks, loop and leases |

Commands that change files need a terminal or `--yes`. With `--json` every command prints one JSON line; exit codes are typed. Full reference: [docs/cli.md](docs/cli.md) or `landfall <command> --help`.

## Known limitations

[docs/known-limitations.md](docs/known-limitations.md). The Bash guard is a seat belt, not a security boundary; `verify` enforces outcomes in code.

## Update, uninstall, contribute

Update: `claude plugin update landfall@landfall-plugins`, then `/reload-plugins`. Uninstall: `claude plugin uninstall landfall@landfall-plugins`; a project's `.landfall/` stays until you run `landfall deactivate` there. Before a pull request run `npm test`; for a bug report attach `landfall doctor --json`.

## License

MIT
