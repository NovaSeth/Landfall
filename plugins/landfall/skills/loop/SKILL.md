---
# Generated from templates/skills/loop.md by scripts/gen-names.mjs; do not edit.
name: loop
description: Use when the user asks to keep working unattended through a plan, to resume after a break or a usage limit, or to schedule the next wakeup.
---

# Loop

Rules: `landfall rule FLW-4 FLW-5 FLW-9 ORC-9 ORC-11 ORC-20 ORC-24 MEM-4 MEM-5 MEM-10 MEM-11`.

1. Start: `landfall loop start` (change caps only on the user's word: `--caps wallMin=…,ticks=…,usd=…,rounds=…`). After a break or a compaction, read the state, not your memory: `landfall status`, then `landfall task show <id>` for each open task (MEM-11); inventory worktrees, locks and processes (MEM-4, MEM-5, MEM-10).
2. Tick: `landfall tick` (add `--plan <file>` for a plan). The exit says what to do (FLW-4); it lists machine watch rows (ORC-24).
3. ACTION (exit 0): do the steps it prints, then tick again. Fill free machine slots with the next independent task (ORC-11); ask a long-running agent for a 5-line status (ORC-9). Merge what is verified and approved before dispatching more.
4. WAIT (exit 3): schedule one ScheduleWakeup after NEXT_TICK seconds with the fixed prompt tick printed, nothing else in it.
5. DONE (4), STALLED (5), BUDGET (6): the loop ended. Schedule no wakeup, cancel a pending one, report the exit (FLW-5). `landfall loop stop` ends a running loop.
6. A task in progress always has a live next step; otherwise it returns to todo or is blocked with what unblocks it (FLW-9). A task that must follow another is created `landfall task new "<title>" --after <ids> --yes`: the tick holds it until they close (ORC-20). State written during the loop goes to git with `landfall commit --yes`, once per task.
