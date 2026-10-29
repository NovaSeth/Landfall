# Orchestration

**Purpose:** roles, briefs, report statuses, supervision, branches and external executors. **Reads:** orchestrator; executors read §Roles. **When:** dispatching a task, receiving a result, supervising agents.

**Section map**
- §Roles — shipped agents and their limits, brief-first behavior, context economy.
- §Brief — content of task, review and shared briefs; absolute paths, base SHA.
- §Status — report statuses, the orchestrator's reaction, no local patches, verifying claims.
- §Supervision — status requests, stuck or stopped agents, throughput.
- §Branches — updating task branches, merge conflicts, stash, first push.
- §External executors — running another provider.

## Core

### Roles
**ORC-1.** Use the shipped agents by role: implementer (implementation, fixes, TDD), reviewer (reviews and scoped re-reviews), designer (strongest model: specs, shared tasks, concurrent code and its review), external (runs another provider's CLI).
**ORC-18.** An implementer never changes shared parts outside a shared task, never merges and never pushes; a reviewer never changes code.
**ORC-2.** An agent reads its brief first, takes values literally, writes its report to the file the brief names, replies in 5 lines (status, commits or result, tests, concerns, report path) and MUST NOT spawn subagents.
**ORC-3.** Give a subagent paths and rule IDs, never pasted documents or session history; read the method by rule (CLI `rule`) or by section.
**ORC-19.** Several agents in one worktree get disjoint file lists and one shared vocabulary (the names, headings and contract terms that must agree) in the brief, and run no git of their own; the orchestrator commits.

### Brief
**ORC-4.** A task brief (`templates/brief.md`) MUST contain the executor and task class, worktree, branch, base SHA and dependency state, file scope, cause chain as `file:line`, numbered acceptance points, RED tests, who runs E2E, gate commands with worker limits, rule IDs and the report path.
**ORC-15.** Write every path in a brief as an absolute path, and mark an authoring task as such, because a brief full of `file:line` reads like a review request.
**ORC-16.** Before cutting a brief, fast-forward the main checkout from the remote and put the resulting base SHA in the brief.
**ORC-20.** A dependency between tasks is state (`task new --after <ids>`), never a sentence in a brief: the loop holds the task undispatched until every predecessor is closed, and the brief then takes the merged base.
**ORC-21.** Executor by work kind: a mechanical edit (≤ 30 LOC, no logic) goes to the orchestrator (PRI-5) or a fast-model implementer (3-line brief); a survey goes to a cheap read-only agent, never the designer; with another provider (auth ok in CLI `providers`) give it slices and reviews (`external`), the designer: specs, plans, shared parts.
**ORC-22.** Cut user-facing work (UI, docs a human reads) into vertical slices whose result the human can see within one budget (default 15 min), and end every dispatch with something viewable; when the human changes direction, stop the running agents at once (TaskStop) and re-plan before dispatching again.
**ORC-23.** A brief states the deliverable kind in the human's own words ("static mockups", "working feature") and its sources: their requests and supplied artifacts (screenshots, a reference repo). Each built element traces to a source; one that does not is a scope change (PRI-17): report it, do not build it. A review fails work of another kind.
**ORC-24.** Be proactive and keep the work flowing: while agents, external runs or gates work in the background, check them on a schedule (about every 10 minutes, the CLI `status` and `slots`), not only on completion notices; an executor past its budget gets a status request (ORC-9), one idle or hung is stopped and re-planned, and a step that takes too long changes the process (batch the merges, fewer parallel agents while a gate runs, smaller slices).
**ORC-25.** Merge ready tasks only with `task merge`, several at once as one batch (`task merge <ids…>` or `--ready`): one gate run on the integrated tree, bisected on failure; a merge by hand is a breach that `status` reports, and `task merge --adopt` records it after a gate.
**ORC-5.** A review brief MUST require read-only mode and gives the commit range pinned by sha (never "the newest commits"), the task brief, the author's report, the diff saved to a file (`git diff -U10 A..B`), the acceptance points and a targeted risk list; the CLI `review brief` renders it from the state.
**ORC-6.** A shared brief per task kind holds its binding rules and a task brief references it in one sentence; an error that recurs in reviews a third time (default 3) becomes a shared-brief section with a correct example, a wrong one and a test.

### Status
**ORC-7.** A report ends with one status: DONE (gate green → review), DONE_WITH_CONCERNS (→ decide, or pass the concerns to the review brief), NEEDS_CONTEXT (contract or data missing → complete the brief or open a shared task), BLOCKED (→ remove the obstacle, decide, or mark the task blocked).
**ORC-17.** MUST NOT patch a missing contract or shared part locally: stop with NEEDS_CONTEXT and name the gap (file, field, consumer).
**ORC-8.** MUST NOT accept a report or an agent's message without verification: check `git log --oneline origin/main..HEAD`, `git status --short`, the diff of shared files and live processes; check a suspiciously fast report or one without RED/GREEN yourself.

### Supervision
**ORC-9.** Send an agent working longer than the threshold (default 20 min) a 5-line status request (done, now, waiting on, files outside scope, ETA) and record it, so the next threshold counts from it.
**ORC-10.** No answer → find the cause (last commit, child processes, locks, log age); stop an agent that hangs or drifts (files outside scope, work outside the brief, over 2× the status threshold without a commit) and resume with a correction; an agent stopped by the human is not resumed: finish from its diff or hand its state to a new agent.
**ORC-11.** Fill free machine slots at once with the next independent task instead of waiting for reviews and runs; batch small tasks of one area into one package: one implementer, one commit per task, one review.

### Branches
**ORC-12.** Update a task branch only with `git merge origin/main`, then reinstall from the lockfile and typecheck; MUST NOT rebase after review, because recorded SHAs change; the implementer resolves a merge conflict only within the brief's scope, otherwise reports NEEDS_CONTEXT.
**ORC-13.** MUST NOT use `git stash`, because it is shared by all worktrees; commit work in progress instead; set `git config branch.autoSetupMerge simple` and push the first time with `git push -u origin HEAD`.

### External executors
**ORC-14.** Run another provider only through the CLI `exec`, configured by flags, never by editing that provider's global configuration: read-only for reviews, workspace-write for fixes; an external run does not commit: the orchestrator reviews the diff (assertions, scope, shared parts), verifies and commits with both models' trailers.
