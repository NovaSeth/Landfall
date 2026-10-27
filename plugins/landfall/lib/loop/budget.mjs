// The budget of a dispatched task (ORC-9, ORC-11): the number in its brief's line `Budget: <n> minutes`
// (tasks/<id>/brief.md in the state directory); absent, unreadable or not a positive number → the default.
// Only a regular file, opened without following a link and without blocking on a FIFO, and only its first 64 KiB:
// status and tick must not hang or balloon on a planted brief. The table gets the numbers as data, so it stays pure.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BUDGET_MIN = 15;
const MAX_BRIEF_BYTES = 65536;
const OPEN = new Set(['dispatched', 'in-review', 'fix-round']);

export function budgetOf(text) {
  const m = /^Budget:\s*(\d{1,4})\s+minutes?\b/m.exec(typeof text === 'string' ? text : '');
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : DEFAULT_BUDGET_MIN;
}

function readHead(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAX_BRIEF_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

// { taskId: minutes } for the tasks that wait for an executor.
export function readBudgets(dir, tasks) {
  const out = {};
  for (const t of tasks) {
    if (!OPEN.has(t.status)) continue;
    let text = null;
    try { text = readHead(join(dir, 'tasks', t.id, 'brief.md')); } catch { /* absent, a link or unreadable: default */ }
    out[t.id] = budgetOf(text);
  }
  return out;
}
