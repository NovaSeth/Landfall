// Wait intervals (plan M1.7, P6, D-MG-38): the typed waits that lead time is attributed to (K3), one JSON line each in
// local/waits.jsonl (LOGS.waits), always through store.append, so the read, the decision and the write share one lock
// section. An entry is { at, until, kind, task, source } with until ≥ at; a load wait adds the key of the session
// that waits (D1). A load wait opens with a marker (until null) at a session's first deny and closes with a second,
// closed entry at that session's next admit; collect counts closed entries only (D2). The loop records a usage-limit
// wait [now, resetAt] and any other WAIT as a tick wait [now, now + nextTickS]; an exit records nothing (GC4).
// This module imports only lib/state, so a hook may import it (D4).
//   WAIT_KINDS · recordWait(store, wait) → entry · openLoadWait / closeLoadWait(store, { key, at }) → entry | null ·
//   loopWait({ result, nextTickS, limit, now }) → wait | null · recordLoopWait(store, tick) → entry | null
import { PATTERNS } from '../state/index.mjs';
import { DEFAULTS } from '../sched/kinds.mjs';

export const WAIT_KINDS = Object.freeze(['usage-limit', 'load', 'tick', 'heavy-queue']);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; // the admit hook's ID pattern (lib/hooks/admit.mjs)
const SOURCE_MAX = 40;
const STALE_MS = DEFAULTS.ttlS.heavy * 1000; // an open marker older than this belongs to a dead session: ignored

const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const iso = (ms) => new Date(ms).toISOString();
const bad = (what) => new TypeError(`waits: ${what}`);

// The entry of a wait, its fields checked (bad input from code is a TypeError); until null only for a load marker.
function entryOf({ kind, at, until, task, source, key }) {
  if (!WAIT_KINDS.includes(kind)) throw bad(`kind must be one of ${WAIT_KINDS.join(', ')}, got ${String(kind).slice(0, 40)}`);
  if (!isIso(at)) throw bad(`at must be an ISO time, got ${String(at).slice(0, 40)}`);
  if (until === null) {
    if (kind !== 'load') throw bad('until may be null only for a load wait (its open marker)');
  } else if (!isIso(until) || Date.parse(until) < Date.parse(at)) throw bad(`until must be an ISO time not before at, got ${String(until).slice(0, 40)}`);
  if (task !== null && !(typeof task === 'string' && PATTERNS.taskId.test(task))) throw bad(`task must be a task ID or null, got ${String(task).slice(0, 40)}`);
  if (typeof source !== 'string' || source.length === 0 || source.length > SOURCE_MAX) throw bad(`source must be 1 to ${SOURCE_MAX} characters`);
  if (key !== undefined && !(typeof key === 'string' && KEY.test(key))) throw bad('key must match the hook ID pattern');
  if (kind === 'load' && key === undefined) throw bad('a load wait names its key');
  return key === undefined ? { at, until, kind, task, source } : { at, until, kind, task, source, key };
}

// The newest entry of the log text whose line holds `hint` (a plain substring, no regular expression: COD-25) and that
// `match` accepts, or null. Lines are read from the end; a torn or foreign line is no entry.
function newest(text, hint, match) {
  if (!text.includes(hint)) return null;
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    end = start - 1;
    if (!line.includes(hint)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; } // a torn or hand-edited line: not an entry
    if (row !== null && typeof row === 'object' && match(row)) return row;
  }
  return null;
}

const hintOf = (field, value) => `"${field}":${JSON.stringify(value)}`;
// The open marker of `key` when it is that key's newest load entry and not older than STALE_MS at `now`, else null.
const openMarker = (text, key, now) => {
  const last = newest(text, hintOf('key', key), (r) => r.kind === 'load' && r.key === key);
  return last && last.until === null && isIso(last.at) && Date.parse(now) - Date.parse(last.at) <= STALE_MS ? last : null;
};

export function recordWait(store, wait) {
  const entry = entryOf(wait ?? {});
  return store.append('waits', entry);
}

// A session's load wait opens at its first deny: a marker, unless its newest load entry is already one.
export function openLoadWait(store, { key, at }) {
  const marker = entryOf({ kind: 'load', at, until: null, task: null, source: 'admit', key });
  return store.append('waits', (text) => (openMarker(text, key, at) ? undefined : marker));
}

// A session's admit closes its open load wait: the closed entry from the marker's at to `at` (never before it).
export function closeLoadWait(store, { key, at }) {
  entryOf({ kind: 'load', at, until: null, task: null, source: 'admit', key });
  return store.append('waits', (text) => {
    const open = openMarker(text, key, at);
    if (!open) return undefined;
    return entryOf({ kind: 'load', at: open.at, until: Date.parse(at) < Date.parse(open.at) ? open.at : at, task: null, source: 'admit', key });
  });
}

// The wait a tick result records (D3), or null: ACTION and the exits record nothing, nor does a codex limit (the
// loop goes on without it). A usage limit waits until its reset; one unknown or already past waits nextTickS.
export function loopWait({ result, nextTickS, limit = null, now }) {
  if (result !== 'WAIT' || !Number.isFinite(now)) return null;
  const next = Number.isFinite(nextTickS) && nextTickS > 0 ? now + nextTickS * 1000 : null;
  if (limit && typeof limit === 'object' && limit.kind !== 'codex') {
    const until = Number.isFinite(limit.resetAt) && limit.resetAt >= now ? limit.resetAt : next;
    return until === null ? null : { kind: 'usage-limit', at: iso(now), until: iso(until), task: null, source: 'loop' };
  }
  return next === null ? null : { kind: 'tick', at: iso(now), until: iso(next), task: null, source: 'loop' };
}

// Appends the wait of a tick result; a usage-limit wait whose newest usage-limit entry has the same until is already
// recorded (the next ticks of one limit add nothing).
export function recordLoopWait(store, tick) {
  const wait = loopWait(tick);
  if (!wait) return null;
  const entry = entryOf(wait);
  if (entry.kind !== 'usage-limit') return store.append('waits', entry);
  return store.append('waits', (text) => (newest(text, hintOf('kind', 'usage-limit'), (r) => r.kind === 'usage-limit')?.until === entry.until ? undefined : entry));
}
