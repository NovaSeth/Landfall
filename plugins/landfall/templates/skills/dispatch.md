---
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Command not on PATH: prefix it with `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `{{bin}} rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19 ORC-21 ORC-22 ORC-23 ORC-24`.

1. Worktree: `{{bin}} task start <id> --slug <s> --yes` (PRI-4). Several agents: disjoint files (ORC-19).
2. Brief: `{{bin}} brief <id> --write --yes`; fill every `<…>`, budget too (PRI-18, ORC-4); state the deliverable kind and its sources (ORC-23). `{{plugin}}:implementer` for code, `{{plugin}}:designer` for specs; executor, model by kind and size (ORC-1, ORC-21); another provider only through `{{bin}} exec` (ORC-24). Viewable slices; on a change of direction TaskStop first (ORC-22).
3. Record: `{{bin}} task set <id> dispatched --executor <name> --base <sha> --yes`; the agent gets only the brief path (PRI-3, ORC-3). It runs `{{bin}} secrets` (exit 0) before its report.
4. Its report: `{{bin}} report <id> --from <file> --yes` stores it, records the event (a fix round: `--round <k>`) (ORC-7).
5. Check it: commits, tree, scope, red/green (ORC-8, FLW-6); then in the worktree `{{bin}} verify <id> --yes`. Fail: `task set <id> fix-round --round <k> --addressed <n> --open <n>`.
6. Review as `{{bin}} brief <id>` says (none, `{{plugin}}:reviewer`, `{{plugin}}:security-reviewer` or `{{plugin}}:external`): `{{bin}} review brief <id> --write --yes`, the `review` skill, `{{bin}} review record <id> --from <file> --yes`.
7. At most 2 fix rounds; then `{{bin}} decide --kind review-close --task <id> --remaining <blocking IDs> --yes`.
8. Finish: `{{bin}} task done <id> --yes`, `{{bin}} task merge <id> --yes`, `{{bin}} commit --yes`. After compaction: `{{bin}} task show <id>` (MEM-11).
