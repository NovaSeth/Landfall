---
name: review
description: Use when a task's diff or a fix round needs a review, when fixes need a scoped re-review, or when review findings must become a fix brief.
---

# Review

Rules: `{{bin}} rule PRI-6 ORC-5 REV-1 REV-2 REV-3 REV-5 REV-6 REV-7 REV-9 REV-21`.

1. The author never reviews (PRI-6). `{{bin}} review brief <id> --write --yes` renders the pinned range, diff file, acceptance, risks (paths, review focus, decisions) and output shape (ORC-5, REV-21); a dirty tree is refused, so commit first. Dispatch the `Reviewer:` agent (fresh, read-only) with the file path: `{{plugin}}:reviewer` or on a security trigger `{{plugin}}:security-reviewer` (SEC-13).
2. The reviewer writes JSON to a file, shaped by `${CLAUDE_PLUGIN_ROOT}/templates/review.schema.json`: `{"verdict": "approved|needs-fixes", "reviewer": {"kind": "claude|external", "id": "claude:reviewer|claude:security-reviewer"}, "findings": [{"id": "F1", "severity": "blocking|minor", "path": "a/b.mjs", "line": 12, "rule": "COD-2", "text": "one line"}]}`. Every key is required; an absent value is `null`. Severities per REV-2; a blocking finding carries its reproduction (REV-3).
3. Record it: `{{bin}} review record <id> --from <file> --yes`. Invalid JSON: exit 2 with the failing fields, nothing written.
4. `needs-fixes`: a findings file from `${CLAUDE_PLUGIN_ROOT}/templates/task/findings.md` for a fresh implementer (REV-5); then a scoped re-review: `{{bin}} review brief <id> --round <k> --scope <finding IDs> --write --yes`, recorded the same way (REV-6). An editorial round you may verify yourself: `task set <id> self-verified --round <k>`.
5. At most 2 fix rounds; then `{{bin}} decide --kind review-close --task <id> --remaining <finding IDs> …` (REV-7); the remaining findings go to the backlog (`{{bin}} findings list`, REV-22). A disputed finding is decided, not fixed (REV-9).
