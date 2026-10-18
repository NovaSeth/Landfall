---
# Generated from templates/skills/review.md by scripts/gen-names.mjs; do not edit.
name: review
description: Use when a task's diff or a fix round needs a review, when fixes need a scoped re-review, or when review findings must become a fix brief.
---

# Review

Rules: `caw rule PRI-6 ORC-5 REV-1 REV-2 REV-3 REV-5 REV-6 REV-7 REV-9`.

1. The author never reviews (PRI-6). Dispatch `caw:reviewer` (fresh context, read-only) with a review brief: commit range, task brief, the author's report, the diff saved to a file, the acceptance points and a risk list (ORC-5).
2. The reviewer writes JSON to a file, shaped by `${CLAUDE_PLUGIN_ROOT}/templates/review.schema.json`: `{"verdict": "approved|needs-fixes", "reviewer": {"kind": "claude|external", "id": "claude:reviewer"}, "findings": [{"id": "F1", "severity": "blocking|minor", "path": "a/b.mjs", "line": 12, "rule": "COD-2", "text": "one line"}]}`. Every key is required; an absent value is `null`. Severities per REV-2; a blocking finding carries a reproduction in its text (REV-3). Another provider's CLI gets the schema as its output schema.
3. Record it: `caw review record <id> --from <file> --yes`. Invalid JSON: exit 2 with the failing fields, nothing written.
4. `needs-fixes`: write a findings file from `${CLAUDE_PLUGIN_ROOT}/templates/task/findings.md` for a fresh implementer (REV-5); the round ends with a scoped re-review from `${CLAUDE_PLUGIN_ROOT}/templates/task/rereview.md`, recorded the same way (REV-6).
5. At most 2 fix rounds; then `caw decide --kind review-close --task <id> --remaining <blocking IDs> …` (REV-7). A disputed finding is decided, not fixed (REV-9).
