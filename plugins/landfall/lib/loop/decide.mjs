// The loop decision of one tick (spec §7.7 steps 1, 2, 4, 5, 6; SD-17; SC7; GC4), a pure function of the loop
// document and what the tick observed. In order:
//   1. an exit is recorded → that exit again, nothing changes (idempotent)
//   2. the tick counts (ticks + 1); a cap reached → BUDGET: first wall time since startedAt and ticks (cheapCap: the
//      caller checks them before it measures anything that can fail), then the cost since start (it never decreases:
//      a source that disappears never lowers it), then UNMEASURED ticks in a row whose cost could not be measured
//   4. the fingerprint: unchanged → sameCount + 1, else 0 and sameSince = now; sameCount ≥ 3 and ≥ 30 min since
//      sameSince and no live run → STALLED
//   5. the outcome of the tick table: done → DONE, wait → WAIT (NEXT_TICK seconds), action → ACTION
//   6. a terminal exit sets exit, exitAt and reason in the returned document; the caller writes it under the store
//      lock before printing anything.
// Caps never change here (no automatic extension). parseCaps reads the `--caps k=v,…` of `loop start`.
import { StateError } from '../state/index.mjs';
import { CAP_RANGE, DEFAULT_CAPS, STALL, UNMEASURED } from './kind.mjs';

const MIN_MS = 60000;
const iso = (ms) => new Date(ms).toISOString();
const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;

// A loop document that starts now with `caps` (the defaults when omitted).
export function newLoop({ now, caps = DEFAULT_CAPS, id = null }) {
  const stamp = iso(now).replace(/\D/g, '').slice(0, 14);
  const suffix = id ?? Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
  return {
    schema: 1, id: `L-${stamp}-${suffix}`, startedAt: iso(now), caps: { ...caps }, ticks: 0, fingerprint: null, sameCount: 0, sameSince: null,
    costMicroUsd: 0, unmeasured: 0, exit: null, exitAt: null, reason: null, extensions: [],
  };
}

// The wall time or tick cap the next tick of `loop` reaches at `now`, as a reason, or null. Nothing here can fail, so
// the tick checks these caps before it measures the cost or reads anything else (GC4).
export function cheapCap(loop, now) {
  const { caps } = loop;
  const wallMin = Math.floor((now - Date.parse(loop.startedAt)) / MIN_MS);
  if (wallMin >= caps.wallMin) return `wall time cap reached: ${wallMin} of ${caps.wallMin} min`;
  const ticks = loop.ticks + 1;
  if (ticks >= caps.ticks) return `tick cap reached: ${ticks} of ${caps.ticks} ticks`;
  return null;
}

// obs: { now (ms), fingerprint (sha256 hex), costMicroUsd (since startedAt; null: not measured, because a cheap cap
// ends this tick), unmeasurable (the cost could not be measured at all), liveRuns, outcome: action|wait|done,
// nextTickS }. Returns { doc, result: ACTION|WAIT|DONE|STALLED|BUDGET, reason, nextTickS, repeated }.
export function decide(loop, { now, fingerprint, costMicroUsd = null, unmeasurable = false, liveRuns, outcome, nextTickS }) {
  if (loop.exit) return { doc: loop, result: loop.exit, reason: loop.reason, nextTickS: null, repeated: true };
  const ticks = loop.ticks + 1;
  const same = loop.fingerprint !== null && loop.fingerprint === fingerprint;
  const doc = {
    ...loop, ticks, fingerprint, costMicroUsd: Math.max(loop.costMicroUsd, costMicroUsd ?? 0), unmeasured: unmeasurable ? loop.unmeasured + 1 : 0,
    sameCount: same ? loop.sameCount + 1 : 0,
    sameSince: same ? loop.sameSince : iso(now),
  };
  const end = (result, reason) => ({ doc: { ...doc, exit: result, exitAt: iso(now), reason }, result, reason, nextTickS: null, repeated: false });
  const cap = cheapCap(loop, now)
    ?? (doc.costMicroUsd >= loop.caps.costMicroUsd ? `cost cap reached: ${usd(doc.costMicroUsd)} of ${usd(loop.caps.costMicroUsd)} (estimate)` : null)
    ?? (doc.unmeasured >= UNMEASURED ? `cost-unmeasurable: the cost since the start could not be measured for ${doc.unmeasured} ticks in a row` : null);
  if (cap) return end('BUDGET', cap);
  const quietMin = Math.floor((now - Date.parse(doc.sameSince)) / MIN_MS);
  if (doc.sameCount >= STALL.ticks && quietMin >= STALL.minutes && liveRuns === 0) {
    return end('STALLED', `no progress: the same state for ${doc.sameCount + 1} ticks over ${quietMin} min with no live run`);
  }
  if (outcome === 'done') return end('DONE', 'every task in scope is done or cancelled');
  if (outcome === 'wait') return { doc, result: 'WAIT', reason: null, nextTickS, repeated: false };
  return { doc, result: 'ACTION', reason: null, nextTickS: null, repeated: false };
}

const usage = (message, hint = 'wallMin=<minutes>,ticks=<n>,usd=<dollars>,rounds=<n>') => new StateError('invalid-value', 'USAGE', message, { hint });
const KEYS = { wallMin: 'wallMin', ticks: 'ticks', usd: 'costMicroUsd', rounds: 'rounds' };

// Whole micro-dollars of a decimal dollar amount (at most 6 decimals), exactly (no floating point).
function microUsd(text) {
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 1e6 + Number((m[2] ?? '').padEnd(6, '0'));
}

// `wallMin=60,ticks=20,usd=1.5,rounds=1` → { wallMin: 60, ticks: 20, costMicroUsd: 1500000, rounds: 1 } (only the keys
// given). A key twice, an unknown key or a value outside its range is a usage error.
export function parseCaps(text) {
  if (typeof text !== 'string' || text.trim() === '') throw usage('--caps needs k=v pairs');
  const caps = {};
  for (const part of text.split(',')) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(part.trim());
    if (!m || !Object.hasOwn(KEYS, m[1])) throw usage(`--caps: ${JSON.stringify(part).slice(0, 60)} is not one of wallMin, ticks, usd, rounds = value`);
    const key = KEYS[m[1]];
    if (Object.hasOwn(caps, key)) throw usage(`--caps: ${m[1]} is given twice`);
    const value = key === 'costMicroUsd' ? microUsd(m[2]) : /^\d{1,9}$/.test(m[2]) ? Number(m[2]) : null;
    const [lo, hi] = CAP_RANGE[key];
    if (value === null || value < lo || value > hi) {
      const range = key === 'costMicroUsd' ? `${lo / 1e6}..${hi / 1e6} dollars, at most 6 decimals` : `a whole number ${lo}..${hi}`;
      throw usage(`--caps: ${m[1]}=${m[2].slice(0, 20)} is outside ${range}`);
    }
    caps[key] = value;
  }
  return caps;
}
