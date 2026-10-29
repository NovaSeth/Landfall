---
# Generated from templates/skills/dispatch.md by scripts/gen-names.mjs; do not edit.
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Off PATH: prefix `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `landfall rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8 ORC-19 ORC-21 ORC-22 ORC-23 ORC-24`.

1. Worktree: `landfall task start <id> --slug <s> --yes` (PRI-4). Parallel agents: disjoint files (ORC-19).
2. Brief: `landfall brief <id> --write --yes`; fill every `<…>`, budget too (PRI-18, ORC-4); deliverable kind, sources (ORC-23). `landfall:implementer` for code, `landfall:designer` for specs; executor, model by kind, size (ORC-1, ORC-21). TaskStop first on a change of course (ORC-22).
3. Record: `landfall task set <id> dispatched --executor <name> --base <sha> --yes`; it gets only the brief path (PRI-3, ORC-3). It runs `landfall secrets` (exit 0) before its report.
4. Report: `landfall report <id> --from <file> --yes` (fix round: `--round <k>`) (ORC-7).
5. Check: commits, scope, red/green (ORC-8, FLW-6); then `landfall verify <id> --yes`. Fail: `task set <id> fix-round --round <k> --addressed <n> --open <n>`.
6. Review as `landfall brief <id>` says (none, `landfall:reviewer`, `landfall:security-reviewer` or `landfall:external`): `landfall review brief <id> --write --yes`, `landfall review record <id> --from <file> --yes`.
7. At most 2 fix rounds; then `landfall decide --kind review-close --task <id> --remaining <blocking IDs> --yes`.
8. Finish: `landfall task done <id> --yes`, one batch: `landfall task merge <ids…> | --ready --yes`, `landfall commit --yes`. After compaction: `landfall task show <id>` (MEM-11).
9. While 2+ agents or a gate run in the background, schedule a check every ~10 min (Claude Code: a recurring cron prompt; elsewhere the loop's tick) and unblock what it finds (ORC-24).
