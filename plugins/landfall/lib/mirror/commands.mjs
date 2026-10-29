// `mirror github` (T-MG-19, D-MG-23): CLI handler. Handlers return data/text; cli/output.mjs is the only terminal writer.
import { StateError, listTasks } from '../state/index.mjs';
import { apply, authStatus, defaultRepo, listIssues, plan } from './index.mjs';

const env = (code, message, hint) => ({ code: 8, errors: [{ code, message, hint }] });

export function github({ flags, names, io }) {
  const ctx = { io };
  if (flags.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) throw new StateError('invalid-value', 'USAGE', '--repo must be <owner>/<name>');
  const listed = listTasks({ cwd: io.cwd, env: io.env, names });
  if (!listed.active) throw new StateError('inactive', 'REFUSED', `${listed.repo} is not active: it has no tasks to mirror`, { hint: `${names.bin} init` });
  const auth = authStatus(ctx);
  if (auth.error === 'missing') return env('gh-missing', 'the gh CLI is not installed', 'install it from https://cli.github.com and run `gh auth login`');
  if (auth.status !== 0) return env('gh-auth', `gh is not authenticated: ${auth.stderr.trim() || `exit ${auth.status}`}`, 'run `gh auth login`');
  const repo = flags.repo ?? defaultRepo(ctx);
  if (!repo) return env('gh-repo', 'gh has no default repository for this directory', 'pass --repo <owner>/<name>');
  const found = listIssues(repo, ctx);
  if (found.error) return env('gh-list', found.error, 'check access to the repository with `gh repo view`');
  const entries = plan(listed.tasks, found.issues);
  const view = entries.map((e) => ({ action: e.action, id: e.id, ...(e.number ? { number: e.number } : {}), ...(e.diff ? { diff: e.diff } : {}) }));
  const lines = [`target repository: ${repo}`, ...entries.map((e) => `${e.action.padEnd(6)} ${e.want.title}${e.diff?.length ? ` (${e.diff.join(', ')})` : ''}`)];
  if (flags.dryRun) return { data: { repo, dryRun: true, plan: view, applied: false }, text: `${lines.join('\n')}\ndry run: nothing was written\n` };
  const done = apply(repo, entries, ctx);
  if (!done.done) return { code: 1, data: { repo, plan: view, applied: false }, errors: [{ code: 'gh-write', message: done.error, hint: 'rerun to continue: the mirror is idempotent' }] };
  const n = entries.filter((e) => e.action !== 'none').length;
  return { data: { repo, plan: view, applied: true }, text: `${lines.join('\n')}\n${n ? `mirrored ${n} issue${n === 1 ? '' : 's'}` : 'nothing to mirror: the issues are up to date'}\n` };
}
