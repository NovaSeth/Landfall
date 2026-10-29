# Review brief: <Task title> (<task ID>), round <k>
<!-- Review brief (ORC-5). Rendered by `{{bin}} review brief` from the state; the reviewer is read-only. -->

Reviewer: {{plugin}}:<reviewer agent> (class: <trivial | standard | critical>). Read-only: change no file, commit nothing, write only the review JSON (ORC-18).
Ignore skills, plugins and MCP tools you may have; never call an AI provider; this brief and the files it names are your only context (PRI-3).
Range: <from>..<head> (branch <branch>; HEAD at rendering: <head>; a later commit is out of scope)
Files: brief <brief path>; report <report path>; diff <diff path> (git diff -U10 of the range, the state directory left out)
Rules: <rule IDs>; read them with `{{bin}} rule <ID…>`.

## Changed files
<changed files>

## Acceptance (cite the number)
<acceptance>

## Previous findings (mark each ADDRESSED or NOT ADDRESSED by repeating its reproduction on the new code, REV-6)
<previous findings>

## Risks (check each)
<risks>

## Severity (REV-2)
blocking: data loss or corruption, a security hole, an outage, a functional defect, a violation of a rule or a Global Constraint; every blocking finding carries its reproduction (a command or test and its output, REV-3). minor: everything else. needs-fixes needs at least one blocking finding; approved has none.

## Output
One JSON object in a file outside the state directory, per `<schema path>`: {"verdict": "approved|needs-fixes", "reviewer": {"kind": "claude", "id": "<reviewer id>"}, "findings": [{"id": "F1", "severity": "blocking|minor", "path": "<repository-relative file>", "line": <n or null>, "rule": "<ID or null>", "text": "<what is wrong, the reproduction, how to fix>"}]}. The orchestrator records it with `{{bin}} review record <task ID> --from <file>`.
Final reply: exactly 5 lines: status, verdict with the count of findings per severity, tests and reproductions you ran, concerns or "none", the JSON path.
