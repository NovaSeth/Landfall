---
# Generated from templates/skills/decide.md by scripts/gen-names.mjs; do not edit.
name: decide
description: Use when making or changing a technical, scope or process decision that later work must follow, or when the user states a preference about how to work.
---

# Decide

Rules: `caw rule PRI-8 PRI-10 PRI-16 PRI-17 MEM-2 MEM-3 COD-12 SPC-15`.

1. Decide technical scope, variants, spec and plan conflicts yourself (PRI-16); ask the human only in the cases PRI-17 lists.
2. Look for an existing one: `caw decisions find <words>`.
3. Record: `caw decide --title "<what>" --why "<why>" --cost "<cost if wrong>" [--scope <globs>] [--kind <kind>] --yes`. Quote the human's words verbatim (PRI-8, MEM-2); a stated preference also goes into the collaboration rules with its reason (MEM-3).
4. A change is a new record that replaces the old: `--supersedes <ids>`. Never edit a record (MEM-2, SPC-15).
5. A number in the method is a default: record the project's own value (PRI-10).
6. Cite the ID next to the code it constrains: `// D-<H>-<n>: <why in five words>` (COD-12). Then run `caw decisions check`; it exits 1 on a bad record or citation.
