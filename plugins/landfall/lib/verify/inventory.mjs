// Test inventory (spec §5.1 baseline tests[] {id, file, skipped}; §7.6 step 3): what every collector returns,
// { collector, tests: [{ id, file, skipped, focused? }], failing: [{ id, location, message }], failCount }.
//   id         the canonical JSON [file, title, occurrence] (occurrence: the n-th test with that file and title in the
//              collector's order), so two tests never share an ID (review r1 #9). An ID over 300 characters, or one
//              holding a character state strings refuse, is `#` + the sha256 of that JSON: a JSON array never
//              starts with `#`, so the two forms cannot meet.
//   failing    every failed result: leaves, and the suites and parent tests above them under their own IDs, so a
//              parent's own failure is never hidden by a pinned child (r1 #5); with the repository-relative location
//              and the whole message without stack frames, so different assertions differ (r1 #10).
//   failCount  the failures the reporter itself counts (null when it gives no count).
import { createHash } from 'node:crypto';
import { LIMITS } from '../state/index.mjs';
import { forTerminal } from '../text/clean.mjs';
import { TEST_ID_MAX } from './kinds.mjs';

// The characters lib/state refuses in strings (schema.mjs).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const MESSAGE_MAX = 4096;

export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const hashOf = (text, length = 64) => createHash('sha256').update(String(text)).digest('hex').slice(0, length);

export function testId(file, title, occurrence) {
  const json = JSON.stringify([String(file), String(title), occurrence]);
  return [...json].length <= TEST_ID_MAX && !UNSAFE.test(json) ? json : `#${hashOf(json)}`;
}

// A file path as state text: unchanged when it already is one, else `#` + its sha256.
const safePath = (file) => ([...file].length <= LIMITS.path && !UNSAFE.test(file) ? file : `#${hashOf(file)}`);

// The message without escapes, invisible characters, blank lines and stack frames (machine paths), each line trimmed.
export function normalizeMessage(text) {
  const lines = forTerminal(text).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !/^at\s/.test(l));
  const joined = lines.join('\n');
  return joined.length > MESSAGE_MAX ? joined.slice(0, MESSAGE_MAX) : joined;
}

// A location relative to the repository: `file://` and the repository path removed, quotes stripped.
export function normalizeLocation(location, repo) {
  let s = forTerminal(location).trim().replace(/^'(.*)'$/, '$1').replace(/^file:\/\//, '');
  if (repo && s.startsWith(`${repo}/`)) s = s.slice(repo.length + 1);
  return s;
}

// An inventory being built: add(file, title, { skipped, focused }) → ID; container(file, title) → the ID of a failed
// suite or parent test (its own occurrence count; not an inventory entry); fail(id, { location, message }); count(n).
export function builder(repo = null) {
  const tests = [];
  const failing = [];
  const leaves = new Map();
  const containers = new Map();
  let failCount = null;
  const next = (seen, file, title) => {
    const key = JSON.stringify([file, title]);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n;
  };
  return {
    add(file, title, { skipped = false, focused = false } = {}) {
      const id = testId(file, title, next(leaves, file, title));
      tests.push({ id, file: safePath(String(file)), skipped: Boolean(skipped), ...(focused ? { focused: true } : {}) });
      return id;
    },
    container(file, title) {
      return testId(file, title, next(containers, file, title));
    },
    fail(id, { location = '', message = '' } = {}) {
      failing.push({ id, location: normalizeLocation(location, repo), message: normalizeMessage(message) });
    },
    count(n) {
      failCount = n;
    },
    done(collector) {
      return { collector, tests, failing, failCount };
    },
  };
}
