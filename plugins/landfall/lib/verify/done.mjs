// `task done <id>` (spec §7.6, §8.2, GC3): the only way a task becomes done. Its owner closes it when the latest
// verify.json passed for the code at HEAD. The closing conditions are one function evaluated inside the store lock,
// right before the write (review r1 #1); nothing checked before the lock decides. In order:
//   verify-missing       no verify.json
//   verify-failed        its result is not pass
//   verify-dirty         verify ran with uncommitted changes (head null): it verified no commit
//   gates-changed        the profile gates are not the ones verify ran (gatesSha)
//   verify-stale         the task's class changed since verify (a passing verify for another route)
//   review-missing       the route needs a review and the latest round is not approved
//   verify-stale         the working baseline changed since verify (baselineSha)
//   uncommitted-changes  the code has uncommitted changes (everything but local/, verify.json, task.json, the baseline
//                        and the typed review records, which review-missing above reads by value)
//   verify-stale         the code changed since the verified commit
// Done is an event { at, by, event: done, data: { head } } and status done. A done task stays done (exit 0,
// nothing written); a cancelled one is closed (exit 1).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authorHandle } from '../decisions/index.mjs';
import { closeFindings, findingsForTask } from '../findings/index.mjs';
import { emptyProfile } from '../profile/index.mjs';
import { RECEIPT, saveReceipt, taskReceipt } from '../receipts/index.mjs';
import { recordedKeys, routeFor } from '../router/index.mjs';
import { KINDS, StateError, open } from '../state/index.mjs';
import { reviewState } from './artifacts.mjs';
import { activeWhere, codeState, gatesSha, gitIn, storeOf, unknownTask, workingSha } from './run.mjs';

const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });

function closingConditions({ store, task, id, where, env, names }) {
  const again = `run: ${names.bin} verify ${id}`;
  const v = store.read('verify', id);
  if (v === null) throw fail('verify-missing', `${id} has no verify record`, again);
  if (v.result !== 'pass') throw fail('verify-failed', `the latest verify of ${id} is ${v.result}, not pass`, 'fix what it reported, then verify again');
  if (v.head === null) throw fail('verify-dirty', `the latest verify of ${id} ran with uncommitted changes, so it verified no commit`, `commit them, then ${again}`);
  if (gatesSha((store.read('profile', null) ?? emptyProfile()).gates) !== v.gatesSha) throw fail('gates-changed', `the profile gates changed since verify ran them for ${id}`, again);
  if (v.class !== task.class) throw fail('verify-stale', `${id} is ${task.class} now; the passing verify was for ${v.class}`, again);
  if (task.class !== null && reviewState(store, id, routeFor(task.class, { flags: recordedKeys(task).flags }).steps) === 'missing') {
    throw fail('review-missing', `the ${task.class} route needs an approved review of ${id}, and its latest review is not approved`, 'address the review, record an approved round, then verify again');
  }
  if (workingSha(store) !== v.baselineSha) throw fail('verify-stale', 'the working baseline changed since verify', again);
  const code = codeState(where, env);
  if (code.dirty) throw fail('uncommitted-changes', 'the working tree has uncommitted changes', 'commit them and verify again, or remove them');
  if (code.head !== v.head && gitIn(where, env, ['diff', '--quiet', v.head, code.head ?? 'HEAD', ...code.scope]).status !== 0) {
    throw fail('verify-stale', `the code changed since verify ran at ${v.head.slice(0, 12)}`, again);
  }
  return v;
}

// Run in the main checkout, the task's code is in the worktree `task start` recorded, not at the checkout's HEAD.
function taskWhere(where, store, id) {
  if (where.worktree !== where.repo) return where;
  const recorded = [...(store.read('task', id)?.events ?? [])].reverse().find((e) => e.event === 'started')?.data?.worktree;
  if (typeof recorded !== 'string' || !existsSync(join(recorded, '.git'))) return where;
  return { ...where, worktree: recorded };
}

export function markDone({ cwd, env, names, id, at = new Date().toISOString() }) {
  const main = activeWhere({ cwd, env, names });
  KINDS.task.path(id);
  const store = storeOf(main, names);
  const where = taskWhere(main, store, id);
  const handle = authorHandle({ store, where, names, env });
  let changed = false;
  let head = null;
  let pending = [];
  const { task, fixed } = store.batch((s) => {
    const task = s.update('task', id, (cur) => {
      if (cur === null) throw unknownTask(id, where, names);
      if (cur.owner !== handle) throw fail('not-owner', `${id} belongs to ${cur.owner}; only its owner closes it`, `ask ${cur.owner}`);
      if (cur.status === 'cancelled') throw fail('task-closed', `${id} is cancelled: a closed task takes no further state`, `'${names.bin} task new' starts a new task`);
      pending = findingsForTask(s, id).filter((f) => f.status === 'taken');
      if (cur.status === 'done') return undefined;
      ({ head } = closingConditions({ store: s, task: cur, id, where, env, names }));
      changed = true;
      return { ...cur, status: 'done', events: [...cur.events, { at, by: handle, event: 'done', data: { head } }] };
    });
    const fixed = closeFindings(s, pending, { by: id, reason: `Fixed by ${id}`, at });
    return { task, fixed };
  });
  // A receipt failure never undoes the close; the command reports it with a retry hint.
  const result = changed ? refreshReceipt({ cwd, env, names, id }) : { receipt: null, receiptProblem: null };
  return { id, task, changed, head, ...result, fixed };
}

// Refresh after closing or recording a merge, through the receipt unit's state writer. Merge-time gates may
// have no transcript timestamp, so the receipt's duration must also include the recorded merge and this refresh.
export function refreshReceipt({ cwd, env, names, id, mergedAt = null }) {
  try {
    const r = taskReceipt(id, { cwd, env, names });
    const throughMerge = (receipt) => {
      if (mergedAt === null) return receipt;
      const endedAt = new Date(Math.max(Date.now(), Date.parse(mergedAt), Date.parse(receipt.endedAt) || 0)).toISOString();
      return { ...receipt, endedAt, wallMs: receipt.startedAt === null ? null : Date.parse(endedAt) - Date.parse(receipt.startedAt) };
    };
    const saved = saveReceipt(throughMerge(r.receipt), { where: r.where, names });
    if (saved.kept && mergedAt !== null) {
      // Transcripts may have disappeared. Keep the saved usage, but extend its duration under the state lock.
      const store = open(r.where.dir, { names, kinds: { ...KINDS, [RECEIPT.name]: RECEIPT } });
      store.update(RECEIPT.name, id, (cur) => cur === null ? undefined : throughMerge(cur));
    }
    return { receipt: saved.file, receiptProblem: null };
  } catch (err) {
    return { receipt: null, receiptProblem: { code: 'receipt-not-saved', message: `${id}: ${err?.message ?? String(err)}`.replace(/\s+/g, ' ') } };
  }
}
