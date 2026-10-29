---
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Off PATH: prefix `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `{{bin}} rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19 ORC-21 ORC-22 ORC-23 ORC-24 ORC-26`.

1. Worktree: `{{bin}} task start <id> --slug <s> --yes` (PRI-4). Parallel: disjoint files (ORC-19).
2. Brief: `{{bin}} brief <id> --write --yes`; fill every `<…>` (PRI-18, ORC-4, ORC-23). `{{plugin}}:implementer` (code), `{{plugin}}:designer` (specs); model by kind, size (ORC-1, ORC-21); another provider only via `{{bin}} exec` (ORC-26). Course change: TaskStop (ORC-22).
3. Record: `{{bin}} task set <id> dispatched --executor <name> --base <sha> --yes`; it gets the brief path only (PRI-3, ORC-3), runs `{{bin}} secrets` (exit 0) before its report.
4. Report: `{{bin}} report <id> --from <file> --yes` (fix round: `--round <k>`, ORC-7).
5. Check: commits, scope, red/green (ORC-8, FLW-6); `{{bin}} verify <id> --yes`; fail: back to it.
6. Review per `{{bin}} brief <id>` (none, `{{plugin}}:reviewer`, `{{plugin}}:security-reviewer` or `{{plugin}}:external`): `{{bin}} review brief <id> --write --yes`, record as in 3, `{{bin}} review record <id> --from <file> --yes`, external: `--kind external --run <run ID>`.
7. Needs fixes: a fix brief; past 2 rounds `{{bin}} decide --kind review-close --task <id> --remaining <open finding IDs> --yes`.
8. Finish: `{{bin}} task done <id> --yes`, `{{bin}} task merge <ids…> --yes` (all ready: `{{bin}} task merge --ready --yes`), `{{bin}} commit --yes`. Compacted: `task show <id>` (MEM-11).
9. With work in the background, check it every ~10 min and unblock it (ORC-24).
10. `task-mirror` on: TaskCreate `<id> <title>`; complete it after `task done`.
