// `<bin> task start <id> [--slug <s>] [--from <ref>] [--path <dir>]`: creates the task's worktree and branch with
// `git worktree add` (nothing is written by hand) and records both on the task as the state `started`; the status
// does not move. Exit 0 done · 1 the task is closed, the ref is unknown, the branch or the path exists, git refused ·
// 2 unknown task or invalid value · 7 inactive repository · 8 git did not answer.
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { KINDS, open, resolve, setTask } from '../state/index.mjs';
import { git } from '../git/index.mjs';
import { EXIT } from './commands.mjs';
import { insideRepo } from './commit.mjs';

const SLUG = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const refuse = (code, message, hint) => ({ code: EXIT.FAIL, errors: [{ code, message, ...(hint ? { hint } : {}) }] });
const usage = (code, message, hint) => ({ code: EXIT.USAGE, errors: [{ code, message, ...(hint ? { hint } : {}) }] });

export function taskStart({ args, flags, names, io }) {
  const id = args.id;
  KINDS.task.path(id); // a malformed ID throws USAGE
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  if (!where.active) {
    return { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${where.repo} is not active`, hint: `'${names.bin} init' activates it` }] };
  }
  const task = open(where.dir, { names }).read('task', id);
  if (!task) return usage('task-unknown', `no task ${id}`, `'${names.bin} task list' lists the tasks`);
  if (task.status === 'done' || task.status === 'cancelled') return refuse('task-closed', `${id} is ${task.status}: a closed task starts no work`);

  // A state directory inside the repository that was never committed: the new branch would start without any state (first run).
  const rel = insideRepo(where);
  if (rel !== null && git(['ls-tree', '-r', '--name-only', 'HEAD', '--', `${rel}/state.json`], { cwd: where.worktree, env: io.env }).stdout.trim() === '') {
    return { code: EXIT.REFUSED, errors: [{ code: 'state-uncommitted', message: `the state under ${rel} was never committed, so the task branch would start without it`, hint: `commit the state first: ${names.bin} commit --yes` }] };
  }

  let slug = flags.slug;
  if (slug !== undefined) {
    if (!SLUG.test(slug)) return usage('invalid-value', `--slug ${JSON.stringify(slug)} is not [a-z0-9][a-z0-9.-]*, at most 40 characters`);
  } else {
    slug = String(task.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    if (!slug) return usage('invalid-value', `the title of ${id} gives no branch name`, 'pass --slug <s>');
  }
  const branch = `task/${id}-${slug}`;

  const ref = flags.from ?? 'HEAD';
  const rev = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: where.worktree, env: io.env });
  if (rev.error) return { code: EXIT.ENV, errors: [{ code: 'git-failed', message: `git did not answer (${rev.error})`, hint: 'check that git runs in this directory' }] };
  if (rev.status !== 0) return refuse('unknown-ref', `--from ${ref} names no commit`);
  const base = rev.stdout.trim();

  const path = resolvePath(io.cwd, flags.path ?? join(dirname(where.repo), `${basename(where.repo)}-wt`, id));
  if (existsSync(path)) return refuse('worktree-exists', `${path} exists`, 'pass another --path');
  const have = git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: where.repo, env: io.env });
  if (have.status === 0) return refuse('branch-exists', `branch ${branch} exists`, 'pass another --slug');

  const add = git(['worktree', 'add', path, '-b', branch, base], { cwd: where.repo, env: io.env });
  if (add.error || add.status !== 0) {
    const said = String(add.stderr ?? '').trim().split('\n')[0];
    return refuse('worktree-failed', `git worktree add failed: ${said || add.error || `exit ${add.status}`}`.slice(0, 300));
  }

  setTask({ cwd: io.cwd, env: io.env, names, id, state: 'started', options: { branch, base, worktree: path } });
  return { data: { task: id, branch, base, worktree: path, from: ref }, text: `${id}: worktree ${path} on ${branch} from ${base.slice(0, 12)}\n` };
}
