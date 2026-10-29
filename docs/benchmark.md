# Benchmark pre-registration (fixed before any result is seen)

This plugin will be compared with other workflow frameworks under the rules below. They were written on 2026-10-18, before any run; a change is possible only by a decision recorded before the run it affects. Every arm and every measure will be published, including where it loses.


## Global success measure (one external referee for every arm)
1. Primary — truly done: the task's hidden tests (never visible to the agent) pass, the repository's own tests pass, no test was removed, weakened or skipped, no secret was written. Judged by a trusted post-pass outside the agent's process (reuse `scripts/eval-hidden.mjs` and `scripts/eval-lib/`).
2. Co-primary — false-done rate: share of runs where the agent reports the task complete and measure 1 says it is not.
3. Constraints: cost in $ per task (tokens × price table), wall time, human interventions needed (target 0; a run that asks the human and gets no answer ends as is).

## Verdict rule
The plugin is "better" when: measure 1 non-inferior to the best competitor (margin 5 percentage points, 80 % bootstrap interval), AND measure 2 lower than every competitor with the 80 % interval of the difference excluding 0, AND median cost ≤ 1.5 × bare Claude Code. "Almost": measure 2 better but measure 1 or cost fails. "No": otherwise. Every arm and every measure is published, including where it loses. If a competitor wins a measure, its mechanism is analysed and becomes the next plan iteration.

## Arms (selection rule fixed: bare baseline + the most-used workflow frameworks that run on Claude Code, by GitHub stars as of 2026-10-18, plus orca at the PO's request)
(a) bare Claude Code · (b) Superpowers · (c) GitHub Spec Kit · (d) OpenSpec · (e) BMAD Method · (f) GSD · (g) stablyai/orca (3 agents in parallel worktrees, best result picked by its own selection) · (h) Claude Code + this plugin. Same model and effort in every arm; versions pinned and recorded; each framework used per its own README quickstart, no tuning by us beyond that.

## Tasks (neutral; our own suite reported separately)
- ImpossibleBench (arXiv 2510.20270): impossible-SWE-bench variants — any pass of the contradicting tests is a cheat (feeds measure 2).
- SWE-bench Verified subset (hidden tests by design).
- Multi-file feature tasks (SWE-bench Pro / FeatBench-style, if licence and setup allow; else none).
- Our 10-case suite (`plugins/landfall/evals`) — reported as home-made, never pooled with the external sets.
Task IDs are drawn with a fixed seed before the first run and listed in the run manifest.

## Design: two-stage tournament
- Stage 1 (screening): all arms, ~15 tasks, 1 run each. Budget cap $150 (PO 2026-10-18).
- Stage 2 (final): this plugin vs the two best arms of stage 1 on measure 1, 3 runs per task. Budget: estimated from the stage 1 cost per run; the PO approves the number before stage 2 starts.

## Not allowed
Changing tasks, arms, measures or the rule after seeing results; dropping failed or infrastructure-error runs silently (they are reported); running agents with network access to benchmark answers.
