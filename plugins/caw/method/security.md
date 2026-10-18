# Security

**Purpose:** security essentials at every tier: layers, threat model, the command guard, secrets, identity, release blockers. **Reads:** every executor; reviewer for security findings. **When:** writing or reviewing code that touches trust boundaries or secrets; before a release.

**Section map**
- §Model — validation layers, threat actors, the command guard and its limits, hard boundaries.
- §Secrets — storage, scanning, synthetic values, hooks, leaks.
- §Code — identity, object authorization, failing closed.
- §Release — what blocks a release.

## Core

### Model
**SEC-1.** Validate security in four layers, none replacing another: (1) automated checks on every task, push and CI, (2) a security review when a diff touches a trigger, (3) an audit before each release, (4) release gates.
**SEC-2.** The threat model MUST include the actor "developer or AI agent" (trusted but fallible) and the supply chain.
**SEC-3.** The command guard is a seatbelt against accidental rule breaks, not a security boundary: a command with a guarded token passes only in a recognized simple form and is blocked when state cannot be read.
**SEC-10.** MUST enable the hard boundaries once the project has a remote: server-side branch protection, the pre-push secrets scan and the CI secrets scan.
**SEC-4.** MUST NOT bypass a guard block (wrapper script, other syntax) or skip git hooks (`--no-verify`, `commit -n`, changing `core.hooksPath`); when the action is necessary, ask the human; put project-specific blocks and secret patterns in the project's own files, never in plugin files.

### Secrets
**SEC-5.** Keep secrets server-side only (env files with mode 0600, ignored by git); MUST NOT put them in client variables, the repository, logs, reports or errors; a report names `file:line` and the secret type, never the value.
**SEC-6.** Run the secrets scan without a pipe in the mode the moment needs (working tree in the task gate, staged before a commit, a commit range for history) and check its exit code (8 = error, not clean).
**SEC-11.** Exempt a synthetic value only in test and fixture files, with the `SYNTH` marker as a separate word on its line; MUST NOT loosen patterns or exclude files because of false positives.
**SEC-7.** On a leak, rotate the secret, record a decision and check the history; removing it from the tree does not close the case; remove a secret the pre-push scan finds from the pushed commits before pushing.

### Code
**SEC-8.** Take tenant and user only from the credential; every read and write of an object checks the tenant and the right to that object, and another tenant's object returns 404, not 403.
**SEC-12.** Fail closed: missing configuration means refusal, never mock mode.

### Release
**SEC-9.** MUST NOT release with an open High or Critical finding; Medium findings get tasks with a deadline.
