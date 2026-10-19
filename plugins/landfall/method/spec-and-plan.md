# Spec, plan and task

**Purpose:** what a spec, a plan and a task inside a plan contain. **Reads:** designer (spec), orchestrator (plan, brief). **When:** writing a spec or a plan; cutting a brief.

**Section map**
- §Spec — roles of spec, plan and brief; template, evidence, approaches and plan resolutions, unknowns, amendments.
- §Plan — Global Constraints, Review Focus, pre-start check, parallel scopes, naming precedence.
- §Task anatomy — task heading, fields, steps, definition of done.

## Core

### Spec
**SPC-1.** A spec says what and why, a plan says the order, who and how to verify, and a brief is a slice of the plan with exact values.
**SPC-15.** A plan MUST NOT change a spec decision without a decision record.
**SPC-2.** Write a spec from `templates/spec.md` with its header and sections in template order; a section that does not apply says "not applicable, because …".
**SPC-3.** Give the current state with `file:line` evidence; a success criterion is a metric with a threshold ("works correctly" is not one), and a critical path has a performance budget.
**SPC-4.** Compare 2–3 approaches with pros and cons, name the choice and what it takes from the rejected ones; every decision states why and the cost if wrong, and each ambiguity the spec leaves is settled in the plan as a numbered resolution (P1…Pn) recorded as a decision.
**SPC-5.** A question never blocks work: every unknown states how it is detected without an answer and its fallback (own data, an overlay, an explicit 501); open questions go to the PO report.
**SPC-6.** Append late changes at the end as dated amendments citing their decision; MUST NOT silently edit earlier text of a spec or a plan.

### Plan
**SPC-7.** Write a plan from `templates/plan.md` with Global Constraints (default 5–12 invariants binding every task, each guarded by a test, generator or linter where possible) and a Review Focus (3–5 numbered risk scenarios, each with the exact expected behavior and the task or test that proves it).
**SPC-8.** Before the first dispatch, check every task of the plan against itself, the other tasks and the Global Constraints; each contradiction becomes a decision.
**SPC-9.** Tasks run in parallel only with disjoint file scopes; the plan lists the shared files, which change only through a shared task (PRI-7).
**SPC-10.** The code is the source of truth: names in a task report win over names in the plan, differences from the spec are marked explicitly, and the orchestrator corrects the plan.

### Task anatomy
**SPC-11.** A task starts with the heading `### Task <id>: <title>` (unique ID) and has no other Markdown heading outside code blocks.
**SPC-13.** A task has the fields Files (create, modify, test), Interfaces (consumes, produces with exact signatures), checkbox steps, Gate (commands, branch) and Acceptance in one checkable line.
**SPC-14.** Task steps follow RED with the full test code → run it ("Expected: FAIL (<reason>)") → implement → run ("Expected: PASS") → E2E or QA flow → commit with its message.
**SPC-12.** The definition of done per unit (screen, endpoint, module) is in the plan; a task that does not meet it is not DONE.
