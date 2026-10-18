---
# Generated from templates/skills/plan.md by scripts/gen-names.mjs; do not edit.
name: plan
description: Use when a change needs a spec or a plan before code, such as a new product or feature, a change across many files, or one touching shared parts, data or security.
---

# Plan

Depth follows the class (PRI-2): `caw route <task>` prints it. Read the rules first: `caw rule SPC-1 SPC-3 SPC-4 SPC-5 SPC-7 SPC-8 SPC-9 SPC-13`.

1. Standard task: the plan goes inside its brief. Critical task: a spec, then a plan.
2. Run discovery first for a new product or an MVP scope decision (FLW-2).
3. Spec: what and why, the current state with `file:line` evidence, success criteria as metrics with thresholds, 2–3 approaches with the choice and the cost if wrong (SPC-3, SPC-4). An unknown gives its detection and fallback (SPC-5).
4. Plan: Global Constraints, each guarded by a test, generator or linter; a Review Focus of 3–5 risk scenarios; tasks with disjoint file scopes and the shared files listed (SPC-7, SPC-9). Each task: files, interfaces, RED test first, gate commands, one checkable acceptance line (SPC-13).
5. Write each task into its brief: `caw brief <task> --write`, then add the spec and plan slice for it to `tasks/<id>/brief.md`.
6. Check every task against the others and the Global Constraints; each contradiction becomes a decision with the `caw:decide` skill (SPC-8).
7. A late change is a dated amendment that cites its decision (SPC-6); a plan never overrides a spec decision without one (SPC-15).
