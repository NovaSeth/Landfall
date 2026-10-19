// Test baseline (spec §5.1 baseline/tests.json, §7.6 step 4 and 6, SD-16, GC3): the pinned inventory
// { collector, tests: [{ id, file, skipped }], failing: [fingerprint] } and its sha256.
//   - The sha256 is taken over the canonical form (collector, tests sorted by ID as [id, file, skipped], failing
//     sorted), so a baseline edited outside verify no longer matches it.
//   - The reference a run is compared with (review r1 #3) is the baseline committed at the anchor (the task's base
//     commit; for a merge, the target tip) united with the working baseline file, which can only add: a test listed
//     by either counts; it counts as skipped only when every baseline listing it says skipped; a failure is
//     pre-existing only when every baseline lists its fingerprint.
//   - A removed or newly skipped test must be listed in allowsTestRemoval of an active decision; added and
//     un-skipped tests are growth.
//   - A failure fingerprint (r1 #10) is `<test id>@<first 12 hex of sha256(location, whole normalized message)>`.
//     A failing gate is excused (r1 #5) only when its collector reports failures, every one is pre-existing, and the
//     reporter's own failure count is not higher than the failures collected.
import { byCodeUnit, hashOf } from './inventory.mjs';

export function baselineSha({ collector, tests, failing }) {
  const list = tests.map((t) => [t.id, t.file, t.skipped]).sort((a, b) => byCodeUnit(a[0], b[0]));
  return hashOf(JSON.stringify({ collector, tests: list, failing: [...failing].sort(byCodeUnit) }));
}

export function referenceOf(baselines) {
  const tests = new Map();
  for (const b of baselines) {
    for (const t of b.tests) {
      const cur = tests.get(t.id);
      tests.set(t.id, cur ? { ...cur, skipped: cur.skipped && t.skipped } : { id: t.id, file: t.file, skipped: t.skipped });
    }
  }
  let failing = null;
  for (const b of baselines) failing = failing === null ? new Set(b.failing) : new Set(b.failing.filter((f) => failing.has(f)));
  return { tests: [...tests.values()], failing: [...(failing ?? [])] };
}

// { added, removed, newlySkipped, allowedBy, unallowed }: unallowed lists the removed and newly skipped IDs that no
// allowance covers (allowances: active decisions as { id, allowsTestRemoval: [test IDs] }).
export function compareInventory(reference, inventory, allowances) {
  const before = new Map(reference.tests.map((t) => [t.id, t]));
  const now = new Map(inventory.tests.map((t) => [t.id, t]));
  const added = [...now.keys()].filter((id) => !before.has(id)).sort(byCodeUnit);
  const removed = [...before.keys()].filter((id) => !now.has(id)).sort(byCodeUnit);
  const newlySkipped = [...now.values()].filter((t) => t.skipped && before.has(t.id) && !before.get(t.id).skipped).map((t) => t.id).sort(byCodeUnit);
  const allowedBy = new Set();
  const unallowed = [];
  for (const id of [...removed, ...newlySkipped]) {
    const by = allowances.filter((d) => Array.isArray(d.allowsTestRemoval) && d.allowsTestRemoval.includes(id)).map((d) => d.id);
    if (by.length) for (const d of by) allowedBy.add(d);
    else unallowed.push(id);
  }
  return { added, removed, newlySkipped, allowedBy: [...allowedBy].sort(byCodeUnit), unallowed };
}

export const fingerprint = ({ id, location = '', message = '' }) => `${id}@${hashOf(`${location}\n${message}`, 12)}`;

// Whether the failures of one collected part are all pinned (known: a Set of reference fingerprints).
export function excusable(part, known) {
  const prints = part.failing.map(fingerprint);
  return prints.length > 0 && prints.every((f) => known.has(f)) && (part.failCount === null || part.failCount === undefined || part.failCount <= prints.length);
}

// { preexisting, new } of the current fingerprints against the reference's.
export function splitFailures(referenceFailing, current) {
  const known = new Set(referenceFailing);
  const unique = [...new Set(current)];
  return { preexisting: unique.filter((f) => known.has(f)).sort(byCodeUnit), new: unique.filter((f) => !known.has(f)).sort(byCodeUnit) };
}
