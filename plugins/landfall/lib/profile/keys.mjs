// Profile keys (spec §7.3, §7.4a, §5.1, SD-12): the one list of facts a project profile holds, each with its value
// type. A fact is {value, source, evidence, confidence, at}; `gates` and `riskPaths` are profile fields of their
// own (§5.1) and are not set as facts. The deployment fact is `deployedToUsers` (§7.4a); method pack conditions
// (method/index.json, lib/method activePacks) read these keys by exactly these names (tests/profile.test.mjs).
// Value types: text (≤ 200 characters) · enum · bool · date (YYYY-MM-DD) · list (lower-case items, joined ≤ 200)
// · token (a kebab-case name such as a CI provider, or `none`).
import { LIMITS as STATE_LIMITS } from '../state/index.mjs';

export const LIMITS = Object.freeze({
  value: 200, evidence: STATE_LIMITS.evidence, glob: STATE_LIMITS.glob, listItem: 40, listItems: 20, token: 40,
  gates: 20, gateName: 40, gateCmd: 300, timeoutS: 3600, riskPaths: 50,
});

export const SOURCES = Object.freeze(['said', 'observed', 'default']);
// The state schema has no fractional number type, so confidence is one step of this ladder (0–1).
export const CONFIDENCE = Object.freeze([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
// said: the user's words · manifest: a file whose purpose is the fact · files: a file-name heuristic.
export const CONFIDENCE_OF = Object.freeze({ said: 1, observed: 0.9, manifest: 0.9, files: 0.7, default: 0.3 });
export const GATE_KINDS = Object.freeze(['test', 'lint', 'typecheck', 'build', 'e2e', 'other']);

export const FACT_KEYS = Object.freeze({
  goal: { type: 'text', summary: 'what the project is for, in the user\'s words' },
  productKind: { type: 'enum', of: ['library', 'cli', 'web', 'mobile', 'service', 'data', 'other'], summary: 'what is built' },
  phase: { type: 'enum', of: ['idea', 'building', 'live'], summary: 'where the project is' },
  people: { type: 'enum', of: ['solo', 'small-team', 'large-team'], summary: 'who commits here' },
  ui: { type: 'bool', summary: 'the product has a user interface' },
  backend: { type: 'bool', summary: 'the product has a server side or stored data' },
  dataSensitivity: { type: 'enum', of: ['none', 'personal', 'payment', 'health'], summary: 'the most sensitive data it stores' },
  deployedToUsers: { type: 'bool', summary: 'people use it now' },
  deadline: { type: 'date', summary: 'a date the user named (captured if said, never asked)' },
  stack: { type: 'list', summary: 'languages and runtimes' },
  ci: { type: 'token', summary: 'CI provider, or none' },
  otherHarnesses: { type: 'list', summary: 'other agent harnesses configured in the repository' },
});
export const STRUCTURED_KEYS = Object.freeze(['gates', 'riskPaths']);
export const KEYS = Object.freeze([...Object.keys(FACT_KEYS), ...STRUCTURED_KEYS]);

// Typed errors (the shape lib/state errors have): a kebab-case code, the spec §8.1 exit name, message and hint.
export class ProfileError extends Error {
  constructor(code, exit, message, { hint = '' } = {}) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Control, zero-width and bidi characters (lib/state refuses them in every stored string).
const FORBIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'u');
const FORBIDDEN_ALL = new RegExp(FORBIDDEN.source, 'gu');
const length = (s) => [...s].length;

// Text from the repository (file names, manifest values) with control, zero-width and bidi characters replaced
// by '?', so a stored evidence string is always valid.
export const cleanText = (s) => String(s).replace(FORBIDDEN_ALL, '?');
export const hasForbidden = (s) => FORBIDDEN.test(s);

function realDate(s) {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const goodText = (s, max) => typeof s === 'string' && s.trim() === s && length(s) >= 1 && length(s) <= max && !FORBIDDEN.test(s);
const goodItem = (s) => goodText(s, LIMITS.listItem) && s === s.toLowerCase() && !s.includes(',');

// Whether `value` is a valid stored value of fact `key`.
export function validValue(key, value) {
  const spec = Object.hasOwn(FACT_KEYS, key) ? FACT_KEYS[key] : null;
  if (!spec) return false;
  switch (spec.type) {
    case 'text': return goodText(value, LIMITS.value);
    case 'enum': return spec.of.includes(value);
    case 'bool': return value === true || value === false;
    case 'date': return typeof value === 'string' && realDate(value);
    case 'token': return typeof value === 'string' && value.length <= LIMITS.token && TOKEN.test(value);
    case 'list': return Array.isArray(value) && value.length <= LIMITS.listItems && value.every(goodItem) && new Set(value).size === value.length && value.join(', ').length <= LIMITS.value;
    default: return false;
  }
}

function expected(key) {
  const spec = FACT_KEYS[key];
  switch (spec.type) {
    case 'text': return `text of 1–${LIMITS.value} characters`;
    case 'enum': return `one of ${spec.of.join(', ')}`;
    case 'bool': return 'true, false, yes or no';
    case 'date': return 'a date YYYY-MM-DD';
    case 'token': return 'a lower-case name such as github-actions, or none';
    case 'list': return `comma-separated items of ≤ ${LIMITS.listItem} characters, ≤ ${LIMITS.listItems} items, ≤ ${LIMITS.value} characters in all`;
    default: return '';
  }
}

export function requireFactKey(key) {
  if (STRUCTURED_KEYS.includes(key)) {
    throw new ProfileError('not-settable', 'USAGE', `${key} is not set as a fact: ${key === 'gates' ? 'gates come from the observation scan, and changing them after activation is a decision (kind gate-change)' : 'risk paths come from the observation scan'}`, { hint: 'run profile observe to refresh it' });
  }
  if (!Object.hasOwn(FACT_KEYS, key)) {
    throw new ProfileError('unknown-key', 'USAGE', `unknown profile key: ${key}`, { hint: `keys: ${Object.keys(FACT_KEYS).join(', ')}` });
  }
}

// The typed value of fact `key` from command-line text; throws ProfileError (USAGE) when it is not valid.
export function parseValue(key, raw) {
  requireFactKey(key);
  const text = String(raw ?? '').trim();
  const { type } = FACT_KEYS[key];
  let value = text;
  if (type === 'bool') value = { true: true, yes: true, false: false, no: false }[text.toLowerCase()];
  else if (type === 'enum' || type === 'token') value = text.toLowerCase();
  else if (type === 'list') value = text === '' ? [] : text.split(',').map((s) => s.trim().toLowerCase());
  if (!validValue(key, value)) throw new ProfileError('invalid-value', 'USAGE', `invalid value for ${key}: ${JSON.stringify(String(raw ?? '')).slice(0, 80)}`, { hint: `${key} takes ${expected(key)}` });
  return value;
}
