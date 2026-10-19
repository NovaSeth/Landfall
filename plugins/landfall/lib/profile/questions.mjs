// Question bank (spec §7.3, SD-12): each question names the capability it decides and the observation that would
// answer it. A question is asked only while its key has no said or observed fact (a default is no answer), no
// signal answers it, and its answer would flip a capability; at most 3 on activation and 1 per later session
// (counting the questions already asked then). A said fact contradicted by an observation ≥ 14 days newer is
// asked once more (merge.mjs conflicts), before the bank. `deadline` is captured when said, never asked.
import { activePacks, openMethod, TIERS } from '../method/index.mjs';
import { factValues } from './values.mjs';

export const QUESTION_CAPS = Object.freeze({ activation: 3, session: 1 });

const tierAtLeast = (tier, min) => TIERS.indexOf(TIERS.includes(tier) ? tier : 'L0') >= TIERS.indexOf(min);
// True when two answers give different method packs, with every other fact and signal as it is.
const packsDiffer = (key, answers) => ({ values, packs }) => {
  const sets = Object.values(answers).map((v) => activePacks(packs, { ...values, [key]: v }).sort().join(','));
  return new Set(sets).size > 1;
};

export const QUESTIONS = Object.freeze([
  {
    id: 'Q-people',
    key: 'people',
    text: 'Will anyone else commit here in the next month?',
    decides: ['lanes', 'ci-gate'],
    observation: 'contributors30 ≥ 2: two or more people committed in the last 30 days (git history)',
    answers: { yes: 'small-team', no: 'solo' },
    observed: ({ signals }) => Number(signals.contributors30) >= 2,
    flips: ({ signals }) => !tierAtLeast(signals.tier, 'L2'), // lanes and the CI gate are on from L2
  },
  {
    id: 'Q-data',
    key: 'dataSensitivity',
    text: 'Will it store personal, payment or health data?',
    decides: ['security-pack', 'data-path-review'],
    observation: 'none in the repository: schemas do not show what users will store',
    answers: { no: 'none', personal: 'personal', payment: 'payment', health: 'health' },
    observed: () => false,
    flips: packsDiffer('dataSensitivity', { no: 'none', personal: 'personal' }),
  },
  {
    id: 'Q-live',
    key: 'deployedToUsers',
    text: 'Is it used by people now, or not yet released?',
    decides: ['runbooks-pack', 'release-pack', 'incident-signal'],
    observation: 'none in the repository: a deploy configuration shows intent, not users',
    answers: { now: true, 'not yet': false },
    observed: () => false,
    flips: packsDiffer('deployedToUsers', { now: true, 'not yet': false }),
  },
]);

const view = ({ id, key, text, decides, observation, answers }) => ({ id, key, text, decides: [...decides], observation, answers: { ...answers } });
const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v));

// The one confirmation question of an askable conflict (merge.mjs).
export const confirmation = (c) => ({
  id: `Q-confirm-${c.key}`,
  key: c.key,
  text: `Earlier the profile recorded ${c.key} = ${show(c.said)} from what you said; the repository now shows ${show(c.observed)} (${c.evidence}). Which is right?`,
  decides: [`the ${c.key} fact`],
  observation: c.evidence,
  answers: null,
});

// The questions to ask now, in order. moment: 'activation' | 'session'; asked: questions already asked at this
// moment; signals: engine signals ({tier, contributors30, incidents30, …}); packs: the method index packs table.
export function pendingQuestions(profile, { moment, asked = 0, signals = {}, packs = openMethod().index.packs, conflicts = [] } = {}) {
  if (!Object.hasOwn(QUESTION_CAPS, moment)) throw new TypeError(`pendingQuestions: moment must be one of ${Object.keys(QUESTION_CAPS).join(', ')}, got ${moment}`);
  const room = Math.max(0, QUESTION_CAPS[moment] - asked);
  const values = { ...factValues(profile), ...signals };
  const out = conflicts.filter((c) => c.askable).map(confirmation);
  for (const q of QUESTIONS) {
    const fact = profile?.facts?.[q.key];
    if (fact && fact.source !== 'default') continue;
    if (q.observed({ signals })) continue;
    if (!q.flips({ values, signals, packs })) continue;
    out.push(view(q));
  }
  return out.slice(0, room);
}
