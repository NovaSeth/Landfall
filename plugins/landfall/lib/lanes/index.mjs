// Lanes unit (spec §4.2, §7.9, SD-20, N8): claim, renew, release and take over a lane by compare-and-swap on the
// claim refs of origin; the view is read from origin every time and stored nowhere. Other units import only this file.
//   claim     free → a new claim (a create: the ref must not exist) · own → renew · another developer's claim past
//             expires + 24 h → takeover, recorded in the new claim · otherwise exit 1 with the owner and expiry
//   takeover  the takeover form of claim alone: exit 1 when the lane is free, yours, or not yet open for takeover
//   renew     own only, at most once a day: a claim made less than 24 h ago is not pushed again (debounce)
//   release   own only: deletes the ref with the lease; a free lane is nothing to do
// Every write replaces exactly the claim seen (--force-with-lease). When origin rejects it the ref is read again:
// another value → the race was lost (exit 1 with the current owner); the same value → origin refuses claim refs
// (server rules: ENV push-rejected).
// ctx: { repo, env, names, handle, now } — the repository, the env of the invocation, lib/name.json, the caller's
// handle and the time (ISO). opts.seen: the claim the decision is made on (null: free); read from origin when omitted.
import { PATTERNS } from '../state/index.mjs';
import { LaneError } from './errors.mjs';
import { REMOTE, claimRef, createClaimCommit, pushClaim, readRefs } from './remote.mjs';

export { LaneError } from './errors.mjs';
export { REMOTE, claimRef } from './remote.mjs';

// Defaults to calibrate with a decision record (SD-20).
export const LANE_RULES = Object.freeze({ ttlDays: 7, graceHours: 24, renewAfterHours: 24 });
const HOUR = 3600 * 1000;
const TTL = LANE_RULES.ttlDays * 24 * HOUR;
const GRACE = LANE_RULES.graceHours * HOUR;
const RENEW_AFTER = LANE_RULES.renewAfterHours * HOUR;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const iso = (ms) => new Date(ms).toISOString();

// A lane name: the task field's pattern, and a valid git ref component (no "..", not ending in "." or ".lock").
const isLane = (lane) => typeof lane === 'string' && PATTERNS.lane.test(lane) && !lane.includes('..') && !lane.endsWith('.') && !lane.endsWith('.lock');
export function checkLane(lane) {
  if (isLane(lane)) return lane;
  throw new LaneError('invalid-lane', 'USAGE', `invalid lane name ${JSON.stringify(String(lane).slice(0, 60))}`, {
    hint: 'a lane is 1-40 characters a-z 0-9 . _ -, starting with a letter or digit, without "..", not ending in "." or ".lock"',
  });
}

// The claim of a ref: { lane, sha, handle, at, expires[, takeover] }, or { lane, sha, invalid: true } when its message
// is not a claim of this lane.
function decode({ lane, sha, message }) {
  let doc = null;
  try { doc = JSON.parse(message); } catch { /* not a claim */ }
  const valid = doc !== null && typeof doc === 'object' && doc.lane === lane && typeof doc.handle === 'string' && PATTERNS.handle.test(doc.handle)
    && TIME.test(String(doc.at)) && TIME.test(String(doc.expires)) && Date.parse(doc.expires) > Date.parse(doc.at);
  if (!valid) return { lane, sha, invalid: true };
  const claim = { lane, sha, handle: doc.handle, at: doc.at, expires: doc.expires };
  const t = doc.takeover;
  if (t && typeof t === 'object' && PATTERNS.handle.test(String(t.from)) && SHA.test(String(t.claim)) && TIME.test(String(t.expires))) {
    claim.takeover = { from: t.from, claim: t.claim, expires: t.expires };
  }
  return claim;
}

// live until expires · expired during the grace · takeover once expires + 24 h < now (spec §7.9).
export function laneState(claim, now) {
  if (claim.invalid) return 'invalid';
  const t = Date.parse(now);
  const expires = Date.parse(claim.expires);
  if (t <= expires) return 'live';
  return t > expires + GRACE ? 'takeover' : 'expired';
}
export const takeoverAfter = (claim) => iso(Date.parse(claim.expires) + GRACE);

export const readLanes = (ctx) => readRefs(ctx, { isLane }).map(decode);
export const readLane = (ctx, lane) => readRefs(ctx, { lane: checkLane(lane), isLane }).map(decode)[0] ?? null;

// What a command shows about the claim in the way.
const details = (c, now) => (c.invalid
  ? { owner: null, sha: c.sha, state: 'invalid' }
  : { owner: c.handle, expires: c.expires, state: laneState(c, now), takeoverAfter: takeoverAfter(c), sha: c.sha });

const invalidClaim = (ctx, c) => new LaneError('claim-invalid', 'FAIL', `the claim ref of ${c.lane} on ${REMOTE} (${c.sha.slice(0, 12)}) does not hold a lane claim`, {
  hint: `inspect it with git show ${c.sha.slice(0, 12)} and remove ${claimRef(ctx.names, c.lane)} on ${REMOTE} by hand`, details: details(c),
});
function held(ctx, c) {
  if (c.invalid) return invalidClaim(ctx, c);
  const when = laneState(c, ctx.now) === 'live' ? `until ${c.expires}` : `expired ${c.expires}`;
  return new LaneError('lane-held', 'FAIL', `${c.lane} is claimed by ${c.handle} (${when}); takeover is possible after ${takeoverAfter(c)}`, {
    hint: 'pick another lane, or ask the owner to release it', details: details(c, ctx.now),
  });
}
const notOwner = (ctx, c) => new LaneError('not-owner', 'FAIL', `${c.lane} is claimed by ${c.handle}, not by you (${ctx.handle})`, {
  hint: 'only the owner renews or releases a claim', details: details(c, ctx.now),
});
const notClaimed = (lane) => new LaneError('not-claimed', 'FAIL', `${lane} is not claimed on ${REMOTE}`, { hint: `claim it: lane claim ${lane}`, details: { owner: null } });
function changed(ctx, lane, current) {
  const now = current === null ? 'it is free now' : current.invalid ? 'it holds an invalid claim now' : `it is claimed by ${current.handle} now`;
  return new LaneError('lane-changed', 'FAIL', `${lane} changed on ${REMOTE} since it was read: ${now}`, {
    hint: 'read it again (lane list) and retry', details: current === null ? { owner: null } : details(current, ctx.now),
  });
}

// The compare-and-swap: replace the claim seen (null: none) by `doc` (null: delete). { won, sha, current }.
function write(ctx, lane, seen, doc) {
  const sha = doc === null ? null : createClaimCommit(ctx, doc);
  if (pushClaim(ctx, lane, { seen: seen?.sha ?? null, sha })) return { won: true, sha };
  const current = readLane(ctx, lane);
  if (sha !== null && current?.sha === sha) return { won: true, sha }; // the same claim landed from elsewhere
  if ((current?.sha ?? null) === (seen?.sha ?? null)) {
    throw new LaneError('push-rejected', 'ENV', `${REMOTE} rejected the update of ${claimRef(ctx.names, lane)} although the claim did not change`, {
      hint: `server rules (branch protection, hooks) must allow pushes to refs/heads/${ctx.names.claimRefPrefix}*`,
    });
  }
  return { won: false, current };
}

const newClaim = (ctx, lane, extra = {}) => ({ lane, handle: ctx.handle, at: ctx.now, expires: iso(Date.parse(ctx.now) + TTL), ...extra });
const current = (ctx, lane, seen) => (seen === undefined ? readLane(ctx, lane) : seen);

// `lane claim` (takeover: false) and `lane takeover` (takeover: true): { lane, action, claim, previous }.
export function claimLane(ctx, lane, { seen, takeover = false } = {}) {
  checkLane(lane);
  const s = current(ctx, lane, seen);
  let doc;
  if (s === null) {
    if (takeover) throw notClaimed(lane);
    doc = newClaim(ctx, lane);
  } else if (s.invalid) {
    throw invalidClaim(ctx, s);
  } else if (s.handle === ctx.handle) {
    if (takeover) throw new LaneError('own-lane', 'FAIL', `${lane} is yours already (until ${s.expires})`, { hint: `renew it: lane renew ${lane}`, details: details(s, ctx.now) });
    return renewLane(ctx, lane, { seen: s });
  } else if (laneState(s, ctx.now) !== 'takeover') {
    throw held(ctx, s);
  } else {
    doc = newClaim(ctx, lane, { takeover: { from: s.handle, claim: s.sha, expires: s.expires } });
  }
  const w = write(ctx, lane, s, doc);
  if (!w.won) throw w.current === null ? changed(ctx, lane, null) : held(ctx, w.current);
  return { lane, action: s === null ? 'claimed' : 'taken-over', claim: { sha: w.sha, ...doc }, previous: s };
}

// `lane renew`: { lane, action: renewed | debounced, claim, previous }.
export function renewLane(ctx, lane, { seen } = {}) {
  checkLane(lane);
  const s = current(ctx, lane, seen);
  if (s === null) throw notClaimed(lane);
  if (s.invalid) throw invalidClaim(ctx, s);
  if (s.handle !== ctx.handle) throw notOwner(ctx, s);
  if (Date.parse(ctx.now) - Date.parse(s.at) < RENEW_AFTER) return { lane, action: 'debounced', claim: s, previous: s };
  const doc = newClaim(ctx, lane);
  const w = write(ctx, lane, s, doc);
  if (!w.won) throw changed(ctx, lane, w.current);
  return { lane, action: 'renewed', claim: { sha: w.sha, ...doc }, previous: s };
}

// `lane release`: { lane, action: released | not-claimed, claim: null, previous }.
export function releaseLane(ctx, lane, { seen } = {}) {
  checkLane(lane);
  const s = current(ctx, lane, seen);
  if (s === null) return { lane, action: 'not-claimed', claim: null, previous: null };
  if (s.invalid) throw invalidClaim(ctx, s);
  if (s.handle !== ctx.handle) throw notOwner(ctx, s);
  const w = write(ctx, lane, s, null);
  if (!w.won) throw changed(ctx, lane, w.current);
  return { lane, action: 'released', claim: null, previous: s };
}
