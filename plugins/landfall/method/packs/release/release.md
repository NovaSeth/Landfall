# Release

**Purpose:** what must hold before a test or production release, how a risky change rolls out, and the triage of deferred findings. **Reads:** orchestrator, security owner, designer. **When:** before every test or production release, while planning a rollout, at the periodic triage.

**Section map**
- §Release gates — the audit, security requirements per release kind, moving reviews to the release.
- §Rollout — flags per resource, shadow exit, rollback, iterations.
- §Deferred findings — triage timing, re-checking, classes, batches.

## Pack: release

### Release gates
**REL-1.** Before every test and production release, run a full security audit on the strongest model over the whole guide and code (security pack, SCD-22, SCD-23); the security owner dispatches it and runs the release gates.
**REL-2.** A test release MUST meet: no open High or Critical finding and Medium findings have tasks with due dates (SEC-9), object authorization covered by two-user tests, no dev routes in the build, backups disabled, local tools hardened, clean secrets, key-leak and production-dependency scans.
**REL-3.** A test release MUST also meet: services only over TLS or the tester's loopback, separate tester accounts, and external-system keys only for demo environments.
**REL-4.** A production release additionally MUST meet: short-lived access tokens with an absolute session limit, real local authentication, every limit on, TLS 1.2 or newer with HSTS and security headers, a non-public OpenAPI, and loopback services behind a reverse proxy.
**REL-5.** A production release additionally MUST meet: a secrets manager with key rotation and keys per environment, encrypted backups, retention of replicas and event logs within the privacy law, an audit trail by credential ID, and alerts on bursts of 401, 403 and 429.
**REL-6.** A production release additionally MUST meet: a binary scan and a manual dynamic test without a High finding, an audit on the strongest model, and a release signing key kept outside the repository with a copy held by the PO.
**REL-7.** Moving per-task security reviews into one review before the release needs a decision that states its cost if wrong.

### Rollout
**REL-8.** Roll out a risky change behind a flag per resource `off | shadow | on` with a written exit criterion from shadow; rollback = flag off.
**REL-9.** Each iteration is a separate pull request with its own tests, its gate and something testers can see.

### Deferred findings
**REL-10.** Triage deferred findings before each release and periodically (default weekly in a team) as an audit task.
**REL-11.** Re-check every deferred finding against the current `main` before classifying it.
**REL-12.** Classify each finding: A — no longer valid, close it with one line of evidence; B — valid, with risk (high, medium, low), cost S/M/L, lane and a proposal (now, later, close).
**REL-13.** Package the triage output as batches of 3–8 findings per lane with disjoint files.
