// `<bin> commit [--message <text>]` (retro 2026-10 §4.4): one commit of the changes under the state directory, so the
// state the plugin writes (tasks, decisions, reports, reviews, the profile, the baseline) reaches git without the
// orchestrator spelling out `git add` and `git commit` after every command, and without touching the code or anything
// else staged. Only paths under the state directory are staged and committed (`git add -A -- <state>`, `git commit --
// <state>`); the message names what changed (task IDs, decision IDs, files) unless --message is given. The commit runs
// the user's hooks: a refusing hook is `commit-failed` (exit 1, the paths stay staged). Nothing changed, or a state
// directory outside the repository (`init --state-dir`: git tracks none of it): exit 0, nothing done.
// Exit 0 · 1 the commit was refused · 2 a bad message · 7 inactive repository, no consent · 8 not a git repository.
import { isAbsolute, relative, sep } from 'node:path';
import { git } from '../git/index.mjs';
import { StateError, resolve } from '../state/index.mjs';
import { hidden } from '../text/clean.mjs';
import { EXIT } from './commands.mjs';

const MESSAGE_MAX = 200;
const SUMMARY_MAX = 120;

// The state directory relative to the repository ('/' separators), or null when it lies outside.
function insideRepo(where) {
  const rel = relative(where.repo, where.dir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : null;
}

// What a list of changed state paths (relative to the state directory) is about: task IDs, then decision IDs, then
// the other files by their first segment (dot files left out when anything else is named), each once.
export function summarize(paths) {
  const ids = [];
  const rest = [];
  const add = (list, x) => { if (!list.includes(x)) list.push(x); };
  for (const p of paths) {
    let m;
    if ((m = /^tasks\/([^/]+)\//.exec(p))) add(ids, m[1]);
    else if ((m = /^decisions\/([^/]+)\.md$/.exec(p))) add(ids, m[1]);
    else if (p === 'baseline/tests.json') add(rest, 'baseline');
    else if (/^[^/]+\.json$/.test(p)) add(rest, p.slice(0, -5));
    else add(rest, p.split('/')[0]);
  }
  const named = rest.filter((x) => !x.startsWith('.'));
  const items = [...ids, ...(named.length || ids.length ? named : rest)];
  let text = items.join(', ');
  if (text.length > SUMMARY_MAX) {
    let n = items.length;
    while (n > 1 && `${items.slice(0, n).join(', ')} (+${items.length - n} more)`.length > SUMMARY_MAX) n--;
    text = `${items.slice(0, n).join(', ')} (+${items.length - n} more)`;
  }
  return text;
}

// The changed paths under `rel` as git sees them (tracked changes and untracked files; ignored ones, local/, excluded).
function changed(where, env, rel) {
  const r = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', rel], { cwd: where.repo, env });
  if (r.error) throw new StateError('git-failed', 'ENV', `git status could not run (${r.error})`, { hint: 'install git and put it on PATH' });
  if (r.status !== 0) throw new StateError('git-failed', 'ENV', `git status failed in ${where.repo}`, { hint: 'check that the repository is readable' });
  const items = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const path = items[i].slice(3);
    if (/^[RC]/.test(items[i])) i++; // -z: a rename is followed by its old path
    out.push(path);
  }
  return out.sort();
}

export function commit({ flags, names, io }) {
  const { bin } = names;
  if (flags.message !== undefined) {
    const m = String(flags.message);
    if (m.trim() === '' || [...m].length > MESSAGE_MAX || /[\r\n]/.test(m) || hidden(m).length) {
      return { code: EXIT.USAGE, errors: [{ code: 'invalid-value', message: `--message must be 1 to ${MESSAGE_MAX} plain characters`, hint: 'one line, no control characters; nothing was committed' }] };
    }
  }
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  if (!where.active) return { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${where.repo} is not active: there is no state to commit`, hint: `'${bin} init' activates it` }] };
  const rel = insideRepo(where);
  if (rel === null) return { data: { committed: false, commit: null, files: [], message: null, linked: true }, text: `the state of ${where.repo} lives outside the repository (${where.dir}): git tracks none of it, nothing to commit\n` };
  const files = changed(where, io.env, rel);
  if (files.length === 0) return { data: { committed: false, commit: null, files: [], message: null, linked: false }, text: `nothing to commit under ${rel}\n` };
  const message = flags.message !== undefined ? String(flags.message) : `chore(${bin}): ${summarize(files.map((p) => p.slice(rel.length + 1)))}`;
  const env = io.env;
  const add = git(['add', '-A', '--', rel], { cwd: where.repo, env });
  if (add.status !== 0) return { code: EXIT.FAIL, errors: [{ code: 'commit-failed', message: `git add failed: ${(add.stderr || add.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300), hint: 'run git status in the repository to see why' }] };
  const c = git(['commit', '-q', '-m', message, '--', rel], { cwd: where.repo, env });
  if (c.status !== 0) return { code: EXIT.FAIL, data: { committed: false, commit: null, files, message, linked: false }, errors: [{ code: 'commit-failed', message: `git commit was refused: ${(c.stderr || c.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300), hint: 'a commit hook refused it; fix what it reports (the state paths stay staged), then commit again' }] };
  const sha = git(['rev-parse', 'HEAD'], { cwd: where.repo, env }).stdout.trim();
  return { data: { committed: true, commit: sha, files, message, linked: false }, text: `committed ${files.length} state ${files.length === 1 ? 'file' : 'files'} as ${sha.slice(0, 12)}: ${message}\n` };
}
