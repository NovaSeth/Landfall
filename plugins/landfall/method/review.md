# Review and gates

**Purpose:** review, findings, fix rounds, the task gate and the area gate. **Reads:** reviewer, orchestrator; implementer reads §Fix rounds. **When:** reviewing, dispatching a fix round, merging, closing an area.

**Section map**
- §Review — shape, typed record, severities, reproduction, rejection grounds.
- §Fix rounds — findings file, report section, scoped re-review, self-verification limits, the two-round breaker, cross-cutting defects, disputes.
- §Task gate — gate composition, re-verification and merge.
- §Area gate — cross-review, full E2E, what blocks, the PO report.
- §Evidence — regressions, flaky tests.

## Core

### Review
**REV-1.** A review has a fixed shape without preamble (`templates/review.md`): compliance per acceptance point with `file:line`, strengths, findings Critical / Important / Minor, shared-part needs, verification scope (taken from the report vs run yourself), context (files read, rule IDs), verdict.
**REV-17.** Record the review with the CLI `review record`, which accepts only the typed result `{verdict: approved | needs-fixes, findings: […]}`; the Markdown text is a rendering and closes nothing.
**REV-2.** Severity: Critical = data loss or corruption, a security hole, an outage; Important = a functional defect or a violation of a rule or a Global Constraint; Minor = everything else.
**REV-3.** The reviewer MUST reproduce every Critical and Important finding (a short test or script with its output).
**REV-4.** The reviewer rejects a dirty tree or a Global Constraint violation and cites rules by ID, not by their text.

### Fix rounds
**REV-5.** A needs-fixes review becomes a findings file a fresh agent can act on without history: binding rules first, a reference implementation, and per Important finding `file:lines`, what, why, the fix pattern and the exact test assertion; Minor findings form one batch item.
**REV-18.** The executor of a fix round appends a section to its report: problem → fix → RED/GREEN → gate.
**REV-6.** A scoped re-review covers only the round's diff: it marks each previous finding ADDRESSED or NOT ADDRESSED by repeating its reproduction on the new code, and seeks new problems only among the risks the fix could introduce.
**REV-19.** A re-review brief carries the orchestrator's evidence: the regression test fails on the old code and passes on the new, with the gate's numbers.
**REV-20.** The orchestrator may verify a mechanical or UI fix round itself and record that; for data, writes, authorization or concurrency it MUST NOT, at every tier and in gate rounds too (PRI-6).
**REV-7.** After two fix rounds (default 2), MUST NOT start a third: decide the remaining non-critical findings with a decision or escalate to the user; Critical findings are exempt and go to the strongest executor; Minor findings go to the deferred list with a target and a task.
**REV-8.** A finding that shows a defective pattern, not one spot, is checked in every lane and fixed once in a cross-cutting round; a defect seen in two or more places gets one shared fix; MUST NOT serialize lanes behind that fix.
**REV-9.** An implementer does not fix a finding it disputes: it describes it under `DISPUTED` in its report, and the orchestrator decides it before the next round; a disputed round does not count toward the breaker.

### Task gate
**REV-10.** Before review: gate commands green (typecheck, lint, tests), the secrets scan run without a pipe with its exit code checked, branch E2E when the brief requires it, a clean tree and one commit per step.
**REV-11.** Before merge the orchestrator itself merges `origin/main` into the task branch and re-runs verify, because a report from an older base guarantees nothing; merge with a squashed pull request whose title follows the commit style; without a remote, merge locally with `git merge --no-ff` and a decision.

### Area gate
**REV-12.** Open the area gate when every task of the area is in `main`: cross-review of the area diff by another provider's model (fallback: a fresh reviewer with a different prompt), each remark verified in code before acceptance; full E2E on a fresh build with behavior and data assertions; one fix round after it, closed by a scoped re-review.
**REV-13.** Only a functional defect, wrong data, an unusable screen, or a Critical or High security finding blocks a gate; everything else goes to the list.
**REV-14.** After each area gate write a report for the PO in the product's language: one-line status (gate, pull request with SHA, what is open), highlights, what was done, test results per suite and area (test or application failure), defects caught by tests, limits and risks, decisions, how to run, what the PO must do.

### Evidence
**REV-15.** Decide a regression by comparing with `main` in the same environment at the same time, not by replaying one step; a failure within a fraction of a second is usually the harness, so read the log before dispatching fixes.
**REV-16.** Quarantine a flaky test only with a decision that has a deadline and a marker in the code, listed in the gate report; MUST NOT quarantine Review Focus tests.
