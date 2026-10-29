// Persistent review findings. Source reviews are repository data (SEC-14), never instructions.
import { KINDS, StateError, allocateId, open } from '../state/index.mjs';
import { forModel } from '../text/clean.mjs';
import { VERIFY_KINDS, reviewKey } from '../verify/kinds.mjs';

const usage = (message) => new StateError('invalid-finding', 'USAGE', message);
export const readFindings = (store) => store.list('finding').map((id) => store.read('finding', id));
export const findingsForTask = (store, task) => readFindings(store).filter((f) => f.takenBy === task);
export const findingCounts = (store) => readFindings(store).reduce((n, f) => {
  if (f.status === 'open' || f.status === 'taken') n[f.status]++;
  return n;
}, { open: 0, taken: 0 });

export function selectedFindings(store, ids) {
  if (!ids.length) throw usage('name at least one finding ID');
  const all = new Map(readFindings(store).map((f) => [f.id, f]));
  return [...new Set(ids)].map((id) => {
    KINDS.finding.path(id);
    if (!all.has(id)) throw usage(`no finding ${id}`);
    return all.get(id);
  });
}

// Read and validate the entire selection before any write. Without a round, use the latest
// recorded review (not task.round, which tracks fix rounds independently).
export function reviewSelection(store, { task, round, ids, blocking = false }) {
  KINDS.task.path(task);
  if (!store.read('task', task)) throw usage(`no task ${task}`);
  const reviews = open(store.dir, { names: store.names, kinds: { ...store.kinds, ...VERIFY_KINDS } });
  if (round === undefined) {
    round = Math.max(0, ...reviews.list('review').filter((k) => k.startsWith(`${task}/`)).map((k) => Number(k.split('-r').at(-1))));
  }
  if (!Number.isInteger(round) || round < 1 || round > 999) throw usage('a recorded review round from 1 to 999 is required');
  const review = reviews.read('review', reviewKey(task, round));
  if (!review) throw usage(`${task} has no recorded review round ${round}`);
  const picked = [...new Set(ids)];
  const findings = picked.map((id) => {
    const matches = review.findings.filter((f) => f.id === id);
    if (matches.length !== 1) throw usage(`${id} is ${matches.length ? 'ambiguous' : 'not found'} in ${task} review round ${round}`);
    return matches[0];
  });
  if (blocking) {
    const missing = review.findings.filter((f) => f.severity === 'blocking' && !picked.includes(f.id));
    if (missing.length) throw usage(`--remaining must list every open blocking finding: ${missing.map((f) => f.id).join(', ')}`);
  }
  // Also refuse a newer backlog before a decision or task can be written.
  readFindings(store);
  return { task, round, reviewer: review.reviewer, findings };
}

// Caller holds the batch lock; the tuple task/round/finding is the durable deduplication key,
// including records already taken or closed. Repeating a command never reopens a finding.
export function fileSelection(store, selection, handle, at = new Date().toISOString()) {
  const existing = readFindings(store);
  const filed = [];
  for (const f of selection.findings) {
    if (existing.some((old) => old.task === selection.task && old.round === selection.round && old.finding === f.id)) continue;
    const { id: finding, ...detail } = f;
    const id = allocateId(store, { prefix: 'B', handle, build: (id) => ({
      id, status: 'open', task: selection.task, round: selection.round, reviewer: selection.reviewer,
      finding, ...detail, filedAt: at, filedBy: handle, takenBy: null, closedAt: null, closedBy: null, reason: null,
    }) });
    filed.push(id);
  }
  return filed;
}

export function closeFindings(store, findings, { status = 'fixed', by, reason, at = new Date().toISOString() }) {
  for (const f of findings) store.write('finding', f.id, { ...f, status, closedAt: at, closedBy: by, reason });
  return findings.map((f) => f.id);
}

// Remove terminal/format controls and flatten all whitespace, so even fence-like review text
// cannot start a new Markdown line. The line always starts with the validated backlog ID.
export const oneLine = (s) => forModel(s).replace(/\s+/gu, ' ').trim();
export const sourceLine = (f) => oneLine(`${f.id}  ${f.task} r${f.round} ${f.finding}  ${f.path ?? '-'}:${f.line ?? '-'}  ${f.severity}  ${f.rule ?? '-'}  ${f.text}`);
export const listLine = (f) => `${f.id}  ${f.status}` + `  ${oneLine(`${f.task} r${f.round} ${f.finding}`)}  ${f.severity}  ${oneLine(f.path ?? '-')}:${f.line ?? '-'}  ${[...oneLine(f.text)].slice(0, 100).join('')}`;
