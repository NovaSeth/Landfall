---
# Generated from templates/skills/start.md by scripts/gen-names.mjs; do not edit.
name: start
description: Activate process tracking in this repository.
disable-model-invocation: true
---

# Start

The user asked to activate process tracking in this repository.

the plugin keeps outcome gates in code: `caw verify` re-runs the project's gates and compares the tests with a baseline. Its state is `.caw/` in this repository. Work is sized first; a trivial change writes nothing. Decisions get IDs. Only files under `.caw/` are written, and only after this step.

1. Run `caw doctor --json`. On a non-zero exit, report each error with its hint and stop.
2. Run `caw init --yes --json` and report its one-line result.
3. Tell the user: `caw decline` opts this repository out, `caw deactivate` removes the state.
