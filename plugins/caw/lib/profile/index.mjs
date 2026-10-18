// Profile unit (spec §4.2, §7.3, SD-12): facts, observation scan, question bank. Other units import only this
// file. profile.json and local/scan-cache.json are written only through lib/state (kind.mjs), and only in an
// active repository: an inactive one is observed read-only (GC2, zero footprint). The code observed is the worktree's
// (lib/state resolve: the git top level of the current directory), its HEAD the scan head; the profile is the project's.
import { relative, isAbsolute } from 'node:path';
import { StateError } from '../state/index.mjs';
import { ProfileError, parseValue, requireFactKey, CONFIDENCE_OF } from './keys.mjs';
import { emptyProfile, openStore } from './kind.mjs';
import { merge, sameValue } from './merge.mjs';
import { SCANNER, observe } from './observe.mjs';
import { commitsSince, headOf, scanDue } from './triggers.mjs';

export { CONFIDENCE, CONFIDENCE_OF, FACT_KEYS, GATE_KINDS, KEYS, LIMITS, ProfileError, SOURCES, STRUCTURED_KEYS, parseValue, validValue } from './keys.mjs';
export { PROFILE_KINDS, emptyProfile, openStore } from './kind.mjs';
export { SCANNED_KEYS, SCANNER, listFiles, observe, observeFiles } from './observe.mjs';
export { SAID_OUTRANKS_DAYS, merge, sameValue } from './merge.mjs';
export { QUESTIONS, QUESTION_CAPS, confirmation, pendingQuestions } from './questions.mjs';
export { TRIGGERS, commitsSince, headOf, scanDue } from './triggers.mjs';
export { factValues } from './values.mjs';

const nowIso = () => new Date().toISOString();

// The state directory relative to the repository when it lives inside it (its files are not project files): a tree
// path, the same in every worktree of the project.
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
  const commits = profile.lastScan ? commitsSince(where.worktree, profile.lastScan.head, { env }) : null;
  return { active: true, profile, scan: scanDue(profile, { commits, now }) };
}

// Observes the repository and, when it is active, merges the observation into profile.json and caches it by
// HEAD in local/scan-cache.json (a cached observation of the same HEAD and scanner is reused).
export function runObserve(where, { names, env, now = nowIso() }) {
  const store = openStore(where.dir, names);
  const active = store.active;
  const head = headOf(where.worktree, { env });
  let observation = null;
  let cached = false;
  if (active && head) {
    const cache = cacheOp(() => store.read('scanCache'));
    if (cache && cache.head === head && cache.scanner === SCANNER) {
      observation = cache.observation;
      cached = true;
    }
  }
  observation ??= observe(where.worktree, { env, exclude: insideRepo(where) });
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
