---
# Generated from templates/skills/dispatch.md by scripts/gen-names.mjs; do not edit.
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Off PATH: prefix `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `landfall rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19 ORC-21 ORC-22 ORC-23 ORC-24 ORC-26`.

1. `landfall task start <id> --slug <s> --yes` (PRI-4). Parallel: disjoint files (ORC-19).
2. Brief: fill `<…>` in a file; `landfall brief <id> --from <file> --yes` (PRI-18, ORC-4, ORC-23). `landfall:implementer` (code), `landfall:designer` (specs); model: kind, size (ORC-1, ORC-21); other providers: `landfall exec` (ORC-26). Redirect: TaskStop (ORC-22).
3. Record: `printf %s <token> | landfall task set <id> dispatched --executor <name> --base <sha> --yes --token -`; it gets the brief path only (PRI-3, ORC-3), runs `landfall secrets` (exit 0) before its report.
4. Agents store outputs (`landfall report`, review record, ORC-7); check commits, scope, red/green (ORC-8, FLW-6). Review per `landfall brief <id>` (none, `landfall:reviewer`, `landfall:security-reviewer` or `landfall:external`): `landfall review brief <id> --write --yes`, record as in 3 (`--executor <reviewer>`); external: `landfall review record <id> --kind external --run <run ID> --yes` (token: 3). Fixes: brief; after 2 rounds `landfall decide --kind review-close --task <id> --remaining <open finding IDs> --yes`.
5. Approved, all classes, one batch once in-flight tasks settle or oldest approval waits 45 min: `landfall train --ready --yes` or `landfall train <ids…> --yes` (ORC-25, FLW-8). Lone, none in flight: `landfall train <id> --yes`. Commit; verify failed: back to the implementer. Compacted: `task show <id>` (MEM-11).
6. Background: every ~10 min (ORC-24).
7. `task-mirror` on: TaskCreate `<id> <title>`; complete after `close`.
