// Engine unit (spec §4.2, §7.4, SD-13, SD-15, SD-38): signals → tier with hysteresis → capability set, and the record
// of a tier change. The public interface; other units import only this file. The mode is the `engine` capability flag
// (lib/config: the machine override, else config.json, else shadow):
//   shadow  a change is logged as a proposed tier decision (status proposed, signal values, thresholds, the
//           capability set) in local/shadow.jsonl through store.append; nothing is enforced. The current tier and the
//           day of its last change are the last engine line of that log. Reading the log, deciding and appending
//           happen in one section under the store lock, so concurrent evaluations log one change.
//   on      a change writes a decision record of kind tier (lib/decisions; title "Tier <to> from <from>", the signal
//           values and thresholds in its Why section), then sets the engine flags whose value at the new tier is on
//           or off in config.json (offered ones stay as the user set them). The current tier is the active tier
//           record with the latest date.
//   off     no evaluation: REFUSED naming the flag (spec §14 rollback; the CLI refuses `tier` before it runs).
// An inactive repository is evaluated from L0 and nothing is written (GC2).
// Shared gap (reported): createDecision takes no `signals` field and runs its own lock sections, so in on mode the
// values are in the record body only, and two evaluations racing on one change can both record it (same day, same
// content).
import { isDeepStrictEqual } from 'node:util';
import { authorHandle, createDecision, readRecords } from '../decisions/index.mjs';
import { modeOf, readConfig, thresholdsOf } from '../config/index.mjs';
import { activePacks, openMethod } from '../method/index.mjs';
import { LOGS, StateError, open } from '../state/index.mjs';
import { ENGINE_FLAGS, capabilities } from './capabilities.mjs';
import { readSignals } from './signals.mjs';
import { THRESHOLDS, TIER_NAMES, TIERS, decideTier, toggle } from './tiers.mjs';

export { CAPABILITY_TABLE, CORE, ENGINE_FLAGS, capabilities } from './capabilities.mjs';
export { readSignals } from './signals.mjs';
export { THRESHOLDS, TIER_NAMES, TIERS, addDays, dayNumber, dayString, decideTier, toggle } from './tiers.mjs';

export const ENGINE_FLAG = 'engine';
export const MODES = Object.freeze(['off', 'shadow', 'on']);
export const SHADOW_LOG = LOGS.shadow.file;
const TITLE = /^Tier (L[0-3]) from (L[0-3])$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const NONE = Object.freeze({ tier: 'L0', since: null, id: null });

let packs = null;
const methodPacks = () => (packs ??= openMethod().index.packs);

// The last tier change in the shadow log text: { tier, since }; lines of other capabilities and broken lines are skipped.
export function lastShadowChange(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.capability === 'engine' && e.event === 'tier' && TIERS.includes(e.to) && typeof e.at === 'string' && DATE.test(e.at)) return { tier: e.to, since: e.at.slice(0, 10), id: null };
  }
  return NONE;
}

// The current tier from the active tier records (`Tier <to> from <from>`): the latest by date, then by ID.
export function lastRecordedChange(dir) {
  const key = (doc) => {
    const [, h, n] = /^D-([A-Z]+)-(\d+)$/.exec(doc.id);
    return [doc.date, h, Number(n)];
  };
  const before = (a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  };
  let best = null;
  for (const { doc } of readRecords(dir).records) {
    if (doc.kind !== 'tier' || doc.status !== 'active' || !TITLE.test(doc.title)) continue;
    if (!best || before(best, doc)) best = doc;
  }
  return best ? { tier: TITLE.exec(best.title)[1], since: best.date, id: best.id } : NONE;
}

const shown = (v) => (v === null || v === undefined ? 'unknown' : String(v));
export const signalLine = (values) => Object.entries(values).map(([k, v]) => `${k} ${shown(v)}`).join(', ');
export function thresholdLines(thresholds = THRESHOLDS) {
  return Object.entries(thresholds.tierSignals).map(([name, rule]) => {
    const levels = rule.levels.map((l) => `${l.tier} up ≥ ${l.up}, down < ${l.down}`).join('; ');
    const extra = rule.windowDays ? ` (authors with commits on ≥ ${rule.distinctDays} days of ${rule.windowDays})` : '';
    return `- ${name}: ${levels}; dwell ${rule.dwellDays} days${extra}`;
  });
}

function recordBody(r, thresholds) {
  const flags = ENGINE_FLAGS.map((f) => `${f} ${r.capabilities.flags[f]}`).join(', ');
  const why = [
    `The engine evaluated the repository on ${r.day} at ${r.head ? r.head.slice(0, 12) : 'no commit'}; the tier changed from ${r.change.from} to ${r.change.to}.`,
    `Reasons: ${r.reasons.length ? r.reasons.join('; ') : `no signal keeps ${r.change.from}`}.`,
    `Signals: ${signalLine(r.signals)}.`,
    `Thresholds (a value ≥ up raises; a level falls only after the dwell days all under down; one change per ${thresholds.changeEveryDays} days):`,
    ...thresholdLines(thresholds),
    `Flags at ${r.change.to}: ${flags}.`,
  ].join('\n');
  const cost = 'A tier too heavy for the project adds ceremony, one too light misses review depth; the outcome gates are the same at every tier (SD-15).';
  return { why, cost };
}

function engineMode(where, names, env) {
  const mode = modeOf(ENGINE_FLAG, readConfig(where, { names, env }));
  if (mode === 'off') {
    throw new StateError('capability-off', 'REFUSED', `the ${ENGINE_FLAG} capability is off (flags.${ENGINE_FLAG}): no tier is evaluated`, { hint: `turn it back on with '${names.bin} flags set ${ENGINE_FLAG} shadow'` });
  }
  return mode;
}

// The engine thresholds of the repository `where`: the shipped ones with the overrides of its config.json.
export const engineThresholds = (where, { names, env }) => thresholdsOf('engine', THRESHOLDS, readConfig(where, { names, env }).repo).data;

// Evaluates the tier of the resolved repository `where` (lib/state resolve) at `now` and records a change by the
// mode; record: false (the status view) evaluates the same way and writes nothing, so a change is only reported.
// Returns { repo, active, mode, head, day, tier, name, previous, target, change, waiting, written (shadow |
// decision | null), decision (ID | null), reasons, signals, toggles, capabilities, detail }.
export function evaluate(where, { names, env, now = new Date().toISOString(), thresholds = engineThresholds(where, { names, env }), record = true } = {}) {
  const store = where.active ? open(where.dir, { names }) : null;
  const mode = engineMode(where, names, env);
  const s = readSignals(where, { names, env, now, thresholds });
  const toggles = {
    parallelTasks: toggle(s.series.parallelTasks, thresholds.toggles.parallelTasks),
    incidents30: toggle(s.series.incidents30, thresholds.toggles.incidents30),
  };
  const assess = (current) => {
    const d = decideTier({ current, series: s.series, facts: s.facts, today: s.day, thresholds });
    const incidents30 = toggles.incidents30 ? Math.max(...s.series.incidents30) : s.values.incidents30;
    const caps = capabilities(d.tier, { scheduler: toggles.parallelTasks, contributors30: s.values.contributors30, packs: activePacks(methodPacks(), { ...s.facts, tier: d.tier, incidents30 }) });
    return {
      repo: where.repo, active: where.active, mode, head: s.head, day: s.day, tier: d.tier, name: TIER_NAMES[d.tier], previous: d.previous, target: d.target,
      change: d.change, waiting: d.waiting, since: current.since, written: null, decision: null, reasons: d.reasons, signals: s.values, toggles, capabilities: caps, detail: d.signals,
    };
  };
  if (!store) return assess(NONE);
  if (mode === 'shadow' && !record) return assess(lastShadowChange(store.readText(SHADOW_LOG) ?? ''));
  if (mode === 'shadow') {
    let r;
    const entry = store.append('shadow', (text) => {
      r = assess(lastShadowChange(text));
      if (!r.change) return undefined;
      return {
        at: now, capability: ENGINE_FLAG, event: 'tier', status: 'proposed', kind: 'tier', from: r.change.from, to: r.change.to, head: s.head,
        signals: s.values, thresholds: thresholds.tierSignals, reasons: r.reasons, capabilities: r.capabilities,
      };
    });
    return entry ? { ...r, written: 'shadow' } : r;
  }
  const r = assess(lastRecordedChange(where.dir));
  if (!r.change || !record) return r;
  const handle = authorHandle({ store, where, names, env });
  const { why, cost } = recordBody(r, thresholds);
  const { id } = createDecision({ store, where, names, env, handle, today: s.day, input: { title: `Tier ${r.change.to} from ${r.change.from}`, why, cost, kind: 'tier', scope: [], supersedes: [] } });
  const set = {};
  for (const f of ENGINE_FLAGS) if (r.capabilities.flags[f] === 'on' || r.capabilities.flags[f] === 'off') set[f] = r.capabilities.flags[f];
  store.update('config', null, (doc) => {
    const flags = { ...(doc?.flags ?? {}), ...set };
    return isDeepStrictEqual(flags, doc?.flags ?? {}) ? undefined : { ...(doc ?? {}), flags };
  });
  return { ...r, written: 'decision', decision: id };
}
