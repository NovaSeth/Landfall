// Merging an observation into the profile (spec §7.3, SD-12). Pure: returns a new document.
// - A said fact is never replaced by an observation. A contradicting observation is reported as a conflict, and
//   becomes askable once it is ≥ 14 days newer than the said fact (the agent asks once; the answer is a new said
//   fact, so the next question waits another 14 days).
// - Observed and default facts take the observed value; an unchanged observation keeps its time (no churn in the
//   committed file); an observed fact of a scanned key that the scan no longer sees is dropped.
// - Gates: the first scan after activation (no gates yet) sets them; later the candidates are only reported,
//   because a gate change after activation is a decision (kind gate-change) and weakening a gate weakens the oracle.
// - Risk paths are replaced by the observed ones; lastScan records HEAD and time.
import { isDeepStrictEqual } from 'node:util';
import { SCANNED_KEYS } from './observe.mjs';

export const SAID_OUTRANKS_DAYS = 14;
const DAY_MS = 86400000;

// Fact values compare as values; lists compare as sets.
export function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return isDeepStrictEqual([...a].sort(), [...b].sort());
  return isDeepStrictEqual(a, b);
}

export function merge(profile, observation, { now, head }) {
  const next = structuredClone(profile);
  const changed = [];
  const removed = [];
  const conflicts = [];
  for (const [key, seen] of Object.entries(observation.facts)) {
    const cur = next.facts[key];
    if (cur?.source === 'said') {
      if (!sameValue(cur.value, seen.value)) {
        const askable = Date.parse(now) - Date.parse(cur.at) >= SAID_OUTRANKS_DAYS * DAY_MS;
        conflicts.push({ key, said: cur.value, observed: seen.value, evidence: seen.evidence, saidAt: cur.at, askable });
      }
      continue;
    }
    if (cur?.source === 'observed' && sameValue(cur.value, seen.value)) continue;
    next.facts[key] = { value: seen.value, source: 'observed', evidence: seen.evidence, confidence: seen.confidence, at: now };
    changed.push(key);
  }
  for (const key of SCANNED_KEYS) {
    if (next.facts[key]?.source === 'observed' && !Object.hasOwn(observation.facts, key)) {
      delete next.facts[key];
      removed.push(key);
    }
  }
  const applied = next.gates.length === 0 && observation.gates.length > 0;
  if (applied) {
    next.gates = structuredClone(observation.gates);
    changed.push('gates');
  }
  if (!isDeepStrictEqual(next.riskPaths, observation.riskPaths)) {
    next.riskPaths = [...observation.riskPaths];
    changed.push('riskPaths');
  }
  next.lastScan = { head, at: now };
  return {
    profile: next,
    changed,
    removed,
    conflicts,
    gates: { applied, differ: !isDeepStrictEqual(next.gates, observation.gates), candidates: structuredClone(observation.gates) },
  };
}
