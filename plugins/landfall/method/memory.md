# Memory and decisions

**Purpose:** what the project remembers and how work resumes. **Reads:** orchestrator. **When:** after any event worth remembering; resuming after a break, a usage limit or compaction.

**Section map**
- §Records — same-turn updates, append-only decisions, collaboration rules.
- §Resume — resume notes, resume order, processes still running.
- §Context — reading state cheaply, the always-loaded instruction file, historical records.

## Core

### Records
**MEM-1.** Update each memory element (task state, decisions, lessons, the orchestrator handbook, collaboration rules) in the same turn as the event, before the next dispatch and before ending the reply.
**MEM-2.** Decision records are append-only: a correction is a new decision that supersedes the old one, and MUST NOT edit an old record's content; quote the human's words verbatim as the source.
**MEM-3.** Record a human preference in the collaboration rules in the same turn as "rule — why (date or decision)"; one that changes how work is done also gets a decision with a verbatim quote; an entry without a why does not apply.

### Resume
**MEM-4.** Before a break, the end of a session or a lane handover, write a resume note: work in progress, worktrees, background processes, open findings.
**MEM-5.** On resume (usage limit, compaction, new session, restart) read the orchestrator handbook first, inventory worktrees, locks and processes, read result files and 5-line statuses instead of full logs, then run the CLI `tick`.
**MEM-9.** Give every tool the work depends on (supervisor, loop, log monitor, sleep blocker) a status step and a start step in the resume procedure.
**MEM-10.** Re-dispatch a task only after checking that its background process is no longer running.

### Context
**MEM-6.** Read state in summary form (CLI `status`, `tick`) and find a decision's reasoning by its ID; MUST NOT load whole logs or every decision into context.
**MEM-7.** Keep the project's always-loaded instruction file to commands, Global Constraints, Review Focus, roles, the definition of done, git rules and a knowledge map (situation → file §section), under 10 KB by default.
**MEM-8.** Briefs, reports, reviews and diffs of finished tasks are a historical record: MUST NOT edit them afterwards; rewriting git history needs a human decision, because recorded SHAs break.
