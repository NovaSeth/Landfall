// The `loop` state kind (spec §5.2, §7.7, SD-17, ruling R70): local/loop.json, one per state directory, never
// committed. Written only through lib/state (store.update under the store lock, atomic replace). The hooks read it
// straight from the file (lib/hooks/loop-state.mjs: a JSON object; `exit` null while the loop runs, DONE, STALLED or
// BUDGET once it ended; `ticks` an integer), so the document stays small and flat. Money is whole micro-dollars,
// times are ISO strings, the wall cap whole minutes. This module imports only lib/state: a hook may import it.
import { LIMITS, PATTERNS, defineKind } from '../state/index.mjs';

export const TERMINAL = Object.freeze(['DONE', 'STALLED', 'BUDGET']);
// SD-17 defaults [8 h / 200 ticks / $25 / 2 fix rounds]; a cap is "reached" when the measured value is ≥ it.
export const DEFAULT_CAPS = Object.freeze({ wallMin: 480, ticks: 200, costMicroUsd: 25000000, rounds: 2 });
// Per cap: the allowed range of a loop's value (raising one above its default is the user's decision).
export const CAP_RANGE = Object.freeze({ wallMin: [1, 10080], ticks: [1, 10000], costMicroUsd: [1, 1e12], rounds: [1, 10] });
// SD-17 stall window [3 unchanged ticks spanning ≥ 30 min, no live run].
export const STALL = Object.freeze({ ticks: 3, minutes: 30 });
// Ticks in a row whose cost cannot be measured at all before BUDGET (cost-unmeasurable) [default 3].
export const UNMEASURED = 3;
export const LOOP_ID = /^L-\d{14}-[0-9a-f]{6}$/;

const int = ([min, max], extra = {}) => ({ t: 'int', min, max, ...extra });
const time = { t: 'time' };
const COUNT = [0, 1000000];

export const LOOP = defineKind('loop', 1, {
  dir: 'local',
  file: () => 'local/loop.json',
  match: /^local\/loop\.json$/,
  fields: {
    id: { t: 'str', min: 1, max: 40, re: LOOP_ID },
    startedAt: time,
    caps: { t: 'obj', f: Object.fromEntries(Object.entries(CAP_RANGE).map(([k, range]) => [k, int(range)])) },
    ticks: int(COUNT),
    fingerprint: { t: 'str', max: 64, re: PATTERNS.sha256, null: true },
    sameCount: int(COUNT),
    sameSince: { ...time, null: true },
    costMicroUsd: int([0, Number.MAX_SAFE_INTEGER]),
    unmeasured: int(COUNT),
    exit: { t: 'enum', of: TERMINAL, null: true },
    exitAt: { ...time, null: true },
    reason: { t: 'str', max: LIMITS.reason, null: true },
    extensions: { t: 'arr', max: 100, of: { t: 'obj', f: { at: time, caps: { t: 'data', maxBytes: 512 }, reason: { t: 'str', min: 1, max: LIMITS.reason } } } },
  },
});

// The fixed wakeup prompt (PRC-15 port, SD-18): it carries no task state, so a wakeup never goes stale. A plan travels
// in it as `--plan <path>` only in the form the wakeup guard accepts: a relative docs/plans/*.md path (CARRIED_PLAN).
export const CARRIED_PLAN = /^docs\/plans\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
export const fixedPrompt = (names, plan = null) => `Run \`${names.bin} tick${plan ? ` --plan ${plan}` : ''}\` and do the listed steps.`;
