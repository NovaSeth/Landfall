import { existsSync, lstatSync, readFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

export function dependencyLinks(where, wt, SequentialFallback) {
  const modules = join(wt, 'node_modules');
  let linked = false;
  const unlinkDependencies = () => {
    // Unlink only the link we created; never recursively remove or follow its target.
    if (linked && lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(modules);
    linked = false;
  };
  const linkDependencies = () => {
    const source = join(where.worktree, 'node_modules');
    if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) return;
    const lock = LOCKFILES.find((file) => existsSync(join(where.worktree, file)));
    if (!lock) throw new SequentialFallback('the main checkout has node_modules but no lockfile');
    try {
      if (!existsSync(join(wt, lock)) || !readFileSync(join(where.worktree, lock)).equals(readFileSync(join(wt, lock)))) {
        throw new SequentialFallback(`${lock} differs between the main checkout and the integration worktree`);
      }
      symlinkSync(source, modules, 'dir');
      linked = true;
    } catch (err) {
      if (err instanceof SequentialFallback) throw err;
      throw new SequentialFallback(`cannot link the main checkout's node_modules (${err.code ?? 'filesystem error'})`, { cause: err });
    }
  };
  return { link: linkDependencies, unlink: unlinkDependencies, get linked() { return linked; } };
}
