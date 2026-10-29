---
# Generated from templates/skills/dispatch.md by scripts/gen-names.mjs; do not edit.
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Off PATH: prefix `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `landfall rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19 ORC-21 ORC-22 ORC-23 ORC-24`.

1. Worktree: `landfall task start <id> --slug <s> --yes` (PRI-4). Parallel: disjoint files (ORC-19).
2. Brief: `landfall brief <id> --write --yes`; fill every `<…>` (PRI-18, ORC-4, ORC-23). `landfall:implementer` (code), `landfall:designer` (specs); model by kind, size (ORC-1, ORC-21). Course change: TaskStop first (ORC-22).
3. Record: `landfall task set <id> dispatched --executor <name> --base <sha> --yes`; it gets the brief path only (PRI-3, ORC-3), runs `landfall secrets` (exit 0) before its report.
4. Report: `landfall report <id> --from <file> --yes` (fix round: `--round <k>`, ORC-7).
5. Check: commits, scope, red/green (ORC-8, FLW-6); `landfall verify <id> --yes`; fail: back to it.
6. Review per `landfall brief <id>` (none, `landfall:reviewer`, `landfall:security-reviewer` or `landfall:external`): `landfall review brief <id> --write --yes`, record as in 3 (`--executor <reviewer>`), `landfall review record <id> --from <file> --yes`, external: `--kind external --run <run ID>`.
7. Needs fixes: a fix brief; past 2 rounds `landfall decide --kind review-close --task <id> --remaining <open finding IDs> --yes`.
8. Finish: `landfall task done <id> --yes`, `landfall task merge <ids…> --yes` (all ready: `landfall task merge --ready --yes`), `landfall commit --yes`. Compacted: `task show <id>` (MEM-11).
9. With work in the background, check it every ~10 min and unblock it (ORC-24).
10. `task-mirror` on: TaskCreate `<id> <title>`; complete it after `task done`.
