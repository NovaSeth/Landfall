// The inventory measured at a commit (T-MG-37): the reference when no stored baseline describes the task base. The
// profile's test gates run in a temporary detached worktree at the commit under <stateDir>/local/, their reports go
// through the same collectors as the run itself, and the worktree is removed also when a gate or git fails.
// Result: { doc: { collector, tests, failing } | null, error: null | message }. A gate that cannot run there (error or
// timeout) or a worktree git cannot create is an error: the reference is unknown, so verify never passes on it.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from './baseline.mjs';
import { runGate } from './gates.mjs';
import { runHeavy } from './heavy.mjs';

// `inventory(runs, worktree)`: the run's own collector over the gates' outputs in `worktree`.
// `names`, `task`: the heavy lease's owner (T-MG-80: a long base gate is a full suite, so it queues like every other).
export function measureAt({ where, env, names, task = null, commit, gates, gitIn, inventory }) {
  const local = join(where.dir, 'local');
  mkdirSync(local, { recursive: true });
  const dir = mkdtempSync(join(local, 'base-'));
  try {
    const add = gitIn(where, env, ['worktree', 'add', '--detach', '-q', dir, commit]);
    if (add.status !== 0) return { doc: null, error: `git cannot check out the base ${commit.slice(0, 12)} (${String(add.stderr).trim().slice(0, 200)})` };
    const runs = runHeavy(gates.filter((g) => g.kind === 'test'), { names, env, cwd: dir, task }, (g) => runGate(g, { cwd: dir, env }));
    const broken = runs.find((r) => r.gate.result === 'error' || r.gate.result === 'timeout');
    if (broken) return { doc: null, error: `gate ${broken.gate.name} could not run at the base ${commit.slice(0, 12)} (${broken.gate.result}, exit ${broken.gate.exit ?? '-'})` };
    const inv = inventory(runs, dir);
    return { doc: { collector: inv.collector, tests: inv.tests.map(({ id, file, skipped }) => ({ id, file, skipped })), failing: inv.parts.flatMap((p) => p.failing.map(fingerprint)) }, error: null };
  } finally {
    gitIn(where, env, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    gitIn(where, env, ['worktree', 'prune']);
  }
}
