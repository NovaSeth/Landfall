---
name: status
description: Show this repository's process state.
disable-model-invocation: true
---

# Status

1. Run `{{bin}} status --json`. It writes nothing.
2. Report in at most 10 lines: activation and tier, open tasks with their next step, the loop, running leases. Read summaries, never whole logs.
3. For the loop in detail run `{{bin}} loop status`.
