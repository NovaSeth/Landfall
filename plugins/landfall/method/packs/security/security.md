# Security depth

**Purpose:** security work beyond the core: the project security guide, trust boundaries, code rules, security reviews, audits, findings and leaks. **Reads:** designer, implementer and reviewer while the pack is active; the reviewer with the security focus. **When:** personal, payment or health data (an unknown sensitivity value counts as sensitive), tier L3, a diff that touches a security trigger, an audit, a secret leak.

**Section map**
- §Guide — the project security guide, threat actors, trust boundaries, new general rules.
- §Code — dev tools, input limits, sessions and tokens, log redaction, tools for AI agents, CI actions.
- §Security review — triggers, executor, reading scope, checks, limits, blocking findings, reply.
- §Audit — executor, scope, tools, consent for load tests and scans.
- §Findings — IDs and fields, severity, report shape.
- §Tests and data — required security tests, personal data, moving a repository.
- §Leaks — order of steps after a secret leak.

## Pack: security

### Guide
**SCD-1.** Keep a project security guide (default `docs/security/guide.md`) with the threat model, assets, trust boundaries, checklists per area, required tests and release requirements; every security layer (SEC-1) works from it.
**SCD-2.** The threat model lists each actor with its trust level: user session, manager or administrator, integration token, another tenant, a malicious app or page on the device, a device thief, a network attacker, the developer or AI agent, and the supply chain (SEC-2).
**SCD-3.** Trust boundaries MUST cover client ↔ BFF, BFF ↔ API (identity from the credential, never from BFF headers), API ↔ external system (with a shared key the API checks per-user rights), app ↔ operating system (deep links, notifications, backups, clipboard) and developer machine ↔ world (env files, logs, local ports, DNS rebinding).
**SCD-4.** Report a general rule that a finding reveals in the report's "For the guide" section; the orchestrator decides whether it enters the guide.

### Code
**SCD-5.** Put dev tools (routes, headers, menus, tokens) behind a double gate, a server environment flag AND a client debug build; a process MUST refuse to start in production with the dev flag, and an environment variable overrides the env file (tested).
**SCD-6.** Validate every input with a schema (lengths, strict objects, number bounds) and set body and file size limits and rate limits per credential.
**SCD-7.** Use short-lived access tokens and a rotating refresh token whose reuse revokes its whole family; invalidate the session on logout and on an account switch.
**SCD-8.** Give every issued token a type prefix (for example `abc_s_…`), because the prefix makes secret scanning possible.
**SCD-9.** Pass logs and monitoring through redaction: keys `password|token|secret|authorization|cookie|api-key|bearer|credential|signature`, path segments that carry secrets, depth and size limits.
**SCD-10.** In tools for AI agents, defend by narrowing scope; an irreversible write needs confirmation by a human, not by the model, and the `readOnly`, `destructive`, `idempotent` and `openWorld` annotations stay under a snapshot test.
**SCD-11.** Pin every CI action to a full commit SHA with its version in a comment.

### Security review
**SCD-12.** Dispatch a security review when the diff touches a trigger: authentication, tokens, authorization, tenant filters, new routes, irreversible writes, secrets, env, logs, errors, deep links, WebViews, on-device storage, uploads, dependencies, external-system clients, tools for AI agents, platform configuration, CI or hooks.
**SCD-13.** A security review is a reviewer run with the security focus (default: medium model and effort) over `git diff <base>...<branch>` and the files the diff directly depends on.
**SCD-14.** The security reviewer reads only the guide checklists of the touched areas and the latest audit report; it does not report open findings again but cites their IDs as worsened or fixed.
**SCD-15.** Always check new routes and object authorization (two users, two tenants), validation and limits, dev gates, secrets in code, logs and errors, deep links, on-device storage and new dependencies (author, install scripts).
**SCD-16.** The security reviewer only reads and runs commands that change nothing in the repository (heavy ones through the CLI `heavy`); the orchestrator dispatches the fixes.
**SCD-17.** MUST NOT send requests to external systems, staging or production; run a dynamic test only against your own local stack and only when the brief allows it.
**SCD-18.** MUST NOT write working exploits; the problem class, the location and the condition suffice.
**SCD-19.** Base every claim on code you read (`file:line`); record a dependency on unknown configuration and lower the confidence.
**SCD-20.** A blocking finding (High or Critical in the diff) MUST hold the merge until a fix round and a scoped re-review pass; Medium and lower findings get tasks.
**SCD-21.** The security reviewer replies with the verdict, findings by severity, the tools and tests it ran and its concerns; the full report goes to the file the brief names.

### Audit
**SCD-22.** Run an audit on the strongest model with high effort, because it needs architectural judgment (permission model, multi-tenancy).
**SCD-23.** An audit covers changes in the guidelines (OWASP ASVS, API Security Top 10, platform documentation, MASVS and MASTG for mobile), the whole guide against the whole code, a dependency audit, the secrets scan over the full history and a key-leak check of every built artifact.
**SCD-24.** Audit tools: static (Semgrep, Gitleaks, the package manager's audit or osv-scanner, MobSF for mobile binaries) and dynamic only against your own stack (OWASP ZAP driven by OpenAPI, mitmproxy, deep-link fuzzing, another tenant's identifiers).
**SCD-25.** MUST NOT run load tests or scans against external systems, staging or production without the PO's consent; against your own local or test stack they are allowed.

### Findings
**SCD-26.** Number findings `SF-<task>-<n>` in a pull-request review and `SF-<n>` in an audit (`SF-<handle>-<n>` in a team).
**SCD-27.** A finding has the area and `file:line`, a description with evidence, the abuse scenario (actor, condition, problem class, impact, no step-by-step exploit), the severity rationale, the fix, the test that proves it and its relation (new, worsens or fixes an ID).
**SCD-28.** Rate severity Critical / High / Medium / Low / Info by simplified CVSS 3.1; lower it for a finding that exists only on the local dev stack, and record the assumption that would change it.
**SCD-29.** A security report has the scope `repo@sha`, the verdict, a summary for the PO, the findings table, open findings from earlier reports, "For the guide" and limits.

### Tests and data
**SCD-30.** Keep the guide's required security tests green; every new resource gets a two-user object-authorization (BOLA) test, also through an integration token.
**SCD-31.** Keep personal and customer data (interview transcripts, recordings) in a private repository or outside the repository.
**SCD-32.** Before moving or publishing a repository, check its history for local paths, personal names, third-party data and secrets.

### Leaks
**SCD-33.** On a secret leak, rotate the secret first, then record a decision with the secret type, `file:line` and the rotation, never the value (SEC-7).
**SCD-34.** Measure a leak's reach with the secrets scan over the full history and the key-leak check of every built artifact; a secret used in production starts the production incident runbook (runbooks pack, RUN-6).
**SCD-35.** A new secret type gets a pattern in the project's own secret patterns and a test that the scanner catches it.
