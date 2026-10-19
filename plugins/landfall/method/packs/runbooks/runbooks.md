# Runbooks

**Purpose:** short procedures for situations outside the usual task cycle, most of them once software is live. **Reads:** orchestrator; an executor whose brief cites a runbook rule. **When:** a hotfix, a revert, a production incident, a blocked task, a plan change, a database migration, a performance regression, a flaky test, a merge conflict.

**Section map**
- §Hotfix and revert — branch from the release tag, mandatory re-review, revert through a pull request.
- §Production incident — stop the damage, facts, revert or hotfix, follow-up.
- §Blocked task and plan change — blocked state, fallback path, one question, tasks in flight.
- §Database migration — three pull requests, reversibility, tests of each step.
- §Performance and flaky tests — measuring against main, confirming flakiness.
- §Merge conflicts — scope, generated files, verification, tool caches.

## Pack: runbooks

### Hotfix and revert
**RUN-1.** Branch a hotfix from the release tag (`git worktree add <dir> -b hotfix/<slug> <release-tag>`); its scoped re-review is mandatory whatever the fix, and the area gate runs afterwards on `main` (default within a day).
**RUN-2.** A hotfix brief is minimal: the symptom, the cause as `file:line`, the regression test (red on the tag, green after the fix), a scope limited to the fix, and the gate.
**RUN-3.** Release from the hotfix branch only after the secrets scan over `<release-tag>..HEAD` is clean, then merge the hotfix branch into `main` through a pull request, never by cherry-pick.
**RUN-4.** Revert a change on `main` with `git revert` (`-m 1` for a merge commit) on a branch from `origin/main`, through a pull request with the task gate (TRP-6); reintroducing the change is a new task with a new brief.
**RUN-5.** Reverting code that came with a migration does not revert the data: handle the schema and data by the migration rules (RUN-13, RUN-14).

### Production incident
**RUN-6.** In a production incident, first stop the damage (disable the feature, pause deployments, stop agents in the affected area) and collect the facts, then fix; a human with access performs every action in production.
**RUN-7.** Record the facts at once as a lesson: symptom, start time, scope (users, data) and the last deployment (`git log --oneline <previous-tag>..<tag>`); a leaked secret follows the leak procedure: rotate first, never record the value (security pack, SCD-33).
**RUN-8.** Revert when the cause is in the last deployment and a revert is safe, otherwise hotfix; record the choice as a decision with its cost if wrong.
**RUN-9.** After recovery, add the regression test, report to the PO and record a lesson with the root cause and the new rule or test it produced.

### Blocked task and plan change
**RUN-10.** Mark an externally blocked task as blocked with what unblocks it (person, system, date), build the part that does not depend on the blocker against a stub that follows the contract, and leave questions in code as `TODO(<task>): <question>`.
**RUN-11.** Ask the human one combined question with options and a default, and fill the free slot with the next independent task.
**RUN-12.** Record a plan change in the plan file and in a decision; cancel the tasks in flight that it affects and dispatch new briefs, never rewrite a brief in flight.

### Database migration
**RUN-13.** Run a database migration as a shared task in three pull requests: expand (new columns or tables, code writes to old and new), migrate (move data in idempotent, resumable batches), contract (remove the old only when no deployed code reads it).
**RUN-14.** Each migration step meets the backend-data pack rules SVC-21 and SVC-22 (reversible, or irreversible by a decision with the PO's consent, tested up → down → up on a schema copy), and every migration pull request gets a scoped re-review.

### Performance and flaky tests
**RUN-15.** Measure performance on the branch against `main` on the same machine with the same command (default 5 runs, median, through the CLI `heavy`); the threshold comes from the spec's budget, otherwise default 10% recorded as a decision.
**RUN-16.** A breach of the budget or threshold is an Important finding with a fix round; a regression already on `main` is reverted or gets a fix task.
**RUN-17.** Confirm a flaky test with 10 sequential runs on one commit (default) before a quarantine (REV-16); a flaky test that guards writes or a Review Focus scenario gets a top-priority fix task, and the gate waits.

### Merge conflicts
**RUN-18.** Resolve a merge conflict only within the brief's scope and regenerate generated files with their generator; outside the scope run `git merge --abort` and report NEEDS_CONTEXT with the files (ORC-12).
**RUN-19.** Verify a conflict resolution with `git show --remerge-diff <merge-sha>`; a resolution that touches data, writes, authorization or concurrency gets a scoped re-review.
**RUN-20.** After resolving a conflict, clear the tools' caches (linter, typecheck, bundler) before the gate. Symptom: lint reports a conflict marker in a clean file.
