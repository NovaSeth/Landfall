# Services and data

**Purpose:** backend structure: modules, wrapping an existing system, events, tenancy, degraded modes, migrations and the tests every module carries. **Reads:** designer, implementer, reviewer. **When:** a project with a backend or a data store.

**Section map**
- §Modules — modular monolith, extraction criteria, anti-corruption layer, the synchronous write transaction, READMEs.
- §Existing system — strangler-fig stages, route registry, source header, gap report, takeover inventory and order, no fake external server.
- §Events and tenancy — events in the transaction, consumers, the tenant from the credential, tenant filters.
- §Degraded mode — health monitor, mode and epoch, the demo module.
- §Migrations — expand, migrate, contract, down steps, file names.
- §Done and tests — definition of done for an endpoint or module, load tests, script tests.

## Pack: backend-data

### Modules
**SVC-1.** Build a modular monolith: a module has `index`, `router`, `service`, `source`, `repo`, `README.md` and tables `<module>_*`, because a write to the old system, the new layer and the outbox is one transaction.
**SVC-2.** The spec gives the criteria and the mechanics for extracting a module into a service (scale, team, deployments, failure isolation).
**SVC-3.** The only client of an external API is the anti-corruption-layer module, which has no public routes.
**SVC-4.** An HTTP write is one synchronous transaction without `await` inside it; external calls happen before it.
**SVC-5.** Every package and module has a README; a service README has numbered chapters, a glossary and its open questions with their fallbacks.

### Existing system
**SVC-6.** Wrap an existing system with the strangler fig: the stage registry is the migration map, and each resource moves `legacy` → `legacy+own` → `own+writeback` → `own`, with `demo` apart.
**SVC-7.** A route does not exist without a registry entry (completeness tested in both directions); taking a resource over = registry entry + migration + test.
**SVC-8.** Every response carries `x-source`; no source in live mode → `501 {reason: not-implemented, task}`, no source in the current mode → `503`, and the UI marks data that comes only from the new layer.
**SVC-9.** Generate the gap report from the registry; the gate regenerates it and runs `git diff --exit-code`.
**SVC-10.** Plan takeover tasks from an inventory of the existing API: counts (operations by stage, endpoints documented, called, unused, broken), a table `Endpoint | Operations | Used by | Stage now | Target stage | Dependencies | Risk | Value | Iteration` and registry-versus-code gaps.
**SVC-11.** Take resources over in this order: (1) what unblocks clients, (2) workarounds for broken endpoints, (3) features with no source in the old system, (4) read-only resources; a deviation is a plan resolution.
**SVC-12.** Generate the operation catalog from code (registry, routes), not from documentation, and enrich it with the inventory's sections.
**SVC-13.** MUST NOT write a fake server of an external system: test mappers on anonymized recordings, and test failure with an unreachable address and a forced demo mode.

### Events and tenancy
**SVC-14.** Every state change writes an event `<resource>.<verb>` in the same transaction; a missing event is a review rejection.
**SVC-15.** A consumer moves its cursor in the processing transaction and catches up from the cursor at start; handlers are idempotent.
**SVC-16.** The tenant is in every record, key, event and request context, taken with the actor only from the credential, never from the client (SEC-8).
**SVC-17.** Every query filters by tenant (personal data also by owner), a replica query too (tenant in `WHERE`), and every resource has a tenant-isolation test.

### Degraded mode
**SVC-18.** A health monitor switches modes with hysteresis (default 3 failures → demo, 1 success → live), and each switch increments a durable epoch.
**SVC-19.** Responses carry the mode and the epoch; on a change the client clears its cache and shows the demo banner, and a write in the wrong mode returns `409 mode-mismatch`.
**SVC-20.** The demo module is a full mock world in the domain model, with a parity test against live.

### Migrations
**SVC-21.** Change the database schema in steps expand → migrate → contract, each a separate deployment, and keep the code working with the schema before and after each step (runbooks pack, RUN-13: three pull requests).
**SVC-22.** Every migration has a down step tested up → down → up; an irreversible one needs a decision, the PO's consent and a copy of the data.
**SVC-23.** Name a migration file `<timestamp>-<handle>-<description>`, because sequential numbers collide between lanes; migrations and the schema are a shared part (PRI-7).

### Done and tests
**SVC-24.** An endpoint or module is done only with tests for tenant isolation (tenants A and B), the event after each write, per-object authorization (the access matrix) and the idempotent replay.
**SVC-25.** Run load tests (default: p95 under 20 ms and zero 429 responses, measured in the README) only against your own stack (exception with the PO's consent: security pack, SCD-25).
**SVC-26.** Test shell scripts with fake tools on `PATH`.
