# Flow and loop

**Purpose:** stages from idea to release, the orchestrator loop and task state. **Reads:** orchestrator. **When:** choosing the next step, on every loop tick, when recording task state.

**Section map**
- §Stages — order and artifacts, when discovery runs, routing and admission.
- §Loop — tick, exits, wakeups, accepting results.
- §Task state — who writes it, when a task closes, live next steps.

## Core

### Stages
**FLW-1.** Pass the stages in order (discovery when needed, spec, plan, brief, implementation, verify, review, merge, area gate, release), each ending with its artifact; skip a stage only when the route or tier does not require it, or with a decision.
**FLW-2.** Run discovery for a new product or an MVP scope decision; start work on an existing product with a clear backlog from the spec.
**FLW-3.** Route every task with the CLI `route` before work and dispatch the executor it names once the scheduler admits it; a trivial or standard task outside a loop may run inline, with the same verify and the review its class requires.

### Loop
**FLW-4.** [always] Each tick runs the CLI `tick` and does the listed steps: ACTION → act, tick again; WAIT → wake after `NEXT_TICK`; DONE, STALLED, BUDGET → stop, report.
**FLW-5.** [always] The wakeup prompt is fixed and carries no task state; after DONE, STALLED or BUDGET, MUST NOT schedule another wakeup.
**FLW-6.** Accept a result only after checking the exit code AND the count of results (tests, files, rows); exit 0 with zero tests or an empty report is not success.

### Task state
**FLW-7.** Write task state only through CLI commands and only with evidence (pull request, commit, gate result); MUST NOT edit state files by hand, because the loop reads only what the commands write.
**FLW-8.** [always] A task closes only after verify passed for the current HEAD; a model's prose never closes a task.
**FLW-9.** Every new piece of work (fix, gate, rewiring, follow-up, shared task) gets a task at once, and every task in progress has a live next step (a running agent, a queued run, a pending review); without one it returns to todo or is marked blocked with what unblocks it.
