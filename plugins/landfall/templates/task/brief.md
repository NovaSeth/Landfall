# <Task title> (<task ID>)
<!-- Task brief (ORC-4). Fill every <…>; "{{bin}}" is the plugin's CLI. Every path is absolute (ORC-15). An authoring task says so in its first line. -->

Executor: <agent | provider model/effort> (class: <trivial | standard | critical>).
Worktree: <absolute path> (branch <branch> from <base branch> at <base SHA>; dependencies installed: <yes/no>). Update the branch only with `git merge origin/main`, never rebase.
Shared brief: <path of the shared brief for this kind of task, if one exists>.
Scope: <directories / files>. Something missing in a shared part: stop with NEEDS_CONTEXT and name the gap (file, field, consumer) (ORC-17).
Rules: <rule IDs>; read them with `{{bin}} rule <ID…>`.

## Problem (<who reported it, where>)
<symptom> and the chain of causes as `file:line`.

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
One commit per step; no push.

## Report
<absolute path>/report.md (template: <absolute path of the report template>): the `Status:` line, decisions per acceptance point, files, RED/GREEN, gate, shared gaps, open issues.
Final reply: exactly 5 lines: status, commits, tests, concerns, report path.
