// The inventory measured at a commit (T-MG-37): the reference when no stored baseline describes the task base. The
// profile's test gates run in a temporary detached worktree at the commit under <stateDir>/local/, their reports go
// through the same collectors as the run itself, and the worktree is removed also when a gate or git fails.
// Result: { doc: { collector, tests, failing } | null, error: null | message }. A gate that cannot run there (error or
// timeout) or a worktree git cannot create is an error: the reference is unknown, so verify never passes on it.
import { relative, sep } from 'node:path';
import { localTempDir, removeLocalFile } from '../state/index.mjs';
import { fingerprint } from './baseline.mjs';
import { runHeavy } from './heavy.mjs';
import { projectRedactions, runRedacted } from './redact.mjs';

// `inventory(runs, worktree)`: the run's own collector over the gates' outputs in `worktree`.
// `names`, `task`: the heavy lease's owner (T-MG-80: a long base gate is a full suite, so it queues like every other).
// `meter`: passed to runHeavy (heavy.mjs), so the base gates and their lease wait count in the verify's (T-MG-121).
export function measureAt({ where, env, names, task = null, commit, gates, gitIn, inventory, meter = null }) {
  let dir;
  try { dir = localTempDir(where.dir, names, 'base-'); } catch (err) { return { doc: null, error: `no temporary directory for the base ${commit.slice(0, 12)} (${String(err.message).slice(0, 200)})` }; }
  try {
    const add = gitIn(where, env, ['worktree', 'add', '--detach', '-q', dir, commit]);
    if (add.status !== 0) return { doc: null, error: `git cannot check out the base ${commit.slice(0, 12)} (${String(add.stderr).trim().slice(0, 200)})` };
    const extra = projectRedactions(where);
    const runs = runHeavy(gates.filter((g) => g.kind === 'test'), { names, env, cwd: dir, task }, (g) => runRedacted(g, { cwd: dir, env, extra }), meter);
    const broken = runs.find((r) => r.gate.result === 'error' || r.gate.result === 'timeout');
    if (broken) return { doc: null, error: `gate ${broken.gate.name} could not run at the base ${commit.slice(0, 12)} (${broken.gate.result}, exit ${broken.gate.exit ?? '-'})` };
    const inv = inventory(runs, dir);
    return { doc: { collector: inv.collector, tests: inv.tests.map(({ id, file, skipped }) => ({ id, file, skipped })), failing: inv.parts.flatMap((p) => p.failing.map(fingerprint)) }, error: null };
  } finally {
    gitIn(where, env, ['worktree', 'remove', '--force', dir]);
    try { removeLocalFile(where.dir, names, relative(where.dir, dir).split(sep).join('/'), { tree: true }); } catch { /* a leftover temporary directory never masks the result */ }
    gitIn(where, env, ['worktree', 'prune']);
  }
}
