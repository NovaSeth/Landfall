// Tier decision (spec §7.4, SD-13, SC11): pure functions over daily signal series, no I/O and no stored counters.
// Thresholds are data (thresholds.json, defaults to calibrate with a decision). A tier signal has levels
// { tier, up, down } and a dwell in days:
//   up    the level is reached when today's value is ≥ up (contributors30 counts only authors with commits on
//         `distinctDays` days of its window, which is its dwell rule for rising);
//   down  a reached level is kept until the value stayed under `down` (value < down) on every day of the dwell
//         window ending today; a window shorter than the dwell keeps the level.
// Tier = the highest level any signal reaches or keeps (keeping counts only up to the current tier), at least the
// floor of a profile fact (deployedToUsers → L1). The current tier and the day of its last change come from the
// record of the last change (shadow log or tier decision); a different tier takes effect only when
// `changeEveryDays` days passed since that change, else it waits (the first change never waits).
// A toggle (a capability that follows one signal) is on from the last day its value was ≥ up until a run of
// `dwellDays` days under `down` after it; the series it gets is its whole lookback, so no state is stored.
import { readFileSync } from 'node:fs';
import { TIERS } from '../method/index.mjs';

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const THRESHOLDS = deepFreeze(JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8')));
export { TIERS };
if (JSON.stringify(Object.keys(THRESHOLDS.tiers)) !== JSON.stringify(TIERS)) throw new Error('lib/engine/thresholds.json: tiers differ from the method tiers; reinstall the plugin');
export const TIER_NAMES = THRESHOLDS.tiers;

const DAY_MS = 86400000;
export const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
export const dayString = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (day, n) => dayString(dayNumber(day) + n);
export const rank = (tier) => TIERS.indexOf(tier);

// The tier after one evaluation. current: { tier, since: 'YYYY-MM-DD' | null }; series: { <signal>: [values,
// oldest first, the last one today] } for every tier signal; facts: profile fact values; today: 'YYYY-MM-DD'.
// Returns { tier, previous, target, change: {from, to} | null, waiting: {to, until} | null, reasons, signals }.
export function decideTier({ current = { tier: 'L0', since: null }, series, facts = {}, today, thresholds = THRESHOLDS }) {
  const from = TIERS.includes(current.tier) ? current.tier : 'L0';
  let target = 0;
  const reasons = [];
  const signals = {};
  for (const [name, rule] of Object.entries(thresholds.tierSignals)) {
    const values = series[name] ?? [];
    const value = values.length ? values[values.length - 1] : 0;
    const window = values.slice(-rule.dwellDays);
    let raises = null;
    let holds = null;
    for (const level of rule.levels) {
      if (value >= level.up) raises = level.tier;
      const below = window.length >= rule.dwellDays && window.every((v) => v < level.down);
      if (rank(level.tier) <= rank(from) && !below) holds = level.tier;
    }
    signals[name] = { value, raises, holds };
    if (raises) reasons.push(`${name} ${value} ≥ ${rule.levels.find((l) => l.tier === raises).up} → ${raises}`);
    if (holds && rank(holds) > rank(raises ?? 'L0')) {
      reasons.push(`${name} ${value} keeps ${holds}: not under ${rule.levels.find((l) => l.tier === holds).down} for all of the last ${rule.dwellDays} days`);
    }
    target = Math.max(target, rank(raises ?? 'L0'), rank(holds ?? 'L0'));
  }
  for (const [fact, tier] of Object.entries(thresholds.floors)) {
    if (facts[fact] === true) {
      reasons.push(`${fact} → ${tier} floor`);
      target = Math.max(target, rank(tier));
    }
  }
  const to = TIERS[target];
  let tier = from;
  let change = null;
  let waiting = null;
  if (to !== from) {
    const until = current.since ? addDays(current.since, thresholds.changeEveryDays) : null;
    if (until && dayNumber(today) < dayNumber(until)) waiting = { to, until };
    else {
      tier = to;
      change = { from, to };
    }
  }
  return { tier, previous: from, target: to, change, waiting, reasons, signals };
}

// A capability following one signal: values oldest first (the last one today); rule { up, down, dwellDays }.
export function toggle(values, { up, down, dwellDays }) {
  let last = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] >= up) { last = i; break; }
  }
  if (last < 0) return false;
  let run = 0;
  for (let i = last + 1; i < values.length; i++) {
    run = values[i] < down ? run + 1 : 0;
    if (run >= dwellDays) return false;
  }
  return true;
}
