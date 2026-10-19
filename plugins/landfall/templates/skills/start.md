---
name: start
description: Activate process tracking in this repository.
disable-model-invocation: true
---

# Start

Command not on PATH: prefix it with `${CLAUDE_PLUGIN_ROOT}/bin/`.

The user asked to activate process tracking in this repository.

the plugin keeps outcome gates in code: `{{bin}} verify` re-runs the project's gates and compares the tests with a baseline. Its state is `{{stateDir}}/` in this repository. Work is sized first; a trivial change writes nothing. Decisions get IDs. Only files under `{{stateDir}}/` are written, and only after this step.

1. Run `{{bin}} doctor --json`. On a non-zero exit, report each error with its hint and stop.
2. Run `{{bin}} init --yes --json` and report its one-line result.
3. Tell the user: `{{bin}} decline` opts this repository out, `{{bin}} deactivate` removes the state.
