---
# Generated from templates/skills/work.md by scripts/gen-names.mjs; do not edit.
name: work
description: Use when the user asks for a change to code in a repository, such as a feature, a fix, a refactor or tests, new or continued.
---

# Work

Command not on PATH: prefix it with `${CLAUDE_PLUGIN_ROOT}/bin/`.

Commands take `--json`; those that write files also `--yes`.

1. Obviously trivial from the request (one file, no risk path: auth, money, migrations, CI): make the change, run the tests, stop. No other commands.
2. Otherwise `landfall status --json`. Declined: work without the plugin, stop here. Active: go to 4.
3. Unsure of the class: `landfall route --probe --paths <p,…> --loc <n>` (PRI-2). Critical: `landfall:plan`, then `landfall:dispatch`. Standard: say in one line: state goes to `.landfall/`; "no landfall here" opts out (`landfall decline`), then `landfall init --yes`.
4. Rules by ID, never whole files: `landfall rule PRI-2 FLW-1 COD-1 COD-3 PRI-15`. `landfall profile observe --yes`; ask at most 3 questions the scan cannot answer, record each: `landfall profile set <key> <value> --source said --evidence "<their words>" --yes`; the project's own risk paths go to `riskGlobs`, what every review checks to `reviewFocus`.
5. `landfall task new "<title>" --yes`, then `landfall route <id> --paths <p,…> --loc <n> --yes`; on a branch: `landfall task start <id> --yes` (worktree, branch and base recorded).
6. Test first: write it, run it, keep the failure; make it pass; commit (COD-1, COD-2, COD-3). A renamed test keeps its body; verify reports it as renamed.
7. Run `landfall secrets` (exit 0) before the report; a finding: remove the value (fixture marker or env var), run again. Write the report from `${CLAUDE_PLUGIN_ROOT}/templates/task/report.md` with RED and GREEN frontmatter and store it: `landfall report <id> --from <file> --yes`.
8. `landfall verify <id> --yes`, then `landfall task done <id> --yes`; from a task branch also `landfall task merge <id> --yes` (PRI-15, FLW-6). Then `landfall commit --yes`: the state is not code, one commit after the task is enough.
9. A decision later work must follow: `landfall:decide`; tests verify saw removed: `landfall decide --from-verify <id> --why … --cost … --yes`.
