---
# Generated from templates/skills/work.md by scripts/gen-names.mjs; do not edit.
name: work
description: Use when the user asks for a change to code in a repository, such as a feature, a fix, a refactor or tests, new or continued.
---

# Work

Rules by ID, never whole files: `landfall rule PRI-2 FLW-1 COD-1 COD-3 PRI-15`. Pass `--json` to every command; commands that write files also take `--yes`.

1. `landfall status --json`. Active: go to 4. Declined: work without the plugin, stop here.
2. Class the change without writing anything: `landfall route --probe --paths <p,…> --loc <n>` (PRI-2).
3. Trivial: make the change, run the project's tests, no files. Critical: `landfall:plan`, then `landfall:dispatch`. Standard: tell the user in one line that the plugin will track the repository in `.landfall/` and that "no landfall here" opts out (`landfall decline`), then `landfall init --yes`.
4. `landfall profile observe --yes`; ask at most 3 questions the scan cannot answer and record each: `landfall profile set <key> <value> --source said --evidence "<their words>" --yes`.
5. `landfall task new "<title>" --yes`, then `landfall route <id> --paths <p,…> --loc <n> --yes`.
6. Test first: write it, run it, keep the failure and its reason; make it pass; commit (COD-1, COD-2, COD-3).
7. Write the report from `${CLAUDE_PLUGIN_ROOT}/templates/task/report.md` to `.landfall/tasks/<id>/report.md` with the RED and GREEN frontmatter lines, and commit it.
8. `landfall verify <id> --yes`, then `landfall task done <id> --yes`; from a task branch also `landfall task merge <id> --yes` (PRI-15, FLW-6).
9. A decision later work must follow: the `landfall:decide` skill.
