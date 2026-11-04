import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Run in the main checkout, the task's code is in the worktree `task start` recorded, not at the checkout's HEAD.
export function taskWhere(where, store, id) {
  if (where.worktree !== where.repo) return where;
  const recorded = [...(store.read('task', id)?.events ?? [])].reverse().find((e) => e.event === 'started')?.data?.worktree;
  if (typeof recorded !== 'string' || !existsSync(join(recorded, '.git'))) return where;
  return { ...where, worktree: recorded };
}
