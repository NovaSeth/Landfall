# <Task title> (<task ID>)
<!-- Task brief (ORC-4). Fill every <…>; "{{bin}}" is the plugin's CLI. Every path is absolute (ORC-15). An authoring task says so in its first line. -->

Executor: <agent | provider model/effort> (class: <trivial | standard | critical>).
Ignore skills, plugins and MCP tools you may have; never call an AI provider; this brief and the files it names are your only context (PRI-3).
Worktree: <absolute path> (branch <branch> from <base branch> at <base SHA>; dependencies installed: <yes/no>). Update the branch only with `git merge origin/main`, never rebase.
Budget: <minutes> minutes (default 15, more for more acceptance points); when it nears, stop at a green commit and list the rest under Follow-up in the report.
Shared brief: <path of the shared brief for this kind of task, if one exists>.
Rules: <rule IDs>; read them with `{{bin}} rule <ID…>`.

## Problem (<who reported it, where>)
<symptom> and the chain of causes as `file:line`.

## Scope
Create: <files>. Modify: <files>. Tests: <test files>. Nothing else. Something missing in a shared part: stop with NEEDS_CONTEXT and name the gap (file, field, consumer) (ORC-17).

## Contracts
Consumes: <interfaces, files and fields this task reads, each with its owner>. Produces: <what it exposes, and for whom>.

## Acceptance
1. <acceptance point: the reviewer cites its number>
2. <…>
<"Choose X or Y and justify it in the report"; "do not guess: describe what happens">

## TDD
<which tests must fail first, and why>

## E2E
<You run no devices or queues (the orchestrator does) | you run them through the queue: …>. List the existing flow assertions the change touches.

## Gate (in order, no pipes, bounded test workers)
```bash
<typecheck>
<lint>
<tests with a worker limit>
<secrets scan>; echo "exit $?"
```
One commit per step; no push. A full suite or build runs through the heavy queue: `{{bin}} heavy` with the command after `--`.

## Assignments (only when several agents share one worktree)
<agent → its disjoint file list>. Agents run no git; the orchestrator commits. Shared vocabulary: <the names, headings and contract terms that must agree between the agents, as a table>.

## Report
<absolute path>/report.md (template: <absolute path of the report template>): the `Status:` line, decisions per acceptance point, files, RED/GREEN, gate, shared gaps, open issues. When your harness refuses that write, put the whole report in your reply: the orchestrator stores it with `{{bin}} report <id> --from <file>`.
Final reply: exactly 5 lines: status, commits, tests, concerns, report path.
