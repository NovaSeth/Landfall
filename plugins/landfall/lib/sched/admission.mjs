// Admission reasons (spec §7.8, U13): load at or above LOAD_MAX, free memory below FREE_MIN, an unmeasured load
// while the load check is on (fail closed), and rate limits: 2 rate-limit errors within 10 minutes [2/10] in the
// tail of the session transcript. In shadow mode (spec §14) these are reported, not enforced; capacity (per-kind
// max and the FIFO queue) is always enforced.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { freePct } from './machine.mjs';

export const RATE_LIMIT = Object.freeze({ count: 2, windowMs: 10 * 60e3, tailBytes: 64 * 1024 });

export function admissionReasons(r, cal) {
  const reasons = [];
  if (cal.loadMax !== 'off') {
    if (!r.loadMeasurable || r.load1 === null) reasons.push({ code: 'load-unmeasured', message: 'the load cannot be measured here and the load check is on' });
    else if (r.load1 >= Number(cal.loadMax)) reasons.push({ code: 'load', message: `load ${r.load1.toFixed(1)} ≥ ${cal.loadMax}` });
  }
  const pct = freePct(r);
  if (pct < cal.freeMinPct) reasons.push({ code: 'memory', message: `free memory ${pct}% < ${cal.freeMinPct}%` });
  return reasons;
}

function tail(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text; // drop a cut first line
  } finally {
    closeSync(fd);
  }
}

// U13: [{ code: 'rate-limit', message }] when the transcript tail holds 2 API rate-limit errors (HTTP 429 or
// rate_limit_error) dated within the last 10 minutes; [] otherwise, also when it cannot be read.
export function rateLimitReasons(path, now = Date.now()) {
  let text;
  try {
    text = tail(path, RATE_LIMIT.tailBytes);
  } catch {
    return [];
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('rate_limit') && !/\b429\b/.test(line)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || !(entry.isApiErrorMessage === true || entry.type === 'error' || entry.error)) continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at) && now - at <= RATE_LIMIT.windowMs && at - now <= 60e3) count++;
  }
  return count >= RATE_LIMIT.count ? [{ code: 'rate-limit', message: `${count} rate-limit errors in the last 10 min` }] : [];
}
