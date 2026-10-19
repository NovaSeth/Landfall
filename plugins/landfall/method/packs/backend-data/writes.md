# Idempotent writes

**Purpose:** every write takes effect exactly once despite retries, lost responses, double taps and offline queues. **Reads:** implementer, reviewer, designer. **When:** writing or reviewing code that sends, accepts or replays a write.

**Section map**
- §Client — one sender, keys, retries, unknown outcomes, the write envelope, UI locks.
- §Server — fingerprint and key scope, stored responses, external effects, permissions on replay.
- §Tests — the write tests every module carries.

## Pack: backend-data

### Client
**WRT-1.** Every write goes through one sending function with an `Idempotency-Key` (UUID v4); a test checks that no write definition bypasses it.
**WRT-2.** `mutate(vars)` is a new operation with a new key; MUST NOT retry a failed write with a new `mutate`, and a 4xx means the outcome is known and the key is spent.
**WRT-3.** `canRetry` = network error, timeout or 5xx AND nothing in flight; only then does "Try again" call `retry()` with the same body and key, and a late response of a superseded attempt changes nothing.
**WRT-4.** After an unknown outcome, a creating write locks its form and leaves only `retry()`; MUST NOT reset the write state when fields are edited, because a lost response would then yield a duplicate.
**WRT-5.** The write envelope (key, data, state, error) survives unmounting (session storage); success clears it after cache invalidation, and a session change clears every envelope.
**WRT-6.** In the UI: a single-flight lock in a ref released on completion, `loading` on the button, the server's value after an error, the backend's message only for 4xx; in a chain, retry only the step that failed.

### Server
**WRT-7.** Fingerprint a write as hash(actor, method, path normalized as the router does, canonical body), reserve the key before executing, answer a different fingerprint with `422 key-reused`, and scope keys to (tenant, actor, key).
**WRT-8.** Store the response in the same transaction as the change and its event; a replay returns it with `x-idempotent-replay: true`, and retention lasts at least as long as the offline window.
**WRT-9.** MUST NOT store a 5xx response: roll the transaction back, so that a retry (WRT-3) runs the operation again.
**WRT-10.** An external effect moves `reserved → attempting` (committed before the call) `→ external-done → done`; a leftover `attempting` checks the effect: present → finish, absent → execute, check failed → `503 outcome-unknown`, check impossible → `409 outcome-unknown`.
**WRT-11.** An empty read does not prove that an external effect is absent.
**WRT-12.** A replay checks current permissions: without them it returns `403` with `outcome: applied`, no body and no execution.

### Tests
**WRT-13.** Every write path has tests: the same key gives one record (also after a lost response), a double tap sends one request, and offline → kill → network gives one record.
