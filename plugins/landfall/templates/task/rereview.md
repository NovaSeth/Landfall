# Scoped re-review: <task> (<task ID>), round <k>
<!-- The orchestrator fills in "Request" and saves it as rereview-r<k>-brief.md (REV-19).
     The reviewer writes the result (sections from "Result" on) to rereview-r<k>.md; the last line of the file is the verdict alone (one of the two). -->

## Request
Previous review: <file> (findings <IDs>). Findings file: <path>/findings-r<k>.md. Round diff <a>..<b>: <path>/rereview-r<k>.diff. The author's report with its "Fix round <k>" section: <file>.
Orchestrator's evidence: <the regression test fails on the old code and passes on the new one; gate counts>.
Look for new problems ONLY in the round's diff (REV-6). Risks the fix could have introduced: <list>.
Read-only. Mark each finding ADDRESSED or NOT ADDRESSED by repeating its reproduction on the new code. Final reply: 5 lines.

## Result
| Finding | Severity | Status | Reproduction on the new code + location |
|---|---|---|---|
| <I-1> | <Critical / Important> | <ADDRESSED / NOT ADDRESSED> | <command / test and output, file:line> |

## Round tests assessment
## Risks from the request (in order)
## New problems in the round's diff
**Critical**
- <file:line> <what>; <why>; <how to fix>. Reproduction: <command / test and its output>
**Important**
- …
**Minor**
- …

## Verification scope
Taken from the author's report: <…>. Run myself: <…>.

## Context
<files read and line ranges; method rules by ID, not whole documents>

## Assessment
<reason in 1–2 sentences>
**Approved** | **Needs fixes**
