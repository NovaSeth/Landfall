// `<bin> wait <run> [--timeout <s>]`, `<bin> runs [list]`, `<bin> runs show <run> [--summary]`, `<bin> runs stop <run>`
// (spec §7.12, §8.5). Reads and updates the run records written by exec. wait polls the record (every 200 ms, at most
// --timeout seconds, ≤ 590): exit 3 while the run is not terminal, exit 0 with a summary of at most 1 KB when it is.
// list shows every run (newest first, records older than 30 days marked by their age) and writes nothing; prune deletes
// finished records (and logs) older than 30 days, at most 200 a call.
// stop signals the supervisor (SIGTERM) only when the recorded identity (pid + start time + method) is the current
// one of that pid; gone or another process: the run is marked failed, nothing is signalled; unreadable: refused.
// Exit 0 · 1 unknown run · 2 bad --timeout · 3 wait: still running · 7 inactive repository, stop: identity unreadable.
import { unlinkSync } from 'node:fs';
import { RUN_ID } from '../runs/kind.mjs';
import { join } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { TERMINAL, readRunRecords, runsStore } from '../runs/index.mjs';
import { SYSTEM, identify, judge } from '../sched/index.mjs';
import { StateError, resolve } from '../state/index.mjs';

const DAY_MS = 86400e3;
const KEEP_DAYS = 30;
const PRUNE_MAX = 200;
const POLL_MS = 200;
const WAIT_MAX_S = 590;
const STOP_WAIT_MS = 3000;
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const fail = (code, message, hint) => ({ code: EXIT.FAIL, errors: [{ code, message, hint }] });

function where(io, names) {
  const w = resolve({ cwd: io.cwd, env: io.env, names });
  if (!w.active) return { refused: { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${w.repo} is not active`, hint: `'${names.bin} init' activates it` }] } };
  return { w, store: runsStore(w.dir, names) };
}

const load = (store, id, names) => {
  try { return store.read('run', id); } catch (err) {
    if (err instanceof StateError && err.code === 'invalid-key') return null;
    throw err;
  }
};
const unknown = (id, names) => fail('run-unknown', `no run ${String(id).slice(0, 80)}`, `'${names.bin} runs' lists the runs`);

const summaryOf = (r) => ({
  runId: r.runId, status: r.status, provider: r.provider, role: r.role, task: r.task, elapsedMs: r.elapsedMs,
  tokens: r.tokens, lastLine: r.lastLine, outFile: r.outFile, error: r.error, endedAt: r.endedAt ?? null,
});
const summaryText = (s) => `${s.runId}: ${s.status} (${s.provider}, ${s.role}, ${s.task}) ${Math.round(s.elapsedMs / 1000)} s${s.tokens ? `, tokens ${s.tokens.input}/${s.tokens.output}` : ''}\n${s.lastLine ? `last: ${s.lastLine}\n` : ''}${s.outFile ? `out: ${s.outFile}\n` : ''}${s.error ? `error: ${s.error}\n` : ''}`;
const clipSummary = (s) => (JSON.stringify(s).length <= 1024 ? s : { ...s, lastLine: s.lastLine ? s.lastLine.slice(0, 200) : null, error: s.error ? s.error.slice(0, 200) : null });

export async function wait({ args, flags, names, io }) {
  let timeoutS = 0;
  if (flags.timeout !== undefined) {
    if (!/^\d{1,4}$/.test(String(flags.timeout)) || Number(flags.timeout) > WAIT_MAX_S) return { code: EXIT.USAGE, errors: [{ code: 'invalid-value', message: `--timeout ${String(flags.timeout).slice(0, 20)}: expected whole seconds from 0 to ${WAIT_MAX_S}`, hint: `${names.bin} wait <run> --timeout 60` }] };
    timeoutS = Number(flags.timeout);
  }
  const r = where(io, names);
  if (r.refused) return r.refused;
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const rec = load(r.store, args.run, names);
    if (!rec) return unknown(args.run, names);
    if (TERMINAL.includes(rec.status)) {
      const s = clipSummary(summaryOf(rec));
      return { data: s, text: summaryText(s) };
    }
    if (Date.now() >= end) return { code: EXIT.WAIT, data: summaryOf(rec), text: `${rec.runId}: ${rec.status}\n` };
    await pause(Math.min(POLL_MS, Math.max(1, end - Date.now())));
  }
}

const stampOf = (x) => Date.parse(x.endedAt ?? x.startedAt ?? x.queuedAt);

export function runsList({ names, io }) {
  const r = where(io, names);
  if (r.refused) return r.refused;
  const now = Date.now();
  const runs = readRunRecords(r.store).sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1)).map((x) => {
    const s = summaryOf(x);
    const age = Math.floor((now - stampOf(x)) / DAY_MS);
    return TERMINAL.includes(x.status) && age >= KEEP_DAYS ? { ...s, ageDays: age } : s;
  });
  const line = (x) => `${x.runId}  ${x.status}  ${x.task}  ${Math.round(x.elapsedMs / 1000)} s${x.ageDays === undefined ? '' : `  (${x.ageDays} days old)`}`;
  return { data: { runs }, text: runs.length ? `${runs.map(line).join('\n')}\n` : 'no runs\n' };
}

export function runsPrune({ names, io }) {
  const r = where(io, names);
  if (r.refused) return r.refused;
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  const all = readRunRecords(r.store);
  const old = all.filter((x) => TERMINAL.includes(x.status) && stampOf(x) < cutoff);
  const removed = [];
  // The file name comes from the validated run id only (RUN_ID): a record naming another path is skipped, never deleted.
  for (const x of old.slice(0, PRUNE_MAX)) {
    if (typeof x.runId !== 'string' || !RUN_ID.test(x.runId)) continue;
    for (const ext of ['json', 'log']) { try { unlinkSync(join(r.w.dir, 'local', 'runs', `${x.runId}.${ext}`)); } catch { /* already gone */ } }
    removed.push(x.runId);
  }
  return { data: { removed, kept: all.length - removed.length }, text: `pruned ${removed.length} finished runs older than 30 days\n` };
}

export function runsShow({ args, flags, names, io }) {
  const r = where(io, names);
  if (r.refused) return r.refused;
  const rec = load(r.store, args.run, names);
  if (!rec) return unknown(args.run, names);
  if (flags.summary) return { data: summaryOf(rec), text: summaryText(summaryOf(rec)) };
  return { data: { run: rec }, text: `${JSON.stringify(rec, null, 2)}\n` };
}

export async function runsStop({ args, names, io }) {
  const r = where(io, names);
  if (r.refused) return r.refused;
  const { store } = r;
  const rec = load(store, args.run, names);
  if (!rec) return unknown(args.run, names);
  if (TERMINAL.includes(rec.status)) return { data: { runId: rec.runId, status: rec.status }, text: `${rec.runId}: already ${rec.status}\n` };
  const mark = (status, error) => store.update('run', rec.runId, (cur) => (cur && !TERMINAL.includes(cur.status) ? { ...cur, status, endedAt: new Date().toISOString(), error } : undefined));
  const end = (status, error) => { mark(status, error); return { data: { runId: rec.runId, status }, text: `${rec.runId}: ${status}\n` }; };
  if (rec.pid === null) return end('failed', 'stopped before a supervisor took it');
  const verdict = judge({ start: rec.pidStart, method: rec.pidMethod }, identify([rec.pid], SYSTEM).get(rec.pid));
  if (verdict === 'gone' || verdict === 'other') return end('failed', `the supervisor (pid ${rec.pid}) is gone`);
  if (verdict === 'unknown') return { code: EXIT.REFUSED, errors: [{ code: 'identity-unknown', message: `cannot tell whether pid ${rec.pid} is the supervisor of ${rec.runId}`, hint: 'nothing was signalled' }] };
  SYSTEM.kill(rec.pid, 'SIGTERM');
  const until = Date.now() + STOP_WAIT_MS;
  while (Date.now() < until && !TERMINAL.includes(store.read('run', rec.runId)?.status)) await pause(POLL_MS);
  return end('stopped', 'stopped by runs stop');
}
