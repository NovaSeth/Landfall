---
name: work
description: Use when the user asks for a change to code in a repository, such as a feature, a fix, a refactor or tests, new or continued.
---

# Work

Command not on PATH: prefix it with `${CLAUDE_PLUGIN_ROOT}/bin/`.

Commands take `--json`; those that write files also `--yes`.

1. Obviously trivial from the request (one file, no risk path: auth, money, migrations, CI): make the change, run the tests, stop. No other commands.
2. Otherwise `{{bin}} status --json`. Declined: work without the plugin, stop here. Active: go to 4.
3. Unsure of the class: `{{bin}} route --probe --paths <p,…> --loc <n>` (PRI-2). Critical: `{{plugin}}:plan`, then `{{plugin}}:dispatch`. Standard: say in one line: state goes to `{{stateDir}}/`; "no {{plugin}} here" opts out (`{{bin}} decline`), then `{{bin}} init --yes`.
4. Rules by ID: `{{bin}} rule PRI-2 FLW-1 COD-1 COD-3 PRI-15`. `{{bin}} profile observe --yes`; ask at most 3 questions the scan cannot answer (risk paths, review focus), record each: `{{bin}} profile set <key> <value> --source said --evidence "<their words>" --yes`.
5. `{{bin}} task new "<title>" --yes`, `{{bin}} route <id> --paths <p,…> --loc <n> --yes`; on a branch `{{bin}} task start <id> --yes`.
6. Test first: write it, run it, keep the failure; make it pass; commit (COD-1, COD-2, COD-3).
7. `{{bin}} secrets` (exit 0) before the report. Report from `${CLAUDE_PLUGIN_ROOT}/templates/task/report.md` with RED and GREEN frontmatter: `{{bin}} report <id> --from <file> --yes`.
8. `{{bin}} verify <id> --yes`, `{{bin}} task done <id> --yes`; from a task branch `{{bin}} task merge <id> --yes` (PRI-15, FLW-6); then `{{bin}} commit --yes`.
9. A decision later work must follow: `{{plugin}}:decide`; `{{bin}} decide --from-verify <id>` allows removed tests.
