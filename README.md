# CodingAgentsWorkflow

A Claude Code plugin that sizes the process to each coding task and checks the outcome in code: a task is done only when its gates pass again.

> **Beta.** This is 2.0.0-beta.1. Parts of the design are not in this release yet; read [docs/known-limitations.md](docs/known-limitations.md) before you rely on it.

The plugin and its command line tool are both called `caw`. To install, paste `https://github.com/NovaSeth/CodingAgentsWorkflow` into Claude Code and say "install"; the agent follows the next section.

## Install (for agents)

```
claude plugin install caw --marketplace NovaSeth/CodingAgentsWorkflow
```

Then ask the user to type `/reload-plugins` (or restart Claude Code); that is the only manual step.

If the command exits non-zero, add the marketplace, then install from it:

```
claude plugin marketplace add NovaSeth/CodingAgentsWorkflow
claude plugin install caw@caw-plugins
```

Check: `claude plugin list --json` contains `"id":"caw@caw-plugins","enabled":true`. After the reload, run `caw doctor`: it reports the Claude Code version floor, plugin and hooks, release, state and context cost, and every row carries a fix hint.

Installing writes nothing into your projects; Claude Code keeps its own plugin records. Requirements: Claude Code and git.

## What it does

- **Work starts from a conversation, not a wizard.** Ask for a change as usual. The plugin's `work` skill sizes it first: a trivial change runs as plain Claude Code and writes no files. For larger work the agent says in one line that it will track the repository, runs `caw init`, scans the repository and asks at most three questions. Say "no caw here" and the opt-out is remembered outside the repository (`caw decline`).
- **Outcome gates in code.** `caw verify` re-runs the project's gate commands itself; the agent's report cannot change the result. It compares the test inventory with a baseline: a removed or newly skipped test fails unless a recorded decision allows it, and only new failures count. `caw task done` refuses without a passing verify for the code at HEAD, and `caw task merge` commits only when the gates pass on the merged tree.
- **Decision records with IDs.** `caw decide` records what was decided, why, and the cost if it is wrong, under an ID such as `D-AB-3`. Cite the ID next to the code it constrains; when an agent edits that file, the decision is shown to it. `caw decisions check` fails on a cited decision that is unknown, retired or (in CI) superseded. Changing decided behavior takes a superseding decision.
- **A loop that always ends.** An unattended run wakes up on a fixed prompt and ends with a typed exit: done, stalled (no progress across repeated checks for a stall window, default 30 minutes) or budget (a cap on wall time, wake-ups or cost reached). A hook refuses to reschedule a loop that has ended, and a second fix round on a task asks to escalate or change approach instead of starting a third.
- **Machine budget and a heavy-command queue.** Heavy commands such as full test suites and builds take a slot from a per-machine queue, so parallel agents wait their turn instead of overloading one machine. In this beta the queue runs from the CLI only; hooks do not enforce it yet.
- **Team lanes via git.** Each developer gets a short handle from `git user.name`; the team file stores only a hash of the email. Task and decision IDs are numbered per handle, so two people never take the same ID, and a lane is claimed with a ref on the shared origin, so two developers do not work the same lane.
- **Ceremony that scales with the task and the project.** `caw route` classes each task trivial, standard or critical from the paths, size and risk flags of its plan: a trivial task needs no plan, a standard one is test-first, a critical one gets a spec and a plan before code. The class only rises. `caw tier` rates the project L0-L3 from its git history (a recommendation in this beta). The outcome gates are the same for every class and tier.

## 60-second demo

An abridged session in a repository the plugin has not seen before. The agent runs each `caw` command with `--json`; output is shortened here.

```text
You     Add a CSV export to the monthly report page.

Claude  $ caw route --probe --paths src/reports/export.ts,src/reports/page.tsx --loc 80
        standard
        This is a standard-size change, so I will track it with caw; its state
        goes in .caw/ in this repository. Say "no caw here" to work without it.

You     OK.

Claude  $ caw init --yes
        handle AB
        $ caw profile observe --yes
        stack: node · gate: npm test
        Two questions: is this app deployed to users? Is there a deadline?

You     Yes, about 40 customers use it. No deadline.

Claude  $ caw profile set deployedToUsers true --source said \
            --evidence "Yes, about 40 customers use it" --yes
        $ caw task new "CSV export on the monthly report page" --yes
        T-AB-1
        $ caw route T-AB-1 --paths src/reports/export.ts,src/reports/page.tsx \
            --loc 80 --yes
        standard: test first, plan in the task
        RED    npm test: 1 failing, "exports report rows as CSV" (no export yet)
        GREEN  npm test: all passing; committed
        report with RED and GREEN written to .caw/tasks/T-AB-1/ and committed
        $ caw verify T-AB-1 --yes
        pass: gates re-run, no test removed, baseline +1
        $ caw task done T-AB-1 --yes
        T-AB-1 done

        Done: CSV export added test-first; verify passed for the code at HEAD.
```

## Commands at a glance

| Command | What it does |
|---|---|
| `caw doctor` | Health report: Claude Code floor, plugin and hooks, release, state, profile, context cost, permissions |
| `caw init` | Start tracking this repository: state directory and your handle |
| `caw decline` | Opt out of tracking; remembered on this machine, never in the repository |
| `caw profile show` | The project profile: facts with source and evidence, gates, risk paths |
| `caw task new <title>` | Create a task with the next ID of your handle, such as `T-AB-1` |
| `caw route <task>` | Class a task trivial, standard or critical and print its route |
| `caw verify <task>` | Re-run the gates, compare the tests with the baseline, record the result |
| `caw task done <task>` | Close a task; refused without a passing verify for the code at HEAD |
| `caw task merge <task>` | Merge a task branch; commit only when the gates pass on the merged tree |
| `caw decide` | Record a decision: what, why, cost if wrong |
| `caw decisions check` | Fail on a cited decision that is unknown, retired or superseded |

Commands that change files need a terminal or `--yes`. With `--json`, every command prints exactly one JSON line, and exit codes are typed (0 OK, 1 FAIL, 2 USAGE, 7 REFUSED, 8 ENV, and loop exits). Full reference: [docs/cli.md](docs/cli.md), or `caw <command> --help`. The rules the agents follow are in `plugins/caw/method/`; `caw rule <ID>` prints one.

## What it writes

- `caw init` creates the state directory `.caw/` (with `state.json` and your handle in `team/<H>.json`) and a `.gitignore`. Use `--state-dir <path>` to keep the state outside the repository.
- Generated files (CI workflow, pre-push hook, PR template, CODEOWNERS, an `AGENTS.md` block) are written only by `caw gen apply`. Each merges with your edits; an edit that would be lost leaves the file as it is and puts the new version in a side file. `caw gen plan` shows every change first.
- `caw deactivate` removes the untracked state of a repository. State tracked by git is never removed; the command prints the `git rm` to run first.

## How it compares

CodingAgentsWorkflow is a process and enforcement layer that runs inside Claude Code. It does not replace an editor, an IDE integration or an agent cockpit; it adds task sizing, decision records and outcome gates to the Claude Code sessions you already run, and it can add a block to `AGENTS.md` when the repository also uses other agent tools. Its effect against plain Claude Code has not been measured yet. A with/without evaluation will be published; until then this README makes no claims about speed, cost or quality.

## Known limitations

- **Not in this beta:** external executors (such as Codex or Gemini CLI) in the Claude Code agent panel, scheduler enforcement in hooks, some wiring after merge, the example project and the published evaluation. They are planned for 2.0.0.
- **Project tiers are advisory.** `caw tier` explains and recommends; by default a tier change is a recommendation only.
- **The Bash guard is a seat belt, not a security boundary.** Some command shapes pass it, such as moving a whole directory or a path built only from variables; `verify` still enforces outcomes in code. It also blocks `git push` without an explicit `<src>:<dst>` refspec after a command on the same line that may change branch state (`npm test && git push origin feat/x`): push in a separate command.
- **Generated files:** keep them under version control and preview with `caw gen plan`. After a crash during `caw gen apply`, rerun it right away.
- **`caw doctor`** does not check branch protection, and there is no reduced mode below the minimum Claude Code version.

Full list: [docs/known-limitations.md](docs/known-limitations.md).

## Update and uninstall

Update:

```
claude plugin update caw@caw-plugins
```

Then type `/reload-plugins`. `caw doctor` reports when a newer release exists.

Uninstall:

```
claude plugin uninstall caw@caw-plugins
```

Claude Code removes the plugin and its data. A project's `.caw/` stays, because it belongs to the project; run `caw deactivate` in that repository first if you want it gone.

## Contributing

Issues and pull requests are welcome. Before you open a pull request, run the gate; it must exit 0:

```
npm test
```

For a bug report, attach the output of `caw doctor --json`.

## License

MIT
