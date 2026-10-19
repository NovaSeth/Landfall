---
name: loop
description: Use when the user asks to keep working unattended through a plan, to resume after a break or a usage limit, or to schedule the next wakeup.
---

# Loop

Rules: `{{bin}} rule FLW-4 FLW-5 FLW-9 ORC-9 ORC-11 MEM-4 MEM-5 MEM-10`.

1. Start: `{{bin}} loop start` (change caps only on the user's word: `--caps wallMin=…,ticks=…,usd=…,rounds=…`). After a break, check `{{bin}} loop status` first and inventory worktrees, locks and processes (MEM-4, MEM-5, MEM-10).
2. Tick: `{{bin}} tick` (add `--plan <file>` for a plan). The exit says what to do (FLW-4).
3. ACTION (exit 0): do the steps it prints, then tick again. Fill free machine slots with the next independent task (ORC-11); ask a long-running agent for a 5-line status (ORC-9).
4. WAIT (exit 3): schedule one ScheduleWakeup after NEXT_TICK seconds with the fixed prompt tick printed, nothing else in it.
5. DONE (4), STALLED (5), BUDGET (6): the loop ended. Schedule no wakeup, cancel a pending one, report the exit (FLW-5). `{{bin}} loop stop` ends a running loop.
6. A task in progress always has a live next step; otherwise it returns to todo or is blocked with what unblocks it (FLW-9).
