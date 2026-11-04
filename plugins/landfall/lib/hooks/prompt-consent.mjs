// UserPromptSubmit: the human's one-time consent to `loop start` (T-MG-149, SD-17, GC4, GC8, SEC-14). After an ended loop,
// and for a cap above its default, only the user starts a loop; inside Claude Code no terminal is attached, so the
// human's own prompt carries the consent: this hook runs only on text the human submits, and the model cannot run it.
// When the prompt's first line (trimmed) is exactly `<bin> loop start`, optionally followed by ` --caps k=v,…` (the CLI's
// own form), the hook writes local/loop-consent.json of the repository's state directory through lib/state (machine-local,
// never committed; the Bash guard blocks every non-read command on the state directory): { at, expiresAt (at + 10 min),
// repo (the project's real path, lib/state resolve), session (the hook input's session_id), caps (parsed; {} for none),
// usedAt (null) }. A later prompt replaces it. The prompt is allowed unchanged, with one context line. `loop start`
// without a terminal consumes it once (consumeConsent, lib/loop). Anything else (another first line, input that is not a
// UserPromptSubmit event, no active repository) writes nothing and allows (GC8).
import { isAbsolute } from 'node:path';
import { KINDS, defineKind, open } from '../state/index.mjs';
import { parseCaps } from '../loop/decide.mjs';
import { CAP_RANGE, DEFAULT_CAPS } from '../loop/kind.mjs';
import { forModel } from '../text/clean.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

export const CONSENT_TTL_MS = 10 * 60 * 1000;
const NONE = { stdout: '' };
const LOCK_WAIT_MS = 100; // the hook never waits long for the store lock
const LINE_MAX = 512; // a longer first line is not the command
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const iso = (ms) => new Date(ms).toISOString();

export const CONSENT = defineKind('loopConsent', 1, {
  dir: 'local',
  file: () => 'local/loop-consent.json',
  match: /^local\/loop-consent\.json$/,
  fields: {
    at: { t: 'time' },
    expiresAt: { t: 'time' },
    repo: { t: 'str', min: 1, max: 4096 },
    session: { t: 'str', min: 1, max: 128, re: SESSION_ID },
    caps: { t: 'data', maxBytes: 512 },
    usedAt: { t: 'time', null: true },
  },
});

// The caps of the first line, {} for none, or null when the first line is not the command.
export function consentCaps(prompt, bin) {
  const nl = prompt.indexOf('\n');
  const first = (nl < 0 ? prompt : prompt.slice(0, nl)).trim();
  if (first.length > LINE_MAX) return null;
  const head = `${bin} loop start`;
  if (first === head) return {};
  if (!first.startsWith(`${head} --caps `)) return null;
  const text = first.slice(head.length + ' --caps '.length);
  if (!/^[A-Za-z]+=[^\s,]+(?:,[A-Za-z]+=[^\s,]+)*$/.test(text)) return null;
  try { return parseCaps(text); } catch { return null; }
}

// The caps in the CLI's own form (`ticks=500,usd=40`), '' for none.
const capsFlag = (caps) => Object.keys(caps).map((k) => (k === 'costMicroUsd' ? `usd=${caps[k] / 1e6}` : `${k}=${caps[k]}`)).join(',');

// Whether a stored consent allows a start asking `caps` in repository `repo` at `now`: { ok } or { ok: false, why }.
// Each cap of the new loop (the defaults with `caps` over them) must be at most the consented one (the defaults with the
// consent's caps over them): a raise needs the consented value, and a consent that tightens a cap does not allow more.
export function consentAllows(doc, { repo, caps, now }) {
  if (!doc) return { ok: false, why: 'no consent' };
  if (doc.usedAt) return { ok: false, why: 'the consent was used' };
  if (doc.repo !== repo) return { ok: false, why: 'the consent is for another repository' };
  const at = Date.parse(doc.at);
  const until = Date.parse(doc.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(until) || until - at > CONSENT_TTL_MS || at > now + 60000) return { ok: false, why: 'the consent is not valid' };
  if (now >= until) return { ok: false, why: 'the consent expired' };
  const given = doc.caps && typeof doc.caps === 'object' && !Array.isArray(doc.caps) ? doc.caps : null;
  if (!given || Object.entries(given).some(([k, v]) => !Object.hasOwn(CAP_RANGE, k) || !Number.isSafeInteger(v) || v < CAP_RANGE[k][0] || v > CAP_RANGE[k][1])) {
    return { ok: false, why: 'the consent caps are not valid' };
  }
  const allowed = { ...DEFAULT_CAPS, ...given };
  const asked = { ...DEFAULT_CAPS, ...caps };
  const over = Object.keys(DEFAULT_CAPS).filter((k) => asked[k] > allowed[k]);
  if (over.length) return { ok: false, why: `${over.join(', ')} above the consented value` };
  return { ok: true };
}

// Consumes the consent of `store` for a start (one store lock section: read, check, mark used): true when consumed.
export function consumeConsent(store, { repo, caps, now }) {
  let ok = false;
  store.update(CONSENT.name, null, (cur) => {
    if (!consentAllows(cur, { repo, caps, now }).ok) return undefined;
    ok = true;
    return { ...cur, usedAt: iso(now) };
  });
  return ok;
}

function record(input, env, deadline, now) {
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return NONE;
  const { prompt, cwd, session_id: session } = input;
  if (typeof prompt !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd) || typeof session !== 'string' || !SESSION_ID.test(session)) return NONE;
  const names = loadNames();
  const caps = consentCaps(prompt, names.bin);
  if (caps === null) return NONE;
  const s = stateOf(cwd, env, deadline);
  if (!s.where?.active) return NONE;
  const store = open(s.where.dir, { names, kinds: { ...KINDS, [CONSENT.name]: CONSENT }, lockTimeoutMs: LOCK_WAIT_MS });
  store.write(CONSENT.name, null, { at: iso(now), expiresAt: iso(now + CONSENT_TTL_MS), repo: s.where.repo, session, caps, usedAt: null });
  if (store.skipped) return NONE;
  const flag = capsFlag(caps);
  const line = `${names.bin}: the user's consent to one \`${names.bin} loop start\` in this repository was recorded (${flag ? `caps ${flag}` : 'default caps'}, valid ${CONSENT_TTL_MS / 60000} min); run \`${names.bin} loop start${flag ? ` --caps ${flag}` : ''} --yes\` to use it.`;
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: forModel(line) } })}\n` };
}

// Registry handler: (hook input object, { env, deadline, now }) → { stdout }. Any failure writes nothing more and allows.
export function promptConsent(input, { env = process.env, deadline = Infinity, now = Date.now() } = {}) {
  try {
    return record(input, env, deadline, now);
  } catch {
    return NONE;
  }
}
