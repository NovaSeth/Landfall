// The receipt's detail fields (plan M1.5, K6, K8, K17): pure builders over data the caller passes in, so lib/receipts
// never imports lib/verify (COD-20). Same input, same bytes: no time, no randomness.
//   gatesOf({ events, verify }) → { attempts, firstPass, gatesMs, heavyWaitMs, cache } | null
//   defectsOf(reviews)          → { blocking, minor, byFamily, rounds } | null
export const MAX_FAMILIES = 20;

const whole = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// attempts/firstPass come from the task's verify events; the timings from verify.json (null for a record without them).
export function gatesOf({ events = [], verify = null } = {}) {
  const attempts = events.filter((e) => e?.event === 'verify');
  if (attempts.length === 0 && !verify) return null;
  return {
    attempts: attempts.length,
    firstPass: attempts.length > 0 && attempts[0].data?.result === 'pass',
    gatesMs: whole(verify?.gatesMs),
    heavyWaitMs: whole(verify?.heavyWaitMs),
    cache: typeof verify?.cache === 'string' ? verify.cache : null,
  };
}

const familyOf = (rule) => (typeof rule === 'string' ? rule.match(/^[A-Z]+/)?.[0] ?? 'unruled' : 'unruled');
const byName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// Blocking findings by the family of their rule (P11); the families past the 20 largest are summed under `other`.
export function defectsOf(reviews = []) {
  if (reviews.length === 0) return null;
  let blocking = 0;
  let minor = 0;
  const counts = new Map();
  for (const review of reviews) {
    for (const f of review?.findings ?? []) {
      if (f.severity === 'blocking') {
        blocking += 1;
        const fam = familyOf(f.rule);
        counts.set(fam, (counts.get(fam) ?? 0) + 1);
      } else if (f.severity === 'minor') minor += 1;
    }
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || byName(a, b));
  const kept = ranked.slice(0, MAX_FAMILIES);
  const rest = ranked.slice(MAX_FAMILIES).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) kept.push(['other', rest]);
  return { blocking, minor, byFamily: Object.fromEntries(kept.sort(byName)), rounds: reviews.length };
}
