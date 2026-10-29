---
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Off PATH: prefix `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `{{bin}} rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19 ORC-21 ORC-22 ORC-23 ORC-26`.

1. Worktree: `{{bin}} task start <id> --slug <s> --yes` (PRI-4). Parallel agents: disjoint files (ORC-19).
2. Brief: `{{bin}} brief <id> --write --yes`; fill every `<…>`, budget too (PRI-18, ORC-4); deliverable kind and sources (ORC-23). `{{plugin}}:implementer` for code, `{{plugin}}:designer` for specs; executor and model by kind, size (ORC-1, ORC-21). TaskStop first on a change of course (ORC-22).
3. Record: `{{bin}} task set <id> dispatched --executor <name> --base <sha> --yes`; it gets only the brief path (PRI-3, ORC-3). It runs `{{bin}} secrets` (exit 0) before its report.
4. Report: `{{bin}} report <id> --from <file> --yes` stores it; fix round: add `--round <k>` (ORC-7).
5. Check: commits, scope, red/green (ORC-8, FLW-6); then `{{bin}} verify <id> --yes`. Fail: `task set <id> fix-round --round <k> --addressed <n> --open <n>`.
6. Review as `{{bin}} brief <id>` says (none, `{{plugin}}:reviewer`, `{{plugin}}:security-reviewer` or `{{plugin}}:external`): `{{bin}} review brief <id> --write --yes`, `{{bin}} review record <id> --from <file> --yes`.
7. At most 2 fix rounds; then `{{bin}} decide --kind review-close --task <id> --remaining <blocking IDs> --yes`.
8. Finish: `{{bin}} task done <id> --yes`, `{{bin}} task merge <id> --yes`, `{{bin}} commit --yes`. After compaction: `{{bin}} task show <id>` (MEM-11).
9. While 2+ agents or a gate run in the background, schedule a check every ~10 min (Claude Code: a recurring cron prompt; elsewhere the loop's tick) and unblock what it finds (ORC-26).
