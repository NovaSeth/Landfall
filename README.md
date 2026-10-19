# Landfall

Landfall is a Claude Code plugin that sizes the process to each coding task and checks the outcome in code: a task is done only when its gates pass again. Formerly `caw`.

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

- **Outcome gates in code.** `landfall verify` re-runs the gate commands itself and compares the test inventory with a baseline; `landfall task done` refuses without a passing verify for the code at HEAD.
- **Decisions with IDs.** `landfall decide` records what, why and the cost if wrong under an ID such as `D-AB-3`; the decision is shown to an agent that edits the code citing it.
- **A loop that ends.** Unattended runs end with a typed exit (done, stalled, budget) and never reschedule after the end.
- **Review scaled by tier.** `landfall route` classes a task trivial, standard or critical; `landfall tier` rates the project L0-L3.
- **Machine queue.** `landfall heavy` runs full suites and builds from a per-machine queue so parallel agents wait their turn.
- **External executors.** `landfall exec`, `landfall wait` and `landfall runs` run Codex or Gemini CLI as supervised, recorded runs.

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

The table lists what each tool documents, not how well it works. Landfall adds a layer to Claude Code sessions; it does not replace an editor or a cockpit. A with/without evaluation will be published after its pre-registration; until then this README makes no claim about speed, cost or quality.

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
