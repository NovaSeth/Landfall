# Changelog

## 2.0.0

Landfall (renamed from `caw`): plugin `landfall`, command `landfall`, state directory `.landfall/`, environment prefix `LANDFALL_`, marketplace `landfall-plugins`, repository NovaSeth/Landfall. Existing `.caw/` state and machine data move to the new names by layout migration `002-rename-state-dir` (`landfall migrate`).

Since 2.0.0-beta.1:
- External executors: `landfall exec`, `landfall wait`, `landfall runs list|show|stop`, `landfall providers [add]`; a detached supervisor ends the provider group on SIGTERM; run records are command-owned and sandbox and cwd derive from the role; agent-panel rows and an external wrapper agent.
- Wiring: the SessionStart tier line, the `task done` receipt, doctor rows for providers and the scheduler; long gates run under the heavy lease and gate output is redacted at one point; gate results are reused for an identical clean tree.
- Verify measures the reference at the task base; worktree-aware state; secrets scan (`landfall secrets`).
- Router and engine read decision-backed threshold overrides; route and brief print the review need; review tier and review close.
- Skills walk the real flow (work, start, dispatch, review, loop, decide, plan, status, doctor); implementer and reviewer agents.
- Admin commands: flags, config, profile gates, migrate, install; read commands: status, brief, method, receipt.
- The guard's owned-file list comes from the state kinds; the README demo runs as an e2e test; timing tests wait on what they observe.

## 2.0.0-beta.1

CodingAgentsWorkflow 2 is a Claude Code plugin (`caw`) installed once per user. It adds a process and enforcement layer to the agents you already use: work starts from a conversation, outcomes are checked in code, decisions are recorded, and unattended loops always end. This is a beta: see [docs/known-limitations.md](docs/known-limitations.md).

**Install and activation**
- One command installs the plugin from this repository's marketplace; nothing is written into a project until you start working there and agree.
- Project state lives lazily in one directory (`.caw/`), schema-versioned; a newer schema is refused, never overwritten.

**Profile and adaptive ceremony**
- The project profile grows from the conversation and from observing the repository (manifests, CI, test commands) — no wizard.
- The engine measures project signals and recommends a tier; it runs in shadow mode in this beta (it logs, it does not switch).
- The task router classifies each task (trivial / standard / critical) from its paths, size and flags; a class only rises.

**Outcome gates in code**
- `caw verify <task>` re-runs the profile gates itself, compares the test inventory with the baseline, and refuses removed or newly skipped tests unless a decision allows them.
- `caw task done` works only after a passing verify for the code at HEAD; `caw task merge` merges with `--no-ff --no-commit`, runs the gates on the merged tree, and commits only when they pass.
- `caw review record` stores a typed, schema-validated review; `caw baseline show|pin` inspects and repairs the baseline.

**Loop**
- `caw tick` is the successor of the 1.x tick: typed exits ACTION / WAIT / DONE / STALLED / BUDGET, hard caps (time, ticks, cost, rounds), stall detection, and no wakeup after the loop ends. Lifecycle hooks guard scheduled wakeups and the end of a turn.

**Safety and resources**
- A Bash guard (a seat belt, not a boundary) blocks commands that touch the plugin's state or remove the repository, with a list of known-safe shapes; hooks fail open on malformed input and stay under 1 s of CPU.
- A machine-wide scheduler: calibration, leases with port and database blocks, and `caw heavy` — a queue for heavy commands that runs each one in its own process group with a time limit and starts it only when load and memory allow.

**Team, decisions, receipts, generated files**
- Team lanes claimed by compare-and-swap on the remote (`caw lane claim|renew|release|list|takeover`).
- Decision records with stable IDs, supersede and retire, edit-time retrieval of the decisions that cover a file.
- Receipts: token and cost totals per task from Claude Code transcripts, in integer micro-dollars.
- Generated files (CI workflow, pre-push hook, CODEOWNERS block, PR template, AGENTS.md block) are updated by a three-way merge that keeps every local edit.
- `caw doctor` reports versions, hooks, PATH, state schema, profile freshness, flags and context cost.

**Method**
- The method is English, indexed, and loaded on demand by rule ID or section (`caw rule`), with packs that activate by project facts.

1.x history (Polish, a kit copied into each project): see tag [`v1.5.1`](https://github.com/NovaSeth/CodingAgentsWorkflow/tree/v1.5.1).
