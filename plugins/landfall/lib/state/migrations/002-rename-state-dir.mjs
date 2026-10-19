// Layout step (D-MG-1, GC9): the rename of the plugin moved the project state directory `.caw/` to name.json
// "stateDir" and the machine data directory `caw-caw-plugins` to the current one (lib/state/resolve.mjs
// machineDataDir). Unlike the document steps (NNN-<kind>-<name>, pure `up`), this step moves directories, so it is
// listed under LAYOUTS in index.mjs and `<bin> migrate` runs it before the document chain.
// plan() names the moves without touching anything; run() applies them: the project directory with `git mv` when
// tracked (history kept), otherwise a rename, then every `.gitignore` line naming the old directory is rewritten.
// Both directories present is a conflict: a typed error, nothing moved. Machine data moves once, only while the current
// directory does not exist (projects.json keys are repository paths and stay as they are).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { moveTree, writeAtomic } from '../../fsx/index.mjs';
import { git } from '../../git/index.mjs';
import { StateError } from '../errors.mjs';
import { machineDataDir } from '../resolve.mjs';

const PREVIOUS = Object.freeze({ stateDir: '.caw', dataDir: 'caw-caw-plugins' });

function tracked(repo, rel, env) {
  const r = git(['ls-files', '--', rel], { cwd: repo, env });
  return r.status === 0 && r.stdout.trim() !== '';
}

function moveProjectDir(repo, from, to, env) {
  if (tracked(repo, from, env)) {
    const r = git(['mv', from, to], { cwd: repo, env });
    if (r.status !== 0) throw new StateError('state-dir-move-failed', 'ENV', `git mv ${from} ${to}: ${r.stderr.trim()}`, { hint: 'resolve the git error, then rerun migrate' });
    return 'git mv';
  }
  moveTree(join(repo, from), join(repo, to));
  return 'rename';
}

// `.gitignore` lines that name the old directory (`.caw/`, `.caw/local/`) now name the new one.
function rewriteGitignore(repo, from, to) {
  const file = join(repo, '.gitignore');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const next = text.split('\n').map((line) => (line === from || line.startsWith(`${from}/`) ? `${to}${line.slice(from.length)}` : line)).join('\n');
  if (next === text) return false;
  writeAtomic(file, next);
  return true;
}

export default Object.freeze({
  id: '002-rename-state-dir',
  previous: PREVIOUS,
  // { moves: [{ what: 'state' | 'data', from, to }], conflict: string | null } — nothing is touched.
  plan({ repo, env, names }) {
    const moves = [];
    let conflict = null;
    if (repo) {
      const oldDir = join(repo, PREVIOUS.stateDir);
      const newDir = join(repo, names.stateDir);
      if (existsSync(oldDir) && existsSync(newDir)) conflict = `${repo} has both ${PREVIOUS.stateDir}/ and ${names.stateDir}/`;
      else if (existsSync(oldDir)) moves.push({ what: 'state', from: oldDir, to: newDir });
    }
    const data = machineDataDir(names, env);
    if (data) {
      const oldData = join(dirname(data), PREVIOUS.dataDir);
      if (existsSync(oldData) && !existsSync(data)) moves.push({ what: 'data', from: oldData, to: data });
    }
    return { moves, conflict };
  },
  // Applies the plan; returns { moves, gitignore }. A conflict refuses before any move.
  run({ repo, env, names }) {
    const { moves, conflict } = this.plan({ repo, env, names });
    if (conflict) {
      throw new StateError('state-dir-conflict', 'REFUSED', `${conflict}: nothing moved`, {
        hint: `keep one of them (merge or remove the other by hand), then rerun '${names.bin} migrate'`,
      });
    }
    let gitignore = false;
    for (const m of moves) {
      if (m.what === 'state') {
        m.how = moveProjectDir(repo, PREVIOUS.stateDir, names.stateDir, env);
        gitignore = rewriteGitignore(repo, PREVIOUS.stateDir, names.stateDir);
      } else {
        moveTree(m.from, m.to);
        m.how = 'rename';
      }
    }
    return { moves, gitignore };
  },
});
