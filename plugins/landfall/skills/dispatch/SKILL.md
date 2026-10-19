---
# Generated from templates/skills/dispatch.md by scripts/gen-names.mjs; do not edit.
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Command not on PATH: prefix it with `${CLAUDE_PLUGIN_ROOT}/bin/`.

Rules: `landfall rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8`.

1. Brief: `landfall brief <id> --write --yes`; fill every `<…>` (PRI-18, ORC-4). Agent by role (ORC-1): `landfall:implementer` for code and fix rounds, `landfall:designer` for specs, shared parts and concurrent code.
2. Worktree: one task, one agent, one branch (PRI-4): `git worktree add <path> -b <branch> <base>`, or `isolation: worktree`.
3. Record: `landfall task set <id> dispatched --executor <name> --base <sha> --yes`.
4. Give the agent the brief path only, never the history (PRI-3, ORC-3). 15-minute box. The implementer runs `landfall secrets` (exit 0) before its report; fix findings, run again.
5. Its reply decides (ORC-7): `landfall task set <id> implementer --report <done|done-with-concerns|needs-context|blocked> --yes`.
6. Check the report: commits, clean tree, scope, red/green (ORC-8, FLW-6). Then in the worktree: `landfall verify <id> --yes`. On a fail: `task set <id> fix-round --round <k> --addressed <n> --open <n>`.
7. Review as `landfall brief <id>` says (none; fresh `landfall:reviewer`; or `landfall:external` for another provider): use the `review` skill, then `landfall review record <id> --from <file> --yes`.
8. At most 2 fix rounds; then `landfall decide --kind review-close --task <id> --remaining <blocking finding IDs> --title … --why … --cost … --yes`.
9. Finish: `landfall task done <id> --yes` after a passing verify, then `landfall task merge <id> --yes` from the integration branch.
