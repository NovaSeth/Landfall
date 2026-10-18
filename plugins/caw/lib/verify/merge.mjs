// `task merge <id> [--branch <b>]` (spec §7.6, SD-15; lesson 05:16): a merge is committed only when the outcome
// gates pass on exactly the tree that is committed (reviews r1 #4, r2 D3). Steps:
//   1. The branch (--branch, else the task's branch) must name a commit; the working tree must be clean, with no
//      merge in progress. `git merge --no-ff --no-commit <branch>`; a conflict or a failed merge is undone with
//      `git merge --abort` (exit 1, the conflicting paths listed).
//   2. On the merged tree: the task is the caller's and not cancelled (a done task merges: task done on its branch,
//      then task merge, with the gates run again on the merged tree); nothing may be unstaged or untracked; the
//      tree is recorded (`git write-tree`). Any change to the gate set (added, removed, reordered,
//      renamed, command or time limit changed) and any removed or changed risk path needs an active gate-change
//      decision that the target tip does not have yet (r2 D2): gates can run any command, so none is additive. Only
//      a state directory in the repository can come with the branch: a linked one (outside the repository) is no
//      branch's, so there is nothing to compare (its gates change only where the profile is written).
//   3. verify in merge mode (profile gates, the baseline committed on the target tip, report evidence, state files:
//      SD-15's outcome gates; nothing written).
//   4. Only on pass, while the working tree and the index still hold the recorded tree and the target has not moved:
//      `git commit --no-edit`, so the user's commit hooks run (a refusing hook → `commit-failed`). If a hook changed
//      the content, HEAD^{tree} differs from the verified tree: `git reset --soft HEAD^` moves the branch back (the
//      merge stays staged, nothing is lost) and the result is `hook-modified-tree` (exit 1).
// A refusal before the commit undoes the merge: files the gates changed are restored from the index, then
// `git merge --abort` (the tree was clean before the merge). A target that moved while the gates ran is never moved
// back: the merge is left as it is (`target-moved`). An up-to-date branch merges nothing (exit 0).
import { authorHandle, readRecords } from '../decisions/index.mjs';
import { emptyProfile } from '../profile/index.mjs';
import { KINDS, StateError } from '../state/index.mjs';
import { activeWhere, evaluate, gatesSha, gitIn, stateAt, storeOf } from './run.mjs';

const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });
const firstLine = (r) => (r.stderr || r.stdout).trim().split('\n')[0] ?? '';

// Whether `merged` changes the gate set of `target` in any way, or drops or changes one of its risk paths.
const changesGates = (target, merged) => gatesSha(target.gates) !== gatesSha(merged.gates) || target.riskPaths.some((p) => !merged.riskPaths.includes(p));

// The gates and risk paths of a committed profile text (empty when there is none or it cannot be read).
function profileOf(text) {
  try {
    const doc = text === null ? null : JSON.parse(text);
    return { gates: Array.isArray(doc?.gates) ? doc.gates : [], riskPaths: Array.isArray(doc?.riskPaths) ? doc.riskPaths : [] };
  } catch {
    return emptyProfile();
  }
}

export function mergeTask({ cwd, env, names, id, branch, at = new Date().toISOString() }) {
  const where = activeWhere({ cwd, env, names });
  KINDS.task.path(id);
  const store = storeOf(where, names);
  const ref = branch ?? store.read('task', id)?.branch ?? null;
  if (ref === null) throw usage('missing-branch', `${id} records no branch: name the one to merge`, `${names.bin} task merge ${id} --branch <branch>`);
  if (ref.startsWith('-') || gitIn(where, env, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).status !== 0) {
    throw usage('unknown-branch', `${ref} names no commit in ${where.repo}`, 'check the name, or fetch the branch first');
  }
  const handle = authorHandle({ store, where, names, env });
  const merging = () => gitIn(where, env, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
  if (merging()) throw fail('merge-in-progress', 'a merge is already in progress', 'finish it or run git merge --abort first');
  if (gitIn(where, env, ['status', '--porcelain', '--untracked-files=all']).stdout.trim() !== '') {
    throw fail('dirty-tree', 'the working tree has changes; the gates must run on the merged tree only', 'commit or remove them first');
  }
  const head = () => gitIn(where, env, ['rev-parse', 'HEAD']).stdout.trim();
  const tip = head();
  // Undo the merge: tracked files the gates changed are restored from the index first, so the abort can proceed.
  const undo = ({ conflicted = false } = {}) => {
    if (!merging()) return;
    if (!conflicted) gitIn(where, env, ['checkout', '-q', '--', '.']);
    gitIn(where, env, ['merge', '--abort']);
  };
  const base = { task: id, branch: ref, merged: false, upToDate: false, commit: null, conflicts: [], result: null, verify: null, output: [] };
  const refused = (code, message, hint, extra = {}) => { undo(); return { ...base, ...extra, reasons: [{ code, message, hint }], exit: 'FAIL' }; };

  const m = gitIn(where, env, ['merge', '--no-ff', '--no-commit', ref]);
  if (m.status !== 0) {
    const conflicts = gitIn(where, env, ['diff', '--name-only', '-z', '--diff-filter=U']).stdout.split('\0').filter(Boolean).sort();
    undo({ conflicted: true });
    const reason = conflicts.length
      ? { code: 'merge-conflict', message: `merging ${ref} conflicts in ${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}; the merge was undone`, hint: `merge ${ref} with the current branch first (in the branch), verify it, then merge again` }
      : { code: 'merge-failed', message: `git merge ${ref} failed: ${firstLine(m)}`.slice(0, 300), hint: 'run the merge by hand to see why' };
    return { ...base, conflicts, reasons: [reason], exit: 'FAIL' };
  }
  if (!merging()) return { ...base, upToDate: true, reasons: [], exit: 'OK' };

  let out;
  let tree;
  try {
    const task = store.read('task', id);
    if (task === null) return refused('task-unknown', `no task ${id} on the merged tree`, `'${names.bin} task list' lists the tasks`);
    if (task.owner !== handle) return refused('not-owner', `${id} belongs to ${task.owner}; only its owner merges it`, `ask ${task.owner}`);
    if (task.status === 'cancelled') return refused('task-closed', `${id} is cancelled: a cancelled task is not merged`, `'${names.bin} task new' starts a new task`);
    const unchanged = () => gitIn(where, env, ['diff', '--quiet']).status === 0 && gitIn(where, env, ['ls-files', '--others', '--exclude-standard']).stdout.trim() === '';
    if (!unchanged()) return refused('merge-tree-changed', 'the merge left unstaged or untracked changes', 'merge by hand to see what changed them');
    tree = gitIn(where, env, ['write-tree']).stdout.trim();
    const target = stateAt(where, env, tip, 'profile.json');
    if (target.rel !== null && changesGates(profileOf(target.text), store.read('profile', null) ?? emptyProfile())) {
      const known = new Set(gitIn(where, env, ['ls-tree', '-r', '--name-only', tip, '--', `${target.rel}/decisions`]).stdout.split('\n').map((p) => p.slice(p.lastIndexOf('/') + 1)));
      const fresh = readRecords(where.dir).records.some((r) => r.doc.status === 'active' && r.doc.kind === 'gate-change' && !known.has(r.name));
      if (!fresh) return refused('gate-change-required', `${ref} changes the target's gates or drops one of its risk paths`, 'record the change as a gate-change decision in the branch, then merge again');
    }
    out = evaluate({ where, names, env, id, mode: 'merge', at, anchor: tip, merged: gitIn(where, env, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).stdout.trim() || null });
    const verified = { result: out.doc.result, verify: out.doc, output: out.output };
    if (out.doc.result !== 'pass') {
      undo();
      return { ...base, ...verified, reasons: out.reasons, exit: out.doc.result === 'error' ? 'ENV' : 'FAIL' };
    }
    if (!unchanged() || gitIn(where, env, ['write-tree']).stdout.trim() !== tree) {
      return refused('merge-tree-changed', 'the working tree or the index changed while the gates ran: they did not verify what would be committed', 'find what writes to tracked files during the gates (a formatter, a build into the tree), then merge again', verified);
    }
    if (head() !== tip) {
      return { ...base, ...verified, reasons: [{ code: 'target-moved', message: `the target moved from ${tip.slice(0, 12)} while the gates ran; nothing was committed and nothing was moved back`, hint: 'inspect the new commits, then git merge --abort and run task merge again' }], exit: 'FAIL' };
    }
  } catch (err) {
    undo();
    throw err;
  }
  const c = gitIn(where, env, ['commit', '--no-edit', '-q']);
  if (c.status !== 0) {
    undo();
    return { ...base, result: out.doc.result, verify: out.doc, output: out.output, reasons: [{ code: 'commit-failed', message: `git commit of the merge was refused: ${firstLine(c)}`.slice(0, 300), hint: 'a commit hook refused it; fix what it reports, then merge again' }], exit: 'FAIL' };
  }
  const commit = head();
  if (gitIn(where, env, ['rev-parse', `${commit}^{tree}`]).stdout.trim() !== tree) {
    if (gitIn(where, env, ['rev-parse', `${commit}^`]).stdout.trim() === tip) gitIn(where, env, ['reset', '-q', '--soft', 'HEAD^']);
    return { ...base, result: out.doc.result, verify: out.doc, output: out.output, reasons: [{ code: 'hook-modified-tree', message: 'a commit hook changed the merged tree after the gates ran; the commit was undone and the merge is left staged', hint: 'review the staged changes, clear them (git restore --staged --worktree .), then run task merge again' }], exit: 'FAIL' };
  }
  return { ...base, merged: true, commit, result: 'pass', verify: out.doc, output: out.output, reasons: [], exit: 'OK' };
}
