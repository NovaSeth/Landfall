// Profile unit (spec §4.2, §7.3, SD-12): facts, observation scan, question bank. Other units import only this
// file. profile.json and local/scan-cache.json are written only through lib/state (kind.mjs), and only in an
// active repository: an inactive one is observed read-only (GC2, zero footprint).
// Gate changes after activation are decisions (spec §7.3, §7.6, GC3: a weaker gate weakens the oracle): applyGates
// (the observed candidates) and setGate (one gate by name) need an active gate-change decision (lib/decisions
// requireDecision: exit 1 otherwise, nothing written).
import { relative, isAbsolute } from 'node:path';
import { requireDecision } from '../decisions/index.mjs';
import { PATTERNS, StateError } from '../state/index.mjs';
import { GATE_KINDS, LIMITS, ProfileError, hasForbidden, parseValue, requireFactKey, CONFIDENCE_OF } from './keys.mjs';
import { emptyProfile, openStore } from './kind.mjs';
import { merge, sameValue } from './merge.mjs';
import { GATE_TIMEOUT_S, SCANNER, observe } from './observe.mjs';
import { commitsSince, headOf, scanDue } from './triggers.mjs';

export { CONFIDENCE, CONFIDENCE_OF, FACT_KEYS, GATE_KINDS, KEYS, LIMITS, ProfileError, SOURCES, STRUCTURED_KEYS, parseValue, validValue } from './keys.mjs';
export { PROFILE_KINDS, emptyProfile, openStore } from './kind.mjs';
export { SCANNED_KEYS, SCANNER, listFiles, observe, observeFiles } from './observe.mjs';
export { SAID_OUTRANKS_DAYS, merge, sameValue } from './merge.mjs';
export { QUESTIONS, QUESTION_CAPS, confirmation, pendingQuestions } from './questions.mjs';
export { TRIGGERS, commitsSince, headOf, scanDue } from './triggers.mjs';
export { factValues } from './values.mjs';

const nowIso = () => new Date().toISOString();

// The state directory relative to the repository when it lives inside it (its files are not project files).
function insideRepo(where) {
  const rel = relative(where.repo, where.dir).split('\\').join('/');
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}

// The scan cache is only a cache: an invalid one is a miss and is replaced; one written by a newer plugin is
// neither read nor replaced. Other errors (locks) are real.
function cacheOp(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StateError && (err.code === 'state-invalid' || err.code === 'schema-newer')) return null;
    throw err;
  }
}

// The profile of a resolved repository (lib/state resolve): { active, profile, scan }. profile: the stored
// document (an empty one when the repository is active but not yet scanned), null when inactive.
export function readProfile(where, { names, env, now = nowIso() }) {
  const store = openStore(where.dir, names);
  if (!store.active) return { active: false, profile: null, scan: null };
  const profile = store.read('profile') ?? emptyProfile();
  const commits = profile.lastScan ? commitsSince(where.repo, profile.lastScan.head, { env }) : null;
  return { active: true, profile, scan: scanDue(profile, { commits, now }) };
}

// Observes the repository and, when it is active, merges the observation into profile.json and caches it by
// HEAD in local/scan-cache.json (a cached observation of the same HEAD and scanner is reused).
export function runObserve(where, { names, env, now = nowIso() }) {
  const store = openStore(where.dir, names);
  const active = store.active;
  const head = headOf(where.repo, { env });
  let observation = null;
  let cached = false;
  if (active && head) {
    const cache = cacheOp(() => store.read('scanCache'));
    if (cache && cache.head === head && cache.scanner === SCANNER) {
      observation = cache.observation;
      cached = true;
    }
  }
  observation ??= observe(where.repo, { env, exclude: insideRepo(where) });
  if (!active) return { active, written: false, cached, head, observation, changed: [], removed: [], conflicts: [], gates: null };
  let result;
  store.update('profile', null, (cur) => {
    result = merge(cur ?? emptyProfile(), observation, { now, head });
    return result.profile;
  });
  if (head && !cached) cacheOp(() => store.write('scanCache', null, { scanner: SCANNER, head, at: now, observation }));
  const { changed, removed, conflicts, gates } = result;
  return { active, written: true, cached, head, observation, changed, removed, conflicts, gates };
}

// Records one fact (spec §7.3: `profile set <key> <value> --source said|observed --evidence <t>`). A said fact
// outranks an observed one: an observed value never replaces a different said value (said-outranks, FAIL).
// Returns { fact, previous }.
export function setFact(where, { names, key, raw, source, evidence, now = nowIso() }) {
  requireFactKey(key);
  if (source === undefined) throw new ProfileError('missing-source', 'USAGE', 'profile set needs --source said|observed', { hint: 'said: the user stated it (quote as evidence); observed: seen in the repository (path:line as evidence)' });
  if (source !== 'said' && source !== 'observed') throw new ProfileError('invalid-source', 'USAGE', `--source must be said or observed, got ${JSON.stringify(String(source)).slice(0, 40)}`, { hint: 'default values come only from imports, never from profile set' });
  if (typeof evidence !== 'string' || evidence.trim() === '') throw new ProfileError('missing-evidence', 'USAGE', 'profile set needs --evidence: the user\'s words or path:line', { hint: '--evidence "<quote of ≤ 300 characters>"' });
  if ([...evidence].length > 300) throw new ProfileError('limit-exceeded', 'USAGE', `--evidence has ${[...evidence].length} characters; the limit is 300`, { hint: 'quote the shortest part that states the fact; nothing was written' });
  const value = parseValue(key, raw);
  const store = openStore(where.dir, names);
  if (!store.active) throw new ProfileError('inactive', 'REFUSED', `${where.repo} is not active: the profile is written only after activation`, { hint: `start tracking first (/${names.plugin}:start); nothing was written` });
  const fact = { value, source, evidence, confidence: CONFIDENCE_OF[source], at: now };
  let previous = null;
  store.update('profile', null, (cur) => {
    const doc = cur ?? emptyProfile();
    previous = doc.facts[key] ?? null;
    if (source === 'observed' && previous?.source === 'said' && !sameValue(previous.value, value)) {
      throw new ProfileError('said-outranks', 'FAIL', `${key} was said to be ${JSON.stringify(previous.value)}; an observed value does not replace it`, { hint: 'ask the user, then record the answer with --source said' });
    }
    doc.facts[key] = fact;
    return doc;
  });
  return { fact, previous };
}

const GATE_DECISION = Object.freeze(['gate-change']);
const badGate = (message, hint) => new ProfileError('invalid-value', 'USAGE', message, { hint });

function gateStore(where, names) {
  const store = openStore(where.dir, names);
  if (!store.active) throw new ProfileError('inactive', 'REFUSED', `${where.repo} is not active: the gates are written only after activation`, { hint: `start tracking first (/${names.plugin}:start); nothing was written` });
  return store;
}

// Replaces the gates with the candidates the observation scan detects (cached by HEAD, else a fresh read-only scan).
// Returns { gates, previous, changed, decision }.
export function applyGates(where, { names, env, decision }) {
  const store = gateStore(where, names);
  const record = requireDecision({ dir: where.dir, id: decision, kinds: GATE_DECISION, names, what: 'a gate change' });
  const head = headOf(where.repo, { env });
  const cache = head ? cacheOp(() => store.read('scanCache')) : null;
  const observation = cache && cache.head === head && cache.scanner === SCANNER ? cache.observation : observe(where.repo, { env, exclude: insideRepo(where) });
  if (observation.gates.length === 0) throw new ProfileError('no-candidates', 'FAIL', `the scan of ${where.repo} detects no gate candidates; nothing was written`, { hint: `add one with '${names.bin} profile gates set <name> <cmd> --decision ${record.id}'` });
  let previous = [];
  let changed = false;
  store.update('profile', null, (cur) => {
    const doc = cur ?? emptyProfile();
    previous = doc.gates;
    changed = JSON.stringify(doc.gates) !== JSON.stringify(observation.gates);
    return changed ? { ...doc, gates: structuredClone(observation.gates) } : undefined;
  });
  return { gates: observation.gates, previous, changed, decision: record.id };
}

// Adds the gate `name` or replaces it in place: cmd, kind (default: the replaced gate's, else other) and timeoutS
// (default: the replaced gate's, else the scan's). Returns { gate, previous (the replaced gate or null), decision }.
export function setGate(where, { names, name, cmd, kind, timeout, decision }) {
  if (typeof name !== 'string' || !PATTERNS.kebab.test(name) || name.length > LIMITS.gateName) throw badGate(`gate name ${JSON.stringify(String(name).slice(0, 40))} is not a kebab-case name of at most ${LIMITS.gateName} characters`, 'such as unit or e2e-smoke');
  if (typeof cmd !== 'string' || cmd.trim() === '' || [...cmd].length > LIMITS.gateCmd || hasForbidden(cmd)) throw badGate(`the gate command must be 1 to ${LIMITS.gateCmd} characters without control, zero-width or bidi characters`, 'quote it as one argument');
  if (kind !== undefined && !GATE_KINDS.includes(kind)) throw badGate(`--kind ${JSON.stringify(String(kind).slice(0, 20))} is not one of ${GATE_KINDS.join(', ')}`, 'a test gate is the one verify collects the tests from');
  const seconds = timeout === undefined ? undefined : /^[1-9]\d{0,4}$/.test(String(timeout)) ? Number(timeout) : NaN;
  if (Number.isNaN(seconds) || seconds > LIMITS.timeoutS) throw badGate(`--timeout must be a whole number of seconds from 1 to ${LIMITS.timeoutS}`, `the scan uses ${GATE_TIMEOUT_S}`);
  const store = gateStore(where, names);
  const record = requireDecision({ dir: where.dir, id: decision, kinds: GATE_DECISION, names, what: 'a gate change' });
  let previous = null;
  let gate = null;
  store.update('profile', null, (cur) => {
    const doc = cur ?? emptyProfile();
    const at = doc.gates.findIndex((g) => g.name === name);
    previous = at < 0 ? null : doc.gates[at];
    gate = { name, cmd, timeoutS: seconds ?? previous?.timeoutS ?? GATE_TIMEOUT_S, kind: kind ?? previous?.kind ?? 'other' };
    const gates = [...doc.gates];
    if (at < 0) gates.push(gate); else gates[at] = gate;
    return { ...doc, gates };
  });
  return { gate, previous, decision: record.id };
}
