---
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Command not on PATH: prefix it with `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `{{bin}} rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19`.

1. Worktree: `{{bin}} task start <id> --slug <s> --yes` (PRI-4). Several agents in one worktree: disjoint files and a shared vocabulary in the brief (ORC-19).
2. Brief: `{{bin}} brief <id> --write --yes`; fill every `<…>`, the budget too (PRI-18, ORC-4). Agent by role (ORC-1): `{{plugin}}:implementer` for code and fixes, `{{plugin}}:designer` for specs, shared parts and concurrent code.
3. Record: `{{bin}} task set <id> dispatched --executor <name> --base <sha> --yes`; the agent gets the brief path only, never the history (PRI-3, ORC-3). It runs `{{bin}} secrets` (exit 0) before its report.
4. Its report: `{{bin}} report <id> --from <file> --yes` stores it and records the event (a fix round: `--round <k>`) (ORC-7).
5. Check it: commits, clean tree, scope, red/green (ORC-8, FLW-6); then in the worktree `{{bin}} verify <id> --yes`. On a fail: `task set <id> fix-round --round <k> --addressed <n> --open <n>`.
6. Review as `{{bin}} brief <id>` says (none; fresh `{{plugin}}:reviewer`; or `{{plugin}}:external`): `{{bin}} review brief <id> --write --yes`, the `review` skill, `{{bin}} review record <id> --from <file> --yes`.
7. At most 2 fix rounds; then `{{bin}} decide --kind review-close --task <id> --remaining <blocking IDs> --yes` with title, why and cost.
8. Finish: `{{bin}} task done <id> --yes`, `{{bin}} task merge <id> --yes`, `{{bin}} commit --yes`. After a compaction: `{{bin}} task show <id>` (MEM-11).
