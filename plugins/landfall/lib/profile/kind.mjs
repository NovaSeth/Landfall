// Profile state files (spec §5.1, §5.2, §4.2): profile.json (committed) and local/scan-cache.json (the last
// observation by HEAD, never leaves the machine). Both are lib/state kinds: the profile unit reads and writes them
// only through a store opened with these kinds (lib/state open), so every write is validated, atomic, locked and
// refused for a newer schema like any other state file.
import { KINDS, PATTERNS, defineKind, open } from '../state/index.mjs';
import { CONFIDENCE, FACT_KEYS, GATE_KINDS, LIMITS, SOURCES } from './keys.mjs';

const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
const enumOf = (of, extra = {}) => ({ t: 'enum', of, ...extra });
const time = { t: 'time' };
const head = str(64, { re: PATTERNS.sha, null: true });

function valueSpec({ type, of }) {
  switch (type) {
    case 'text': return str(LIMITS.value, { min: 1 });
    case 'enum': return enumOf(of);
    case 'bool': return enumOf([true, false]);
    case 'date': return str(10, { re: /^\d{4}-\d{2}-\d{2}$/ });
    case 'token': return str(LIMITS.token, { re: PATTERNS.kebab });
    case 'list': return { t: 'arr', max: LIMITS.listItems, of: str(LIMITS.listItem, { min: 1, re: /^[^,A-Z]+$/ }) };
    default: throw new Error(`profile: unknown value type ${type}`);
  }
}
const evidence = str(LIMITS.evidence, { min: 1 });
const confidence = enumOf(CONFIDENCE);
const allFacts = (entry) => ({ t: 'obj', f: Object.fromEntries(Object.entries(FACT_KEYS).map(([k, spec]) => [k, entry(valueSpec(spec))])), opt: Object.keys(FACT_KEYS) });
const gates = {
  t: 'arr', max: LIMITS.gates,
  of: { t: 'obj', f: { name: str(LIMITS.gateName, { re: PATTERNS.kebab }), cmd: str(LIMITS.gateCmd, { min: 1 }), timeoutS: { t: 'int', min: 1, max: LIMITS.timeoutS }, kind: enumOf(GATE_KINDS) } },
};
const riskPaths = { t: 'arr', max: LIMITS.riskPaths, of: str(LIMITS.glob, { min: 1 }) };

// An observation: what the scan saw (facts without source and time), gate candidates, risk globs, files scanned.
const observation = {
  t: 'obj',
  f: { facts: allFacts((value) => ({ t: 'obj', f: { value, evidence, confidence } })), gates, riskPaths, files: { t: 'int', min: 0, max: 100000000 } },
};

export const PROFILE_KINDS = Object.freeze({
  profile: defineKind('profile', 1, {
    dir: '',
    file: () => 'profile.json',
    match: /^profile\.json$/,
    fields: {
      facts: allFacts((value) => ({ t: 'obj', f: { value, source: enumOf(SOURCES), evidence, confidence, at: time } })),
      gates,
      riskPaths,
      lastScan: { t: 'obj', f: { head, at: time }, null: true },
    },
  }),
  scanCache: defineKind('scanCache', 1, {
    dir: 'local',
    file: () => 'local/scan-cache.json',
    match: /^local\/scan-cache\.json$/,
    fields: { scanner: { t: 'int', min: 1, max: 1000 }, head: str(64, { re: PATTERNS.sha }), at: time, observation },
  }),
});

// The store of a state directory with the profile kinds added.
export const openStore = (dir, names) => open(dir, { names, kinds: { ...KINDS, ...PROFILE_KINDS } });

export const emptyProfile = () => ({ schema: PROFILE_KINDS.profile.version, facts: {}, gates: [], riskPaths: [], lastScan: null });
