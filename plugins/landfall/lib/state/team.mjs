// Handle registry (spec §5.1, §7.2, §10, SD-9): team/<H>.json holds a developer's handle (2-4 letters A-Z), the
// SHA-256 of the lowercased git email (never the email) and the registration time.
// Derivation from git user.name: initials (more than four words: three initials and the last), one word: its
// first two letters; then the next letters of the last word (MG → MGO → MGOL); then the last letter varied
// A-Z (MGA…, MGOA…, MA…). Letters are folded to ASCII; no letters in the name → the email's local part.
// Registration (under the store lock) returns the handle already held by this email hash, or creates the first
// free candidate, so concurrent and repeated registrations of one email give one handle.
// gitIdentity reads user.name and user.email from the target repository (REV-58).
import { createHash } from 'node:crypto';
import { git } from '../git/index.mjs';
import { join } from 'node:path';
import { checkWrite, requireArg } from './document.mjs';
import { StateError } from './errors.mjs';
import { LIMITS } from './kinds.mjs';

const FOLD = {
  '\u0141': 'L', '\u0142': 'l', '\u00d8': 'O', '\u00f8': 'o', '\u0110': 'D', '\u0111': 'd', '\u00d0': 'D', '\u00f0': 'd',
  '\u00df': 'ss', '\u00c6': 'AE', '\u00e6': 'ae', '\u0152': 'OE', '\u0153': 'oe', '\u00de': 'TH', '\u00fe': 'th', '\u0131': 'i',
};
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HANDLE = /^[A-Z]{2,4}$/;

export const emailHash = (email) => createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

function words(text) {
  const ascii = String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x00-\x7f]/g, (c) => FOLD[c] ?? ' ');
  return ascii.split(/[^A-Za-z]+/).filter(Boolean).map((w) => w.toUpperCase());
}

export function handleCandidates(name, email) {
  let ws = words(name);
  if (ws.length === 0) ws = words(String(email ?? '').split('@')[0]);
  if (ws.length === 0) return [];
  const last = ws[ws.length - 1];
  const base = ws.length === 1 ? last.slice(0, 2) : (ws.length > 4 ? [...ws.slice(0, 3), last] : ws).map((w) => w[0]).join('');
  const chain = [base];
  for (const c of ws.length === 1 ? last.slice(2) : last.slice(1)) {
    if (chain[chain.length - 1].length >= 4) break;
    chain.push(chain[chain.length - 1] + c);
  }
  const out = [];
  const add = (h) => { if (HANDLE.test(h) && !out.includes(h)) out.push(h); };
  chain.forEach(add);
  for (const len of [3, 4, 2]) {
    const prefix = chain.find((h) => h.length === len - 1) ?? (base.length >= len - 1 ? base.slice(0, len - 1) : null);
    if (prefix) for (const c of AZ) add(prefix + c);
  }
  return out;
}

// { handle, created }. `handle` (optional) is an explicit choice; otherwise one is derived from `name`.
// Registration holds the store lock: the check for an existing handle of this email and the creation of a new
// one cannot interleave with another registration.
export function registerHandle(store, { name, email, handle, at = new Date().toISOString() }) {
  const kind = store.kind('team');
  if (typeof email !== 'string' || email.trim() === '' || email.length > LIMITS.email) throw new StateError('email-required', 'USAGE', 'a git user.email is needed to register a handle', { hint: 'set it with: git config user.email <address>' });
  if (handle !== undefined) kind.path(handle);
  const hash = emailHash(email);
  const candidates = handle !== undefined ? [handle] : handleCandidates(name, email);
  return store.locked(() => {
    store.abs(kind.dir);
    store.assertWritable();
    store.refuseNewerKind(kind);
    const mine = store.list('team').map((h) => store.read('team', h)).find((doc) => doc.emailSha256 === hash);
    if (mine) {
      if (handle !== undefined && handle !== mine.handle) throw new StateError('handle-mismatch', 'USAGE', `this email is registered as ${mine.handle}`, { hint: `use ${mine.handle}` });
      return { handle: mine.handle, created: false };
    }
    if (candidates.length === 0) throw new StateError('handle-required', 'USAGE', 'no handle can be derived from the git user.name or email', { hint: 'choose a handle of 2-4 letters A-Z' });
    for (const h of candidates) {
      const doc = store.stamp(kind, { handle: h, emailSha256: hash, addedAt: at });
      checkWrite(kind, doc, { where: join(store.dir, kind.path(h)), key: h });
      if (store.insert(kind, kind.path(h), doc)) return { handle: h, created: true };
      if (handle !== undefined) throw new StateError('handle-taken', 'USAGE', `handle ${h} belongs to another developer`, { hint: 'choose another handle' });
    }
    throw new StateError('handle-exhausted', 'USAGE', 'every handle derived from the name is taken', { hint: 'choose a handle of 2-4 letters A-Z' });
  });
}

export function gitIdentity(repo, { env } = {}) {
  requireArg(env, 'env', 'gitIdentity');
  const get = (key) => {
    const r = git(['config', '--get', key], { cwd: repo, env });
    return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  };
  return { name: get('user.name'), email: get('user.email') };
}
