---
# Generated from templates/skills/doctor.md by scripts/gen-names.mjs; do not edit.
name: doctor
description: Check the plugin's health and context cost.
disable-model-invocation: true
---

# Doctor

1. Run `landfall doctor --json`. It writes nothing.
2. Report each row of `data.rows` as ok, warning or failed, with its detail, and the always-on cost.
3. For each warning or failure, give its hint as the next step. Exit 8 means `claude` or `git` is missing: say so and stop.
