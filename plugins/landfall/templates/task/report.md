---
red: {"command": "<the test command>", "exit": <its exit code before the change, not 0>, "excerpt": "<the failing output, at most 2 KB>"}
green: {"command": "<the test command>", "exit": <its exit code after the change: 0>, "excerpt": "<the passing output, at most 2 KB>"}
---
# Report: <title> (<task ID>)
<!-- Task report. The frontmatter above is the evidence verify reads: red and green, each one JSON object on its line (command, exit as a number, excerpt of at most 2 KB); red fails (exit not 0), green passes (exit 0). The template as shipped is no evidence: its exit placeholders are not numbers. The prose below decides nothing. The "Status:" line holds one value: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT or BLOCKED; the last one counts. The report is a record: in a fix round, do not change earlier sections; append a new one with its own "Status:" line (REV-18). -->

Worktree / branch: <…>. Commits: <sha> (RED), <sha> (GREEN), … Push: <yes/no>. Scope touched: <…>.
Status: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

## Decisions
1. <acceptance point 1>: <what was done and why>
2. …

## Files
- <path>: <change>

## RED / GREEN
- RED: <test> failed because <reason> (output: …)
- GREEN: <counts after the implementation>

## Gate
| Command | Result | Exit |
|---|---|---|
| typecheck | | |
| lint | | |
| tests | | |
| secrets scan | | |
<reruns of flaky tests, with the explanation>

## E2E assertions reviewed
## Shared gaps (for the orchestrator)
- <package / file / field / consumer>
## Context
<files read and line ranges; method rules by ID, not whole documents>

## Open issues / deviations from the brief

<!-- Append later rounds at the end, one section per round (k = round number):

## Fix round <k> (findings-r<k>.md)
| Finding | Fix | RED / GREEN | Commit |
|---|---|---|---|
Gate: <table as above>.
Status: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

## DISPUTED (only when disputing a finding; that finding gets no fix, REV-9)
- <finding ID>: <argument>; evidence: <test / file:line>
-->
