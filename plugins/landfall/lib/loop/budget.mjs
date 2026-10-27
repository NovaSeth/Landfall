// The budget of a dispatched task (ORC-9, ORC-11): the number in its brief's line `Budget: <n> minutes`
// (tasks/<id>/brief.md in the state directory); absent, unreadable or not a positive number → the default.
// A plain read of at most 64 KiB per brief; the table gets the numbers as data, so it stays a pure function.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BUDGET_MIN = 15;
const OPEN = new Set(['dispatched', 'in-review', 'fix-round']);

export function budgetOf(text) {
  const m = /^Budget:\s*(\d{1,4})\s+minutes?\b/m.exec(typeof text === 'string' ? text : '');
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : DEFAULT_BUDGET_MIN;
}

// { taskId: minutes } for the tasks that wait for an executor.
export function readBudgets(dir, tasks) {
  const out = {};
  for (const t of tasks) {
    if (!OPEN.has(t.status)) continue;
    let text = null;
    try { text = readFileSync(join(dir, 'tasks', t.id, 'brief.md'), 'utf8').slice(0, 65536); } catch { /* absent or unreadable: default */ }
    out[t.id] = budgetOf(text);
  }
  return out;
}
