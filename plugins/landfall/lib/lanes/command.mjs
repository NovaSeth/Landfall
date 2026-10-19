// The lane commands (spec §7.9, §8.2, SD-20): lane claim|renew|release|takeover <lane> · lane list [<lane>].
// Context comes from the target (REV-58): the repository of the current directory and its git user.email (the
// caller's handle in the team registry of its state). The writers need an active repository and a registered
// handle; list reads origin in any repository and writes nothing. The lane name is checked before any git call.
// Exit 0 done · 1 the lane is held, not yours, free (renew, takeover), yours (takeover), changed meanwhile, or its
// claim is invalid · 2 invalid lane name · 7 no consent, inactive repository, no handle, newer schema · 8 not a git
// repository, origin unreachable or refusing claim refs. SD-20: when origin cannot be reached in a project whose
// profile says people = solo, the command exits 0 with data.offline and a warning, and does nothing.
import { EXIT } from '../cli/commands.mjs';
import { factValues, openStore } from '../profile/index.mjs';
import { StateError, emailHash, gitIdentity, open, resolve } from '../state/index.mjs';
import { LANE_RULES, LaneError, REMOTE, checkLane, claimLane, laneState, readLane, readLanes, releaseLane, renewLane, takeoverAfter } from './index.mjs';

// The caller's handle: the team entry holding the hash of the repository's git user.email (null: none).
function callerHandle(store, repo, env) {
  const { email } = gitIdentity(repo, { env });
  if (!email) return null;
  const hash = emailHash(email);
  return store.list('team').find((h) => store.read('team', h)?.emailSha256 === hash) ?? null;
}

function context({ io, names }, { writer }) {
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  const handle = where.active ? callerHandle(open(where.dir, { names }), where.repo, io.env) : null;
  if (writer && !where.active) throw new LaneError('inactive', 'REFUSED', `${where.repo} is not active: a lane is claimed under your registered handle`, { hint: `'${names.bin} init' activates it` });
  if (writer && handle === null) throw new LaneError('no-handle', 'REFUSED', 'the git user.email of this repository has no registered handle here', { hint: `'${names.bin} init' registers yours` });
  return { where, ctx: { repo: where.repo, env: io.env, names, handle, now: new Date().toISOString() } };
}

// SD-20: lanes are not needed in a solo project, so an unreachable origin there is not an error. An unreadable
// profile is not solo (the error stays).
function solo(where, names) {
  if (!where.active) return false;
  try {
    return factValues(openStore(where.dir, names).read('profile')).people === 'solo';
  } catch (err) {
    if (err instanceof StateError) return false;
    throw err;
  }
}

// Runs one lane command: the lane checked first, then the context, then `op(ctx)` → { data, text }.
function run({ args, names, io }, { writer }, op) {
  const lane = args.lane;
  try {
    if (lane !== undefined) checkLane(lane);
    const { where, ctx } = context({ io, names }, { writer });
    try {
      return op(ctx);
    } catch (err) {
      if (!(err instanceof LaneError && err.code === 'remote-unreachable' && solo(where, names))) throw err;
      const what = lane === undefined ? 'nothing was read' : `nothing was done for ${lane}`;
      return {
        data: { lane, offline: true, solo: true },
        warnings: [`${err.message}; the profile says people = solo, so lanes are not needed: ${what}`],
        text: `offline (solo project): ${what}\n`,
      };
    }
  } catch (err) {
    if (err instanceof LaneError) return { code: EXIT[err.exit], data: { lane, ...err.details }, errors: [err] };
    throw err;
  }
}

const TEXT = {
  claimed: (r) => `claimed ${r.lane} until ${r.claim.expires}\n`,
  'taken-over': (r) => `took over ${r.lane} from ${r.previous.handle} (expired ${r.previous.expires}); yours until ${r.claim.expires}\n`,
  renewed: (r) => `renewed ${r.lane} until ${r.claim.expires}\n`,
  debounced: (r) => `${r.lane} is yours until ${r.claim.expires}; claimed ${r.claim.at}, less than ${LANE_RULES.renewAfterHours} h ago, so not pushed again\n`,
  released: (r) => `released ${r.lane}\n`,
  'not-claimed': (r) => `${r.lane} is not claimed: nothing to release\n`,
};
const result = (r) => ({ data: r, text: TEXT[r.action](r) });

export const laneClaim = (c) => run(c, { writer: true }, (ctx) => result(claimLane(ctx, c.args.lane)));
export const laneTakeover = (c) => run(c, { writer: true }, (ctx) => result(claimLane(ctx, c.args.lane, { takeover: true })));
export const laneRenew = (c) => run(c, { writer: true }, (ctx) => result(renewLane(ctx, c.args.lane)));
export const laneRelease = (c) => run(c, { writer: true }, (ctx) => result(releaseLane(ctx, c.args.lane)));

function row(c, ctx) {
  if (c.invalid) return { lane: c.lane, handle: null, state: 'invalid', own: false, sha: c.sha };
  const out = { lane: c.lane, handle: c.handle, at: c.at, expires: c.expires, state: laneState(c, ctx.now), takeoverAfter: takeoverAfter(c), own: c.handle === ctx.handle, sha: c.sha };
  if (c.takeover) out.takeover = c.takeover;
  return out;
}
const STATE_TEXT = {
  live: (l) => `until ${l.expires}`,
  expired: (l) => `expired ${l.expires}; takeover after ${l.takeoverAfter}`,
  takeover: (l) => `expired ${l.expires}; open for takeover`,
  invalid: (l) => `not a lane claim (${l.sha.slice(0, 12)})`,
};

export const laneList = (c) => run(c, { writer: false }, (ctx) => {
  const lane = c.args.lane;
  const lanes = (lane === undefined ? readLanes(ctx) : [readLane(ctx, lane)].filter(Boolean)).map((x) => row(x, ctx));
  const width = Math.max(1, ...lanes.map((l) => l.lane.length));
  const lines = lanes.map((l) => `${l.lane.padEnd(width)}  ${(l.handle ?? '-').padEnd(4)}  ${STATE_TEXT[l.state](l)}${l.own ? '  (yours)' : ''}`);
  const none = lane === undefined ? `no lane is claimed on ${REMOTE}` : `${lane} is free on ${REMOTE}`;
  return { data: { remote: REMOTE, handle: ctx.handle, lanes }, text: `${lines.length ? lines.join('\n') : none}\n` };
});
