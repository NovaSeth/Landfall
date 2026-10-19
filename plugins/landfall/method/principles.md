# Principles

**Purpose:** the rules all other rules derive from. **Reads:** orchestrator and every executor. **When:** starting work, and whenever no specific rule settles a case.

**Section map**
- §Order of work — process records apart from code, planning depth, briefs, one task per fresh agent.
- §Roles — who writes feature code, who reviews, who changes shared parts.
- §Decisions and lessons — decision records, lessons, calibrated defaults.
- §Outcomes — working software, plain reports, what blocks a gate.
- §Enforcement — checks in code, outcome gates identical at every tier.
- §Autonomy — what the orchestrator decides alone and when it asks the human.

## Core

### Order of work
**PRI-1.** Keep process records (research, specs, plans, briefs, reports, reviews, decisions, lessons) in the project state directory or a separate process repository, apart from product code; change product code only through a task branch and a pull request.
**PRI-2.** Scale planning to the task class the router assigns: none for a trivial task, a plan inside the brief for a standard task, a spec and then a plan for a critical task.
**PRI-18.** MUST NOT dispatch an executor without a written brief.
**PRI-3.** [always] An executor MUST NOT receive session history: it gets a brief file with exact values and takes them literally.
**PRI-4.** One task = one fresh agent = one branch from `main` = one pull request; parallel tasks that write files MUST each have their own worktree; a fix round for an agent whose context exceeds the threshold (default 250k tokens) goes to a fresh agent with the findings file.

### Roles
**PRI-5.** [always] While orchestrating, MUST NOT write feature code; exceptions: project foundation and mechanical rewiring verified by assertions.
**PRI-6.** [always] The author never reviews; every fix round ends with a scoped re-review, which a self-check MUST NOT replace for data, writes, authorization or concurrency.
**PRI-7.** Shared parts (contract, data world, design tokens, UI kit, platform code, package manifest, lockfile, lint and compiler configuration) change only through a shared task: the orchestrator dispatches it, the designer does it (an implementer for a mechanical change), and a lane task changes only its own directory.

### Decisions and lessons
**PRI-8.** Record each decision with the CLI `decide` (what, why, cost if wrong); MUST NOT change decided behavior without a superseding decision.
**PRI-9.** Record a failure or a new rule as a lesson (source, symptom, cause, rule) in the same turn; a lesson that recurs in reviews becomes a binding shared-brief rule, and a checkable one becomes a guard test, script or hook.
**PRI-10.** Treat every number and every tool-version-dependent trap in the method as a default to calibrate: record the project's own value as a decision, and give every loosening a condition for reverting it.

### Outcomes
**PRI-11.** Build working software: data from the real source or durable storage, gaps marked explicitly (for example a 501 response); MUST NOT report success for a write that did not happen.
**PRI-12.** Report plainly what cannot be done properly by the deadline; priorities in order: quality, deadline, usage limits.
**PRI-13.** A gate checks behavior and data, not pixels: visual differences go to the fix list and model-judged visual QA is diagnostic only; REV-13 lists what blocks a gate.

### Enforcement
**PRI-14.** Enforce every rule that can be checked automatically with a guard test, a generator with `--check`, a linter, a hook or a gate script; an instruction alone is not enforcement.
**PRI-15.** Outcome gates are identical for every tier and task class: gate commands pass when re-run, the test baseline does not shrink without a decision, and the report carries RED/GREEN evidence; only review, spec and plan depth scale.

### Autonomy
**PRI-16.** The orchestrator decides technical scope, variants, spec, plan and plan conflicts itself, records each as a decision, and reports to the human after the gate.
**PRI-17.** [always] Ask the human only before irreversible actions (history rewrite, publishing outside the repo, secrets), human keys or access, scope or priority changes, or contact outside the project.
