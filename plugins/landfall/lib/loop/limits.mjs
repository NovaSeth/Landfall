// Usage limits of the plan (T-MG-107): on a subscription the real limits are the usage windows (session, weekly, per
// model). When one is hit, Claude Code blocks requests until the reset and an external provider prints a usage-limit
// error; the loop must wait for the reset instead of dispatching into the wall. Read-only and best effort: nothing
// here throws, an unreadable input is no limit. Transcript text is never returned, only the kind, the reset time and
// the source file or run ID (SEC-14).
//   parseReset(text, at) → ms of the next occurrence after `at` (machine local time), or null
//   usageLimit({ repo, env, names, now, since, runs }) → { kind, resetAt, source, provider? } | null
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectDirs } from '../receipts/sessions.mjs';

export const WINDOW_MS = 15 * 60e3;
export const TAIL_BYTES = 64 * 1024;
export const MAX_FILES = 50;
const SKEW_MS = 60e3;
const CLAUDE_LIMIT = /You['’]ve hit your (session|weekly|Opus|Sonnet) limit\s*[·•∙-]\s*resets ([^"\\]{1,40})/i;
const EXTERNAL_LIMIT = /usage limit|hit your .{0,20}limit/i;
const EXTERNAL_RESET = /(?:try again at|resets)\s+([^.\n"\\]{1,40})/i;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOCK = /^(?:([A-Za-z]{3})[A-Za-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\.?$/i;

// The next occurrence after `at` of a clock time in the machine's local time: `3:45pm`, `3pm`, `15:45`, and with a
// weekday `Mon 12:00am`; a trailing `(Zone/Name)` is ignored. null when it does not parse.
export function parseReset(text, at) {
  if (typeof text !== 'string' || !Number.isFinite(at)) return null;
  const m = CLOCK.exec(text.replace(/\s*\([^)]*\)\s*$/, '').trim());
  if (!m) return null;
  const mer = m[4]?.toLowerCase();
  let hour = Number(m[2]);
  const minute = m[3] === undefined ? 0 : Number(m[3]);
  if (minute > 59 || (mer ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (mer) hour = (hour % 12) + (mer === 'pm' ? 12 : 0);
  const weekday = m[1] === undefined ? -1 : DAYS.indexOf(m[1].toLowerCase());
  if (m[1] !== undefined && weekday < 0) return null;
  const base = new Date(at);
  const make = (addDays) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, minute).getTime();
  if (weekday < 0) {
    const today = make(0);
    return today > at ? today : make(1);
  }
  const ahead = (weekday - base.getDay() + 7) % 7;
  const first = make(ahead);
  return first > at ? first : make(ahead + 7);
}

// The last `bytes` of a file as text, a cut first line dropped (admission's tail rule).
function tail(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const inWindow = (at, now) => Number.isFinite(at) && now - at <= WINDOW_MS && at - now <= SKEW_MS;

// The transcripts of the repository modified at or after `since`, newest first, at most MAX_FILES.
function recentTranscripts(repo, env, since) {
  const files = [];
  for (const dir of projectDirs({ repo, env })) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile() && st.mtimeMs >= since) files.push({ path: join(dir, name), name, mtimeMs: st.mtimeMs });
      } catch { /* a file that is gone */ }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

function claudeLimit({ repo, env, now, since }) {
  let best = null;
  for (const f of recentTranscripts(repo, env, since)) {
    let text;
    try { text = tail(f.path, TAIL_BYTES); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = CLAUDE_LIMIT.exec(line);
      if (!m) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const at = Date.parse(entry?.timestamp);
      if (!inWindow(at, now) || (best && at <= best.at)) continue;
      best = { at, kind: m[1].toLowerCase(), resetAt: parseReset(m[2], at), source: f.name };
    }
  }
  return best && { kind: best.kind, resetAt: best.resetAt, source: best.source };
}

const label = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,39}$/.test(v) ? v : null);

function externalLimit({ runs, now }) {
  let best = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    const ended = Date.parse(r?.endedAt);
    if (!inWindow(ended, now) || (best && ended <= best.ended)) continue;
    const text = [r.lastLine, r.error].find((x) => typeof x === 'string' && EXTERNAL_LIMIT.test(x));
    if (text === undefined) continue;
    const reset = EXTERNAL_RESET.exec(text);
    best = { ended, kind: 'codex', resetAt: reset ? parseReset(reset[1], ended) : null, source: label(r.runId) ?? 'run', provider: label(r.provider) ?? 'codex' };
  }
  return best && { kind: best.kind, resetAt: best.resetAt, source: best.source, provider: best.provider };
}

// since: ms or an ISO time (the loop start). A Claude hit wins over an external one: it stops everything.
export function usageLimit({ repo, env, names, now, since, runs } = {}) {
  void names;
  try {
    const t = Number.isFinite(now) ? now : Date.now();
    const from = typeof since === 'number' ? since : Date.parse(since);
    return claudeLimit({ repo, env: env ?? {}, now: t, since: Number.isFinite(from) ? from : 0 }) ?? externalLimit({ runs, now: t });
  } catch {
    return null;
  }
}
