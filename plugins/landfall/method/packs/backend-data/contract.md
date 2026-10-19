# Contract and mock mode

**Purpose:** one contract for client and server, API conventions and documentation, and the mock mode that replays the data world. **Reads:** designer (contract, shared tasks), implementer, reviewer. **When:** a project with a backend: defining or changing the API, building the mock backend, writing component tests.

**Section map**
- §Spec and plan — Global Constraints of a backend project, the contract section of a spec.
- §Contract — contract first, field names, server-formatted labels, additive changes, PATCH semantics.
- §API conventions — lists, IDs, timestamps, versions, errors, partial data.
- §API documentation — generated OpenAPI, the API changelog, deprecation.
- §Mock mode — the world at a clock, scenarios, no guessing, the mock backend, component tests.

## Pack: backend-data

### Spec and plan
**CTR-1.** The Global Constraints of a backend project cover at least: ports · API prefix, mandatory headers and error codes · time constants (thresholds, TTL, idempotency retention) · the tenant everywhere with an isolation test · events in the write transaction · module boundaries · the data world (discovery pack, DSC-50).
**CTR-2.** A spec's contract section gives strict schemas with length limits, headers marked "unchanged", error codes and the semantics of partial data.

### Contract
**CTR-3.** Write the contract first: one package of schemas and types for client and server, the client typed from the server routes, and OpenAPI generated from the contract (CTR-10).
**CTR-4.** Name fields as in the external system's API; mark a field without a source `// gap <code>` and a computed one `// derived`, and type inputs `XInput` and parsed values `X`.
**CTR-5.** The server delivers formatted labels (amounts, dates, statuses); a screen never assembles phrases.
**CTR-6.** Change the contract additively, with an API changelog entry (CTR-11); a breaking change is explicit with its list of consumers, and in a public API it is a new major version path.
**CTR-7.** In `PATCH`, `null` clears a field and an omitted field stays unchanged.

### API conventions
**CTR-8.** Follow the API conventions: lists `{items, total}`, IDs with a type prefix, ISO-8601 timestamps with an offset, `If-Match` → `409 version-conflict`, errors `{error, message, details}`; the client decides by `error` and `details.reason`.
**CTR-9.** A partial value is `null` because it is unknown, with its reason (`not-fetched`, `upstream-unavailable`, `outcome-unknown`), never a guessed default.

### API documentation
**CTR-10.** Generate OpenAPI from the contract and commit it; its generator runs with `--check` in the task gate and in CI (COD-6), and the output MUST NOT be edited by hand.
**CTR-11.** Every contract change gets an API changelog entry (added, changed, deprecated, removed); mark a field or endpoint being withdrawn `deprecated` with its successor and removal date, and treat the removal as a breaking change.

### Mock mode
**CTR-12.** One function computes the world's state at a clock: base world → scenario variant → events up to the clock; compare absolute instants.
**CTR-13.** A scenario changes data only where a screen state needs it, and a time-dependent state is another clock; MUST NOT drive states with flags.
**CTR-14.** Never guess data: what the data world lacks stays `undefined`, and mockup inconsistencies go into the data world's README with a decision.
**CTR-15.** MUST NOT import the data world or test doubles in application code; only the mock backend uses them.
**CTR-16.** The BFF has a mock mode whose scenario and clock come from the `x-scenario` and `x-clock` headers or a deep link, so one link reaches every screen state.
**CTR-17.** Component tests run against the mock backend in process, without network, reset before each render.
