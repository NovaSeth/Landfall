# Changelog

## 2.7.3

Security batch: role capability tokens replace the parsing role gate of 2.7.2 (decisions D-MG-72, D-MG-75).

- **Role tokens (T-MG-194, T-MG-196, T-MG-197, SEC-13):** the SessionStart hook mints a 256-bit session token for the orchestrator and the SubagentStart hook one single-use token for each reviewer or security-reviewer agent; only their hashes live in `local/token.json` (machine-local, bound to the live Claude Code process). `task set <id> dispatched`, `task set <id> self-verified` and `review record` take the token on stdin (`printf %s <token> | landfall … --token -`): a token on argv or in the environment is refused, a reviewer token records one review, and with no token the call is refused while a session holds the repository (nothing live: allowed with one warning). The store schema moves forward (migration 013), so an older CLI on the same machine is refused instead of forging around the check (SC10). A subagent cannot read Claude Code transcripts or the token store (Bash, Read, Grep and Glob are denied) and cannot start agents. The 2.7.2 parsing gate `roleDeny` and its test file are gone (D-MG-78: the forge test holds its 64 spellings against the CLI).
- **Code-health guardrails in verify (T-MG-188, D-MG-68):** every verify judges the changed files against the task base: a file crossing 800 lines or a function crossing 120 lines fails, a grown pre-existing offender warns until it is split; the verify output carries one health line and `tick` proposes a refactor task on bloat.
- **Train and reviews (T-MG-191, T-MG-192):** a merge conflict only in generated files (the target side carries the generator's header) is resolved by regenerating with the profile's trusted guard commands and checking them again, instead of leaving the task out; a review without `head` binds the commit the review brief pinned, an external run pins its brief's head and refuses a stale brief, and a merge of the target into a branch after its review no longer voids the review (only own commits do); a verify record of mode `train` must carry its train block.
- **Guard and decisions (T-MG-189):** the Bash guard reads a commit message (`-m`, `--message=`, `-F`) as text, not as paths; a test-removal decision opens its follow-up task listing the removed tests (postmortem 2026-11-05).

## 2.7.2

Second small batch: the security and flow pair, one integration branch, one gate (decision D-MG-65).

- **Merge train (T-MG-186, D-MG-65):** `landfall train <ids…>` (or `--ready`) merges approved tasks on one temporary integration branch in `--after` order, runs the gates once on the integrated tree, bisects a failure, fast-forwards the target only if it did not move, and records every task of the train as merged and done with a verify of mode `train`. Each task is checked again right before it is integrated and at record time with the same eligibility checks `task merge` uses (verify for the current head, class from the real change, approved review bound to the reviewed head, done head); a review record may carry the reviewed `head` and is refused when the branch tip moved. A task whose generated files conflict is left out as `conflict` (T-MG-191 follows). A task merged by hand (`task merge --adopt`) and not yet done rides the train as done-only: no merge, the one gate, then `done` (T-MG-195, first slice). The loop proposes the train for a critical task and `close` for the rest.
- **No self-approval (T-MG-187, SEC-13):** `review record` of a Claude review needs the dispatched reviewer: the latest dispatched executor must be a reviewer agent and no implementer report may follow it. The Bash guard denies a subagent without the reviewer role running `landfall review record` or `landfall task set <id> dispatched`, reading the tokenized command through quotes and common wrappers. This is a partial control: see known limitations; the complete control is role capability tokens (T-MG-194).
- **Verify record (schema 4):** one `mode` shape for every verify (`kind` fast, full or train, with the reason and the test files), the optional `train` block for the train's commit, head and batch; migration 012 stamps the schema so an older plugin refuses the record as newer (GC9) instead of reading it as invalid. The review event records the blocking count and the reviewed head.

## 2.7.1

First small batch after 2.7.0: one integration branch, one gate (PO 2026-11-05: ship in small batches).

- **Fast verify (T-MG-182):** `landfall verify` runs the test files that the changed files own plus the profile's fast guards; a shared or risk path, a critical task or `--full` runs the full gate set; `task merge` stays the one full run, and a removed test in a changed file is still caught against the base. A dropped or truncated change list fails closed to the full set. The loop's next step for an approved task is its own close at once, not held for a batch.
- **Guard shortcut outside Landfall repositories (T-MG-183):** in a repository with no Landfall state the Bash guard allows a plain command at once: bare words separated by single spaces, `--version` and `--help`. Quotes, escapes, expansions, braces, clustered or long options, directory changes, nested repositories and rm/mv/cp/ln/find/xargs get the full guard as before.
- **Waits log cap (T-MG-162):** `local/waits.jsonl` gets the guard log's 256 KiB cap; an open load marker (`until: null`) older than an hour is ignored by the admission readers, no state write for it.

## 2.7.0

Simplification week (decision D-MG-60): fewer orchestrator calls, shorter sessions, one gate per batch.

- **Breaking: Node 22 or later is required** (decision D-MG-36). `engines.node` is now `>=22`, and CI runs `npm test` on Node 22 and 24 and the npx channel on 22.12.0. Node 18 reached end of life on 2025-03-27 and Node 20 on 2026-03-24, so neither receives security fixes any more.
- **`landfall close <id…>`:** verify, `task done`, `task merge` and `commit` in one call; it stops at the first failing step with that step's exit code and the next command. Implementer and reviewer agents now store their own report and review with `landfall report` and `landfall review record`.
- **`landfall metrics [--day|--since] [--json]`:** the KPI table only (orchestrator calls and median context per closed task, cache reads, tasks over 2 fix rounds, start→merge and last review→merge medians, open backlog), read from task records and Claude Code transcripts; `n/a` with a reason, never a fabricated zero. Writes nothing.
- **Short orchestrator sessions:** `tick` prints a HANDOFF step when the session's context passes a threshold (default 200k tokens) or after a merge: commit the state, end the session, resume in a new one with `landfall status` (rule FLW-10).
- **Fix-round cap in code (REV-7):** `task set fix-round` past the cap is refused without a `review-close` decision; a needs-fixes review with only minor findings counts as approved and its minors go to the backlog.
- **Size never makes a task critical:** class critical comes only from critical flags and risk paths; size over the threshold says `split`; test files under `tests/` with a real test suffix are left out of the split rule only (the trivial cut still counts every file and line).
- **Implementer model lock:** the Agent hook denies launching `landfall:implementer` with a model other than the one its agent file declares, in every admission mode.
- **Loop questions do not block:** while a loop runs, AskUserQuestion is denied and the question is recorded as a blocked task (`question: …`) listed by `tick`; other work goes on. `doctor` warns when the security-guidance review has stopped working (sign-in rejected) and says how to sign in again; Landfall keeps both security reviews (SEC-13).
- **Verify, review v2 and logs:** verify records machine load, gate-cache state, heavy-queue wait and gate time; review records carry their focus; wait events for usage limits, load admission and ticks go to `local/waits.jsonl`; receipts are refreshed at merge and their failures are visible; receipt gates and defects before merge are filled from verify and review records.
- **`task outcome`:** records what a cancelled task delivered or was replaced by (`delivered`, `superseded`, `dropped`, `--by`), with `--adopt` proposals from cancel reasons.
- **Guard:** fewer false blocks of read-only commands (a measured corpus; new allow shapes fail closed on any unquoted glob, assignment or setter); the hook-path launcher checks are hardened.
- **Loop restart consent:** a one-time human consent recorded by a UserPromptSubmit hook lets `loop start` raise caps from a session; the transcript path is derived from the session.
- **Gate reliability:** timing tests judge CPU time, not wall time; isolated test environments relax scheduler admission; a baseline grown only by another task's tests does not make a verified task stale; the gate log keeps diagnostics within its budget.
- **Briefs** append the profile's fast cross-cutting guards; **tick** lists unrecorded finished external runs first; the **dashboard** marks a closed task before it leaves the panel.

## 2.6.0

- **Loop billing mode:**
  - The loop detects at creation whether Claude Code bills by subscription or by API and stores it (loop schema 2, migration 005). The `<PREFIX>BILLING` override `subscription` counts only from a terminal start, while `api` counts anywhere and can only tighten a running loop; otherwise API environment variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`) and `oauthAccount.billingType` in `.claude.json` decide. A tick may only tighten the mode to api.
  - In subscription mode the API-price dollar estimate does not end the loop; API and unknown billing keep the $25 cap. `loop start`, `loop status` and `tick` print `billing: <mode> (<source>)`. Caps are still raised only from a terminal.
- **Usage limit:** a message such as `You've hit your session limit · resets …` (session, weekly, Opus or Sonnet) in the repository's transcripts makes `tick` wait until the reset, between 60 s and 3600 s, and never report STALLED. An external run's usage limit (Codex) adds an informational row.
- **Dashboard:** live agents and runs show as `↳` rows under their task, with an UNASSIGNED group for the rest. The AGENTS section is gone, and every line fits the pane.
- **Batch merge:**
  - It links the main checkout's `node_modules` into the integration worktree when the lockfile matches. Otherwise, or when the first gate cannot run, it merges the tasks one by one.
  - "Changes the gates" is judged against the merge-base and names the gate or risk path.
- **Verify:** the measured lines of code skip owner-set light paths (the router's `lightPaths`), and a risk path always counts. Classify and verify now share one risk predicate, with no change in behaviour.
- **Test baseline:** the TAP parser skips lines inside YAML diagnostic blocks, so a stack frame is never a test and no phantom removal appears.
- **Docs:** README, getting started and known limitations describe the above. The new limits cover the undocumented billing field, local-time reset parsing, unread utilization percentages and the informational external limit.

## 2.5.1

- **Dashboard task rows:**
  - Each open task shows a short description after its ID.
  - A started task shows a progress bar of the time spent against the expected time, with the expected finish or the time over.
  - Icons show who is on it: a gently pulsing ▶ while an agent or run works on the task, ⏸ when nobody works on it now, and a grey ■ when nobody has picked it up this session.
- **Dashboard clocks and colours:**
  - Every clock in the pane counts live, redrawn each second.
  - A working agent's row is blue, turns orange as it nears its time limit (from 60 %), and is red past it. The limit is a run's cap, or 15 minutes for a Claude agent.
- **`status --json`:** each task gives `startedAt`, `lastEventAt` and `expectedMs`. The expected time is the median of the done tasks of the same class when there are three or more, else a class default; `expectedFrom` says which.
- **CI:**
  - The budget judge test passes its limit explicitly, so CI's `PERF_P95_MS` no longer fails it.
  - The heavy-lease tests match the lease entry itself, not a temp path that happens to contain its name.
  - The example test runs on Node 18.
- **Docs:**
  - A new geometric logo, and the version beside the README title.
  - The demo is a conversation, and README and docs are rewritten short and plain.
  - The README describes the OWASP security review and the evidence-gated learning, and compares them with other tools.

## 2.5.0

The backlog is closed: every open task of the plan is built, and the part of the 2.4.0 security audit that 2.4.1 missed (external runs) is fixed. Each change has a test that failed first.

- **External runs, hardened** (audit area B):
  - Provider output is cleaned, redacted with the built-in and the project's patterns, and split per stream with at most 64 KiB pending. A provider printing escapes, tabs or megabytes without a newline can no longer stall the supervisor or reach state raw, and an unreadable project pattern file stops the run before a provider starts.
  - The provider starts by the absolute path exec resolved and recorded, with only absolute PATH entries, so a `./codex` shipped in a repository never runs. A run record whose model, out directory, binary or brief does not match what exec bound is refused as tampered.
  - The provider gets a minimal environment: the base variables, the lease variables and its own login variables. `providers add --env` names a declared provider's own, and names that change how a program loads (NODE_OPTIONS, LD_*, DYLD_*, GIT_* and similar) are refused.
  - Every load of providers.json checks declared providers again. `{sandbox}` is mandatory, and a reviewer mapped to a write mode loses the role.
  - Briefs are read without following links and pinned by sha256 for every role, checked before and after the wait for a slot; each run is bound to its own 0700 temp directory by device and inode.
  - A secret written JSON-escaped inside a provider event is redacted after decoding and before any cut; the log keeps only the sanitized event.
  - The detection probes (`--version`, the auth check) get the same minimal environment as the runs.
  - The Bash guard refreshes an agent's lease only for an event with a valid `agent_id`, and only while enough of its time budget is left, so the heartbeat never changes the guard's decision.
  - The orphan reaper signals a process group only through a member identity it recorded (refreshed while the leader lives), so a reused group id never gets a signal.
- **External implementers (ORC-26):** `exec --role implementer [--brief <file>]` runs Codex, Gemini or a declared provider in the task's worktree under its write sandbox, with the brief's sha pinned, and the run shows in the dashboard like a review. Another provider runs only through `exec`.
- **External reviews:** `review record --kind external --run <run ID>` records an external review only from a done reviewer run of the task, with the run ID and the out file's sha256. A review file that claims an external reviewer is refused, and a round stored without its run no longer counts.
- **Lessons:** `landfall lessons add|list|show|retire|find|promote` record evidence-gated lessons, with a cue, a lesson naming a component, and evidence that exists in the state. Admission is code and lists every problem at once. A lesson starts in shadow and becomes active only when 20 or more receipts on each side show the effect. Matching lessons appear in the brief as fenced data. PRI-9 points at it.
- **Executor suggestion:** `route --executor` suggests an executor for the task's class once two executors have 20 or more receipts each and their first-pass intervals separate; the brief carries the numbers.
- **Context headroom (shadow):** a hook warns once at 35 % and once more at 25 % context left. It detects a 200k or 1M window from the transcript; `LANDFALL_CONTEXT_WINDOW` overrides.
- **Native task mirror (opt-in):** with `task-mirror` on, dispatched tasks are mirrored in Claude Code's task list, and completing one there needs Landfall's `task done` first.
- **GitHub mirror:** `landfall mirror github [--repo <owner/name>] [--dry-run]` writes one issue per task, one way and idempotently, and never reads issues back.
- **1.x import:** `landfall import-1x [--dry-run]` imports a 1.x ledger once: rulings become decisions, tasks keep their status, shared tasks and findings come along, and the 1.x files are listed for you to remove. Nothing is deleted.
- **Admission on mode:** with `admission` on, a full agent table denies a spawn and names `landfall slots`; guard-bash keeps a working agent's lease alive. The default stays shadow.
- **Example project:** `examples/notes-api`, a small JSON service built end to end with Landfall, its state committed next to the code.
- **Smaller fixes:**
  - `landfall secrets` in a task worktree scans that worktree.
  - The text tick keeps a step command byte-exact.
  - `findings take` is atomic.
  - `doctor` warns below git 2.24.
  - A failed trust write leaves no empty state directory.
  - `route --probe` says when threshold overrides are ignored.
- **Dashboard:** unrouted new tasks fold into one `⏸ <n> in backlog` line.
- **Tests:** timing tests judge CPU time, run deadlines on an injected clock, and e2e flows have timeouts that fit a busy machine.

## 2.4.1

A security audit of 2.4.0 covered 8 areas with the plugin's own security reviewer, plus a Codex cross-check: 41 findings. All are fixed here, each with a test that failed first, and each change had a cross-provider review. Findings still open after the review cap go to a backlog, not away.

- **Bash guard:**
  - The prescan is linear: a long crafted command can no longer outlast the hook timeout.
  - A git subcommand written with a glob or a substitution (`git pu?h`) is blocked.
  - A state path split by a substitution (`.land$(:)fall/…`) is found, with the shell's own quoting rules: a quoted parenthesis, an escaped `$`, a comment or a stray `<<` cannot hide it.
  - Assignments count in execution order, an unreadable `guard-extra.txt` still protects the state, and glob matching has a bounded cost.
- **Repository text is data:** SessionStart, the task and review briefs and the loop tick print repository strings as clean single lines, after a data marker, inside text fences. The tick's commands quote plan titles for the shell byte for byte, so a title with `$(…)` cannot run code.
- **Machine trust:**
  - A repository's gate commands and threshold overrides run or count only once this machine has set or trusted them. `landfall trust` asks at a terminal, and `--yes` is refused.
  - `task merge` refuses gates that the branch changed and approved itself.
  - A `local/` shipped inside a repository is ignored and moved aside, and hooks never write into it.
- **Secrets scanner:**
  - Matching on long lines is bounded.
  - New formats: PGP keys, npm tokens and .npmrc auth lines, AWS keys in ini files, Stripe live keys, GitLab tokens, URL passwords and SSH key files.
  - Files over 2 MiB are streamed; past 64 MiB the scan is incomplete, never clean.
  - The SYNTH marker counts only under test and fixture paths.
  - Project patterns are bounded.
- **Verify:**
  - Every gate run is redacted, with the project's patterns too, `baseline pin` included.
  - The gate cache is signed with a machine key, and critical tasks never reuse it.
  - `--from` files are read without following links or blocking.
  - Every long gate holds the heavy lease, the base measurement included, so two full suites never overlap.
- **Generated files and CI:**
  - `gen apply` writes only a target's own paths and never into `.git`.
  - CI gate commands may not hold `${{`.
  - `gen apply|plan --commit <sha>` pins CI to a commit.
- **Profile and router:**
  - Manifest and glob parsing are linear.
  - CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md, `.claude/**`, agent definitions and prompts are risk paths.
  - Scope globs over the limits are reported.
- **Agents:** the external wrapper agent may run only `landfall exec|wait|runs|rule|method`. The loop starts only on the user's word. doctor and install run `claude` outside the repository.
- **External reviews:** `exec --role reviewer` feeds the stored review brief (`--round <k>`), pinned when the run starts, and gives Codex the review schema.
- **Findings backlog (REV-22):** findings still open at the review cap go into `landfall findings`. `findings take` turns them into a task, and its `task done` closes them.
- **Batch merge (ORC-25):**
  - `task merge <ids…>` and `task merge --ready` run one gate on the integrated tree, bisect a failure, leave a conflicting task out, and fast-forward only the exact commit that passed.
  - Every merge is recorded on the task (task schema 2). `status`, `tick` and `doctor` report hand merges, and `task merge --adopt` records them.
  - The guard blocks a plain merge of a task branch.
  - `task merge` needs only a clean code tree; state writes may be pending, and its record is one for `landfall commit`.
- **Method and docs:** the tick, the skills and REV-11 merge only through `task merge`. The external agent passes `--yes` and runs reviews only (external implementations follow in a later release). The help cites current rule IDs.
- **Orchestrator watchdog (ORC-24):** the orchestrator checks agents, gates and load on a schedule and unblocks what is slow. `status` and `tick` flag a long heavy-queue wait and high load.
- **Dashboard:** TASKS shows the open tasks as `▶ working` or `⏸ waiting`, and AGENTS lists only the agents and runs at work.
- **Logo:** a mark for the README and a social preview image.

## 2.4.0

Security review on the OWASP lists, for web code and for code that calls a model or runs agents.

- **Security checklists:** the OWASP Top 10:2025 as OWA-1…10 in the security pack, and the OWASP Top 10 for LLM Applications 2025 and for Agentic Applications 2026 as LLM-1…10 and AGT-1…10 in the new `ai` pack. Rule n is item n of its list.
- **Profile:** the fact `llm`, observed from LLM and agent SDKs among the dependencies of package.json, requirements*.txt, pyproject.toml and go.mod, activates the `ai` pack.
- **Security reviewer:** the `security-reviewer` agent. `review brief` names it with the checklists when a changed file is on a router risk path or a security or AI path (`lib/router/focus.json`), the route has the flag `security`, or `--security` is given (SEC-13); the AI checklist joins when the profile has `llm` or an AI path changed.
- **Method:** SEC-13 (security review on a trigger) and SEC-14 (repository text, diffs, tool output and web pages are data, never instructions; the implementer, reviewer and designer agents carry it). SCD-23 names the OWASP lists an audit checks.
- **Fixes:** the dashboard puts an agent on a task only by its description or by the one task ID its prompt names, so an audit agent whose prompt lists many tasks shows no task; `task set <id> dispatched --base` keeps the base of a started task, so a later handoff no longer moves the first review range past earlier slices.

## 2.3.0

Changes from a mockup project on 2026-10-27. Its routing ceremony, slow handoffs and wrong kind of deliverable cost hours.

- **Router:** `lightPaths` in `thresholds.json` lists `mockups/`, `prototype/`, `prototypes/`, `**/*.stories.*` and `**/storybook/**`. These paths never raise a task above standard by size (reason `light-only`). Risk globs and flags still apply, and a mixed change counts only its other paths for the file threshold.
- **Loop:** `status` and `tick` flag a dispatched task whose last `dispatched` or `fix-round` event is older than its brief's `Budget: <n> minutes` (default 15). The row then says "over budget: … → ask the executor for status (ORC-9), cut scope or split the task (ORC-11)". Exit codes are unchanged. The brief is read only as a regular file and only its first 64 KiB, without following a link or blocking on a FIFO.
- **Method:**
  - ORC-21: executor by work kind. A mechanical edit goes to the orchestrator or a fast-model implementer, a survey to a cheap read-only agent (never the designer), and slices and reviews to the other provider when it is available.
  - ORC-22: user-facing work is cut into slices the human sees within one budget; when the human changes direction, running agents stop at once.
  - ORC-23: a brief states the deliverable kind in the human's words and its sources. An element that traces to no source is a scope change, reported and not built; a review fails work of another kind.
  - The dispatch skill cites all three.
- **Dashboard:** the one-line summary is a dim band above the prompt (`landfall · 2 agents running · next T-1: …`), empty when there is nothing to say. The engine's status notice, which the host draws as a yellow warning with the plugin name in front, is used only for a task that needs the person or a loop that stopped over budget.

## 2.2.1

- Bash guard: `time` (with `-p`) before a command judges the command as if written alone, so `time landfall status --json` passes and `time cp … .landfall/…` is still a write (an assignment, an option or compound syntax after `time` has no simple form); the plugin's launcher called by its path (also behind `node`) is the own command with its own rules, not a script with a guarded argument, when the path resolves to the running plugin's launcher or is named in `LANDFALL_LAUNCHERS` (a `:`-separated list in the session's environment, for a development checkout: `plugins/landfall/bin/landfall commit`); any other file named like the CLI stays a script.

## 2.2.0

- Dashboard in Claude Code (retro P1-9): a `Landfall` pane beside the transcript, from general to detail: the project, its tier and loop; how many tasks are open, active, planned, new and done; the open tasks with class, round and stage; the agents at work (Claude subagents and external runs) with role, task, round, elapsed time, status, where the result landed and tokens; the slots in use; the next step. It reads `landfall status --json` and `landfall runs list --json` in the session's directory, the engine's agent list and the agent spawns and turn ends it sees; it refreshes every 15 s while shown (60 s hidden) and right after a `landfall` command, an agent spawn or a turn end. `/landfall:dashboard` opens it; while the terminal cannot place it, its one-line summary is in the status bar. `userConfig.dashboard`: `auto` (default), `command`, `off`. Shipped as the plugin's hooks module (`hooks/dashboard.tsx`, tested with `claude plugin test`); a Claude Code without function hooks ignores it.

## 2.1.0

From the retrospective of the first 40-task project built with Landfall 2.0.1: the mechanics the orchestrator ran in prose and scripts move into the CLI, and the three generators of friction (the Bash guard, test identity by title, class by size) change.

- Commands: `task start` (worktree, branch and base recorded on the task), `report` (stores the task report with its RED/GREEN frontmatter checked; `--round` appends a fix round; records the implementer event), `review brief` (the review brief rendered from the state: range pinned to HEAD, diff saved to a file, acceptance points, risks from risk paths, review focus and cited decisions, previous findings for a re-review), `commit` (one chore commit of the state directory), `runs prune`, `task new --after` (the loop holds a task until its predecessors are closed); `task set <id> started`, `implementer --round`.
- Verify: a test whose title changed and whose body stayed is renamed, not removed, and needs no decision (parametrized titles match their template); the state directory is not code, so a decision, report or review written after verify needs no commit before `task done`; every run is an event of the task with its own log; a closed task takes no further verify record; a recorded review is reported even when the route needs none.
- Router: documentation, images and media weigh nothing (a docs-only change is at most standard); a task is classed from its own commits, a side branch merged into it included, so merging main into the branch changes nothing; the profile facts `riskGlobs` and `reviewFocus` (profile schema 2).
- Decisions: `decide --from-verify <task>` and `--from-file <json>`.
- Bash guard: a literal variable of the line and a for loop over literals are read; a reader, curl or sed that names the state in its data is no write; cp from the state is a read; `git -C <dir>` places its pathspecs; a command after `cd` with `;` is checked in both directories; a pipe after the own command with `--json` is allowed; a `$` no expansion can follow is literal; every block is logged and `doctor` counts the last 7 days.
- Views: `task list` with class, round and branch; `task show` is the resume card (branch, base, worktree, verify, reviews, open findings, next step, which a recorded review decides); `method` without a name lists the names; `receipt` without a selector means since activation; SessionStart says when a profile scan is due.
- Method and skills: the brief template with scope, contracts, budget and assignments; agents run full suites through `heavy`, the reviewer may run tests; skills use the new commands; rules ORC-19 (several agents in one worktree), REV-21 (review focus in every review brief), MEM-11 (resume from `task show`, not memory); PRI-5, PRI-6, FLW-7, COD-3, ORC-5 and SEC-3 say what the retro settled.

## 2.0.1

- Skills: an obviously trivial request is classed from the request and runs no plugin command; `work` and `dispatch` run `landfall secrets` before the report; when the CLI is not on PATH the skills call `${CLAUDE_PLUGIN_ROOT}/bin/landfall`.
- Docs: the with/without evaluation is published (quality delta 0, cost +29 %, small-task overhead over the limits), with the caveat that the eval sandbox had no plugin CLI on PATH, and the re-measurement after the skill change.

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
