// Capabilities by tier (spec §7.4 table, SD-15): what scales with the tier is ceremony (review depth, spec and plan,
// scheduler, lanes, generated files, method packs); the outcome gates are the router's one frozen list for every
// tier and task class. The engine flags are the config.json `flags` keys the engine sets on a tier change in on mode:
// lanes (I2.2) and the generated files ci-gate, pre-push, codeowners, pr-template (I11). Values: on · off ·
// offered (left to the user: the engine does not set it) · `contributors` (CODEOWNERS at L2 when contributors30
// reaches codeownersContributors) · `signal` (the scheduler at L0 follows the parallelTasks toggle).
// pr-template is not in the spec table: it follows the CI gate (offered at L0–L1, on from L2), a default to calibrate.
import { OUTCOME_GATES } from '../router/index.mjs';
import { THRESHOLDS, TIERS, rank } from './tiers.mjs';

export const ENGINE_FLAGS = Object.freeze(['lanes', 'ci-gate', 'pre-push', 'codeowners', 'pr-template']);
export const CORE = Object.freeze(['router', 'verify', 'decisions', 'receipts', 'loop']);

// One row per capability, one value per tier L0–L3.
export const CAPABILITY_TABLE = Object.freeze({
  reviewStandard: Object.freeze(['self-check', 'same-provider-fresh-context', 'same-provider', 'same-provider']),
  reviewCritical: Object.freeze(['same-provider', 'cross-provider-if-available', 'cross-provider', 'cross-provider-and-area-gate']),
  specPlanCritical: Object.freeze(['plan-in-brief', 'spec-section-and-plan', 'spec-and-plan', 'spec-and-plan']),
  scheduler: Object.freeze(['signal', 'on', 'on', 'on']),
  lanes: Object.freeze(['off', 'off', 'on', 'on']),
  'ci-gate': Object.freeze(['offered', 'offered', 'on', 'on']),
  'pre-push': Object.freeze(['offered', 'offered', 'on', 'on']),
  codeowners: Object.freeze(['off', 'off', 'contributors', 'on']),
  'pr-template': Object.freeze(['offered', 'offered', 'on', 'on']),
});

// The capability set of a tier. scheduler: the parallelTasks toggle; contributors30: today's value; packs: the
// active method packs (lib/method activePacks with the tier).
export function capabilities(tier, { scheduler = false, contributors30 = 0, packs = [] } = {}) {
  const i = rank(tier);
  if (i < 0) throw new TypeError(`engine: unknown tier ${tier}; tiers are ${TIERS.join(', ')}`);
  const pick = (key) => CAPABILITY_TABLE[key][i];
  const flags = {};
  for (const f of ENGINE_FLAGS) {
    const v = pick(f);
    flags[f] = v === 'contributors' ? (contributors30 >= THRESHOLDS.codeownersContributors ? 'on' : 'off') : v;
  }
  return {
    tier,
    name: THRESHOLDS.tiers[tier],
    core: [...CORE],
    review: { standard: pick('reviewStandard'), critical: pick('reviewCritical') },
    specPlan: { critical: pick('specPlanCritical') },
    scheduler: pick('scheduler') === 'signal' ? (scheduler ? 'on' : 'off') : pick('scheduler'),
    flags,
    packs: [...packs],
    gates: OUTCOME_GATES,
  };
}
