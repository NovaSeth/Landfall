---
# Generated from templates/skills/dispatch.md by scripts/gen-names.mjs; do not edit.
name: dispatch
description: Use when handing a routed task to a subagent or to another provider's CLI, from writing its brief and choosing the agent to verifying its report, the review and the merge.
---

# Dispatch

Rules: `caw rule PRI-3 PRI-4 PRI-18 ORC-1 ORC-2 ORC-3 ORC-4 ORC-7 ORC-8`.

1. Brief: `caw brief <id> --write --yes`; fill every `<…>` left: scope, acceptance points, RED tests, absolute paths (PRI-18, ORC-4). Pick the agent by role (ORC-1): `caw:implementer` for code and fix rounds, `caw:designer` for specs, shared parts and concurrent code.
2. Worktree: one task = one fresh agent = one branch and worktree (PRI-4). `git worktree add <path> -b <branch> <base>`, or give the subagent `isolation: worktree`.
3. Record: `caw task set <id> dispatched --executor <name> --base <sha> --yes`.
4. Dispatch the agent with the brief path and nothing else, never the session history (PRI-3, ORC-3). Small slice, 15-minute box.
5. Its reply decides (ORC-7): `caw task set <id> implementer --report <done|done-with-concerns|needs-context|blocked> --yes`.
6. Check the report yourself: commits, clean tree, scope of the diff, red/green frontmatter (ORC-8, FLW-6). Then, from the task worktree: `caw verify <id> --yes`. On a fail, fix round (`task set <id> fix-round --round <k> --addressed <n> --open <n>`).
7. Review as `caw brief <id>` says (none; a fresh-context `caw:reviewer`; or another provider's CLI): use the `review` skill, then `caw review record <id> --from <file> --yes`.
8. At most 2 fix rounds; then `caw decide --kind review-close --task <id> --remaining <blocking finding IDs> --title … --why … --cost … --yes`.
9. Finish: `caw task done <id> --yes` after a passing verify, then `caw task merge <id> --yes` from the integration branch.
