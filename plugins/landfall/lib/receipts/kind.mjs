// The `receipt` state kind (spec §5.1, §7.11, ruling R70): `receipts/<task>.json`, committed, numbers and labels only.
// Money is whole micro-dollars (costMicroUsd) and durations whole milliseconds (wallMs): lib/state has integers and
// no fractions. Written only through lib/state (store.update under the store lock, atomic replace); see save() in
// index.mjs for when a receipt is written.
import { LIMITS, PATTERNS, defineKind } from '../state/index.mjs';
import { RUN_ID } from './runs.mjs';
import { LABEL } from './sessions.mjs';

const whole = (extra = {}) => ({ t: 'int', min: 0, ...extra });
const TOKENS = { t: 'obj', f: { input: whole(), output: whole(), cacheRead: whole(), cacheWrite: whole() } };
const label = (extra = {}) => ({ t: 'str', min: 1, max: 80, re: LABEL, ...extra });
const DETAIL = { t: 'data', maxBytes: 4096, null: true }; // gates, defectsBeforeMerge: units not built yet (null)

export const RECEIPT = defineKind('receipt', 1, {
  dir: 'receipts',
  keyPattern: PATTERNS.taskId,
  file: (id) => `receipts/${id}.json`,
  match: /^receipts\/(T-[A-Z]{2,4}-[1-9]\d{0,5})\.json$/,
  key: 'task',
  fields: {
    task: { t: 'str', max: LIMITS.token, re: PATTERNS.taskId },
    class: { t: 'enum', of: ['trivial', 'standard', 'critical'], null: true },
    tier: { t: 'str', min: 1, max: 8, null: true },
    startedAt: { t: 'time', null: true },
    endedAt: { t: 'time', null: true },
    wallMs: whole({ null: true }),
    tokens: TOKENS,
    costMicroUsd: whole(),
    byAgent: { t: 'arr', max: 500, of: { t: 'obj', f: { agentType: label(), model: label(), tokens: TOKENS, costMicroUsd: whole() } } },
    external: {
      t: 'arr', max: 1000,
      of: {
        t: 'obj',
        f: {
          provider: label(), runId: { t: 'str', max: 128, re: RUN_ID }, model: label({ null: true }), tokens: { ...TOKENS, null: true },
          tokensReason: { t: 'str', min: 1, max: 200, null: true }, costMicroUsd: whole({ null: true }), wallMs: whole({ null: true }), exit: { t: 'int', null: true },
        },
      },
    },
    rounds: whole({ max: LIMITS.round, null: true }),
    gates: DETAIL,
    defectsBeforeMerge: DETAIL,
    processOverhead: { t: 'obj', f: { wrapperTokens: TOKENS, hookInjectedChars: whole({ null: true }) } },
    priceTable: { t: 'str', max: 10, re: /^\d{4}-\d\d-\d\d$/ },
    source: { t: 'str', min: 1, max: 60 },
    partial: { t: 'enum', of: [true, false] },
  },
});
