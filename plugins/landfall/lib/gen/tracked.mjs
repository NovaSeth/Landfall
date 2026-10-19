// Tracked side files (spec §7.14a): a generated side file is a proposal waiting for the user; committing one is a
// mistake that `doctor`, the generated CI workflow and the pre-push hook report. Read-only (git ls-files).
import { git } from '../git/index.mjs';
import { sideSuffix } from './targets.mjs';

// Paths (relative to the repository root) of tracked side files; null outside a git repository or without git.
export function trackedSideFiles({ cwd, env, names }) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd, env });
  if (top.error || top.status !== 0) return null;
  const r = git(['ls-files', '-z', '--cached', '--', `*${sideSuffix(names)}`], { cwd: top.stdout.trim(), env });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}
