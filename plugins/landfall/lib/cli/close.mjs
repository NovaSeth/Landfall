// `<bin> close <id…>` (T-MG-178): closes approved tasks in one call. It runs, in order, only the steps still due for
// each task's state — verify and task done while the task is not done, task merge while it has no mergedAt (several
// IDs: one batch, one gate run, as `task merge <ids…>`), then commit — through the functions of those commands, so
// their checks, exit codes and state writes are theirs; close adds no state of its own. The first failing step ends
// the call with that step's exit code and one line naming the step and the command that resumes (close again: the
// steps done stay done). A merge that records nothing (the branch is already in HEAD: close was run in the task's
// own worktree, or the branch was merged by hand) is a failing merge step, never a silent success.
import { StateError } from '../state/index.mjs';
import { forTerminal } from '../text/clean.mjs';
import { taskDone, taskMerge, verify } from '../verify/command.mjs';
import { activeWhere, storeOf } from '../verify/run.mjs';
import { EXIT } from './commands.mjs';
import { commit } from './commit.mjs';
import { LIMITS, clip } from './envelope.mjs';

const codeOf = (r) => r?.code ?? (r?.errors?.length ? EXIT.FAIL : EXIT.OK);
const plain = (e) => ({ code: e.code, message: e.message, hint: e.hint ?? '' });

// The stop line: the step and its exit code first, the resuming command last and whole; the step's own error is
// clipped to the room left within the envelope's message limit (fix round 1, F2), or left out when none is left.
// A long task list becomes its count, a long retry command its first whole IDs and how many more (all of them are in
// --json data.tasks), so head and tail together stay within 200 characters (fix round 2).
const HEAD_IDS_MAX = 60;
const NEXT_MAX = 120;
export function stopMessage({ names, ids, tasks, step, code, why }) {
  const listed = tasks.join(', ');
  const head = `${listed.length <= HEAD_IDS_MAX ? listed : `${tasks.length} tasks`}: close stopped at ${step} (exit ${code})`;
  let next = `${names.bin} close ${ids.join(' ')}`;
  if (next.length > NEXT_MAX) {
    let shown = 0;
    while (shown < ids.length && `${names.bin} close ${ids.slice(0, shown + 1).join(' ')}`.length <= NEXT_MAX) shown++;
    next = `${names.bin} close ${ids.slice(0, shown).join(' ')} … (+${ids.length - shown} more; all ${ids.length} in --json data.tasks)`;
  }
  const tail = `; next: ${next}`;
  const room = LIMITS.message - head.length - tail.length - 2;
  return `${head}${why && room >= 10 ? `: ${clip(why, room)}` : ''}${tail}`;
}

// A step's command function; a typed state error becomes its result, as main.mjs does for a command.
async function run(fn, ctx) {
  try {
    return await fn(ctx);
  } catch (err) {
    if (err instanceof StateError && err.exit !== 'INTERNAL' && Object.hasOwn(EXIT, err.exit)) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
}

export async function close(ctx) {
  const { args, names, io } = ctx;
  const ids = [...new Set([].concat(args.id ?? []))];
  const where = activeWhere({ cwd: io.cwd, env: io.env, names });
  const task = (id) => storeOf(where, names).read('task', id);
  const steps = [];

  // Runs one step; returns the result of the call (a failure) or null when the step passed.
  const step = async (name, tasks, fn, id) => {
    const r = await run(fn, { ...ctx, args: { id }, flags: {} });
    const code = codeOf(r);
    steps.push({ step: name, tasks, code, data: r?.data ?? null, errors: (r?.errors ?? []).map(plain) });
    return code === EXIT.OK ? null : stopped(name, tasks, code, r?.errors?.[0]?.message);
  };
  const stopped = (name, tasks, code, why) => ({
    code,
    data: { tasks: ids, steps, stoppedAt: name },
    errors: [{ code: 'close-stopped', message: stopMessage({ names, ids, tasks, step: name, code, why }), hint: '' }],
  });

  for (const id of ids) {
    if (task(id)?.status === 'done') continue;
    const failed = (await step('verify', [id], verify, id)) ?? (await step('done', [id], taskDone, id));
    if (failed) return failed;
  }
  const unmerged = ids.filter((id) => !task(id)?.mergedAt);
  if (unmerged.length) {
    const failed = await step('merge', unmerged, taskMerge, unmerged);
    if (failed) return failed;
    const missing = unmerged.filter((id) => !task(id)?.mergedAt);
    if (missing.length) {
      steps.at(-1).code = EXIT.FAIL;
      return stopped('merge', missing, EXIT.FAIL, `no merge was recorded (the branch is already in HEAD): run close in the target checkout, or '${names.bin} task merge --adopt ${missing.join(' ')}' for a branch merged by hand`);
    }
  }
  const failed = await step('commit', [], commit, undefined);
  if (failed) return failed;

  const parts = steps.map((s) => {
    if (s.step === 'verify') return `${s.tasks[0]} verified`;
    if (s.step === 'done') return `${s.tasks[0]} done`;
    if (s.step === 'merge') return `merged${s.data?.commit ? ` as ${s.data.commit.slice(0, 12)}` : ''}`;
    return s.data?.committed ? `state committed as ${s.data.commit.slice(0, 12)}` : 'no state to commit';
  });
  return { data: { tasks: ids, steps, stoppedAt: null }, text: `${forTerminal(`${ids.join(', ')}: closed (${parts.join(', ')})`)}\n` };
}
