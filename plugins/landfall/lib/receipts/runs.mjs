// External run records (spec §8.5, §7.12 Accounting, SC16): `<state>/local/runs/<runId>.json`, written by the
// providers unit. Read here straight from the files (only writes are reserved to lib/state), never through a link.
// Fields read: runId (= the file name), task, provider, model, status, tokens {input, output, cached} | null
// (`input` without the cached part; `cached` becomes cacheRead), tokensReason, costMicroUsd | null and elapsedMs
// (whole micro-dollars and milliseconds, ruling R70; elapsedMs absent: endedAt - startedAt), startedAt, endedAt, exit. A run without tokens keeps `tokens: null` and a reason ("not
// reported" when its record gives none), so every run of a task appears in the task's receipt. A record that does
// not fit is a problem (the totals are then a lower bound). Text fields (lastLine, error) are never read.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { label } from './sessions.mjs';

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const NOT_REPORTED = 'not reported';
const TASK = /^T-[A-Z]{2,4}-[1-9]\d{0,5}$/;

const count = (v) => Number.isSafeInteger(v) && v >= 0;
const time = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const reasonOf = (v) => (typeof v === 'string' && /^[\x20-\x7e]{1,200}$/.test(v) ? v : null);

// The run in the shape receipts use, or a string naming what does not fit.
function entry(doc, runId) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object';
  if (doc.runId !== runId) return 'runId does not match the file name';
  if (typeof doc.task !== 'string' || !TASK.test(doc.task)) return 'task is not a task ID';
  const t = doc.tokens;
  if (t !== null && (typeof t !== 'object' || !count(t.input) || !count(t.output) || !(t.cached === undefined || count(t.cached)))) return 'tokens is neither null nor {input, output, cached} counts';
  const cost = doc.costMicroUsd;
  if (!(cost === null || cost === undefined || count(cost))) return 'costMicroUsd is not a whole number of micro-dollars';
  const elapsed = doc.elapsedMs;
  if (!(elapsed === null || elapsed === undefined || count(elapsed))) return 'elapsedMs is not a whole number of milliseconds';
  const startedAt = time(doc.startedAt);
  const endedAt = time(doc.endedAt);
  const span = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;
  const tokens = t === null ? null : { input: t.input, output: t.output, cacheRead: t.cached ?? 0, cacheWrite: 0 };
  return {
    runId, task: doc.task, provider: label(doc.provider), model: doc.model == null ? null : label(doc.model), status: label(doc.status),
    tokens, tokensReason: tokens === null ? reasonOf(doc.tokensReason) ?? NOT_REPORTED : null,
    costMicroUsd: cost ?? null, wallMs: elapsed ?? span,
    exit: Number.isSafeInteger(doc.exit) ? doc.exit : null, startedAt, endedAt,
  };
}

// { runs: [entry] sorted by runId, problems: [{ code, message, hint }] } of the run directory `dir`.
export function readRuns(dir) {
  const runs = [];
  const problems = [];
  let names;
  try {
    if (lstatSync(dir).isSymbolicLink()) return { runs, problems: [{ code: 'run-invalid', message: `${dir} is a symbolic link; run records are never read through links`, hint: 'replace it with a plain directory' }] };
    names = readdirSync(dir).sort();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { runs, problems };
    throw err;
  }
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue; // temporary files of writers, logs
    const runId = name.slice(0, -'.json'.length);
    const file = join(dir, name);
    const bad = (why) => problems.push({ code: 'run-invalid', message: `${file}: ${why}`, hint: 'the totals leave this run out' });
    if (!RUN_ID.test(runId)) { bad('not a run file name'); continue; }
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isFile()) { bad('not a regular file (links are never followed)'); continue; }
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { bad(err.code ?? 'not JSON'); continue; }
    const e = entry(doc, runId);
    if (typeof e === 'string') bad(e);
    else runs.push(e);
  }
  return { runs, problems };
}
