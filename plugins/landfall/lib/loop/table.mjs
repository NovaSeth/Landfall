// The tick table (spec §7.7 step 3; the 1.x tick.mjs table, driven by task state instead of file names): per open
// task status → state → next step → rule IDs, plus run rows and project rows. A pure function of the task documents
// (lib/state), the run records, the team and the loop's rounds cap; `dirty` (git status of the state directory) is
// asked only when nothing else is left. Only status `done` completes a task; `cancelled` closes it.
//   new (not routed) → route · new (routed) | planned → brief and dispatch · dispatched | in-review → wait, a status
//   request after 20 min without an event · implemented (round 0) → check the report, dispatch the review and record
//   it as dispatched (the reviewer as executor), so the next tick waits ·
//   implemented (round k) | fix-round (round k delivered, no open findings) → scoped re-review, or approved after a
//   self-verified event of round k · fix-round with open findings → wait · round > rounds cap → decide (REV-7) ·
//   verified → verify, merge, close · blocked after an implementer report → resolve it (ORC-7) · blocked otherwise →
//   information (waits) · done | cancelled → nothing.
// A live run (queued, starting, running) of an open task turns its row into a wait for that run, so a step is not
// started twice; a live run of a closed task is a wait row of its own. A finished run whose end is newer than every
// event of its task → collect its result, closed task or not (1.x: every finished run before the end); a closed task
// takes no further state, so a task whose title starts with "<runId>:" records it.
// Team (more than one registered handle): actions only for my tasks and tasks of an owner who is not registered;
// other owners' open tasks are information and keep the loop waiting. Plan (`--plan`): entries `### Task <ref>:
// <title>` outside code fences; a task belongs to an entry when its ID is the ref or its title starts with
// "<ref>:" or "<ref> ". The first entry without a task is the next step when none of my tasks is open, else a hint.
// Outcome: action when any action row exists; wait when work runs (my waiting tasks, live runs, blocked or others'
// tasks); done otherwise (then the state directory must be committed). Rows: { task, state, step, rules, kind }.
export const STATUS_MIN = 20; // ORC-9 default: status request after 20 min without an event
export const WAIT_S = Object.freeze({ runs: 600, agents: 1800, min: 60, max: 3600 });
const LIVE = new Set(['queued', 'starting', 'running']);
const FINISHED = new Set(['done', 'failed', 'timeout', 'stopped']);
const CLOSED = new Set(['done', 'cancelled']);
const BLOCKING_REPORTS = new Set(['needs-context', 'blocked']);
const MIN_MS = 60000;

// Every rule ID this table cites (tests check that each resolves in the method).
export const TABLE_RULES = Object.freeze(['FLW-3', 'ORC-4', 'FLW-4', 'ORC-9', 'FLW-6', 'PRI-6', 'ORC-5', 'REV-6', 'REV-20', 'REV-7',
  'REV-11', 'FLW-8', 'ORC-7', 'SPC-1', 'SPC-2', 'SPC-11', 'FLW-9', 'PRI-1', 'COL-24', 'FLW-7']);

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const cell = (s) => String(s).replace(/[|\r\n]+/g, '/');
const action = (task, state, step, rules) => ({ task, state, step, rules, kind: 'action' });
const wait = (task, state, step, rules) => ({ task, state, step, rules, kind: 'wait' });
const timeOf = (e) => Date.parse(e?.at ?? '') || 0;
const lastEvent = (t) => t.events.reduce((m, e) => Math.max(m, timeOf(e)), 0);
const lastIndex = (events, names) => { for (let i = events.length - 1; i >= 0; i--) if (names.includes(events[i].event)) return i; return -1; };

// Plan entries of a Markdown plan: [{ ref, title }] in order.
export function parsePlan(text) {
  const out = [];
  let fence = false;
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    const m = !fence && /^### Task ([A-Za-z0-9][A-Za-z0-9._-]{0,39}):\s*(.*?)\s*$/.exec(line);
    if (m) out.push({ ref: m[1], title: m[2].slice(0, 100) });
  }
  return out;
}

const belongs = (t, ref) => t.id === ref || t.title === ref || t.title.startsWith(`${ref}:`) || t.title.startsWith(`${ref} `);

function taskRow(t, { now, bin, lanesOn, caps }) {
  const id = t.id;
  const age = Math.floor((now - lastEvent(t)) / MIN_MS);
  const working = (state) => (age >= STATUS_MIN
    ? action(id, `${state} (${age} min since its last event)`, `ask the executor for a 5-line status; check git, processes and logs; record it: \`${bin} task set ${id} status-request\``, ['ORC-9'])
    : wait(id, state, 'wait for the executor; its completion notice is the main signal', ['FLW-4']));
  // a review dispatched to an in-session agent is visible only once recorded: the task then waits as dispatched
  const record = `record it: \`${bin} task set ${id} dispatched --executor <reviewer> --base <sha>\``;
  const approved = (state) => action(id, state, `merge origin/main into its branch and verify it again: \`${bin} verify ${id}\`; merge it (a squashed pull request, or locally without a remote) and close it: \`${bin} task done ${id}\``, ['REV-11', 'FLW-8']);
  const decide = (k) => action(id, `fix round ${k} after the ${caps.rounds}-round limit`,
    'decide: escalate to the user or change the approach, and start no further fix round (Critical findings are exempt: they go to the strongest executor)', ['REV-7']);
  // round k is delivered: approved when a self-verified event of round k follows the last fix-round event
  const delivered = (k) => {
    const from = lastIndex(t.events, ['fix-round']);
    if (t.events.slice(from + 1).some((e) => e.event === 'self-verified' && e.data?.round === k)) return approved(`fix round ${k} verified by the orchestrator`);
    const last = k >= caps.rounds ? `; if it needs fixes again, decide (escalate to the user or change the approach): no fix round ${k + 1}` : '';
    return action(id, `fix round ${k} delivered`, `dispatch the scoped re-review of round ${k}'s diff and ${record}; a mechanical or UI round you may verify yourself: \`${bin} task set ${id} self-verified --round ${k}\`${last}`,
      k >= caps.rounds ? ['REV-6', 'REV-20', 'REV-7'] : ['REV-6', 'REV-20']);
  };
  switch (t.status) {
    case 'new':
      if (t.class === null) return action(id, 'new, not routed', `classify it: \`${bin} route ${id} --paths <p,…> --loc <n>\``, ['FLW-3']);
    // falls through: a routed task is planned
    case 'planned':
      return action(id, `${t.class ?? 'routed'}, not dispatched`,
        `write the brief (\`${bin} brief ${id}\`), dispatch the executor its route names, then record it: \`${bin} task set ${id} dispatched --executor <executor> --base <sha>${lanesOn && !t.lane ? ' --lane <lane>' : ''}\``, ['FLW-3', 'ORC-4']);
    case 'dispatched': return working('executor working');
    case 'in-review': return working('review in progress');
    case 'implemented':
      if (t.round > caps.rounds) return decide(t.round);
      if (t.round > 0) return delivered(t.round);
      return action(id, 'report delivered', `check the report: exit codes and result counts; then dispatch the review to another executor and ${record}`, ['FLW-6', 'PRI-6', 'ORC-5']);
    case 'fix-round': {
      if (t.round > caps.rounds) return decide(t.round);
      const e = t.events[lastIndex(t.events, ['fix-round'])];
      if (e && e.data?.open > 0) return working(`fix round ${t.round} in progress (${e.data.open} open)`);
      return delivered(t.round);
    }
    case 'verified': return approved('verified');
    case 'blocked': {
      const e = t.events[lastIndex(t.events, ['implementer', 'blocked'])];
      if (e?.event === 'implementer' && BLOCKING_REPORTS.has(e.data?.report)) {
        return action(id, `report: ${e.data.report}`, `resolve the gap or the obstacle, no review; then dispatch again: \`${bin} task set ${id} dispatched --executor <executor> --base <sha>\``, ['ORC-7']);
      }
      return { task: id, state: `blocked: ${cell(e?.data?.reason ?? 'no reason recorded')}`, kind: 'blocked' };
    }
    default: return { task: id, state: `unknown status ${cell(t.status)}`, kind: 'blocked' };
  }
}

export function nextSteps({ tasks = [], runs = [], handles = [], me = null, plan = null, lanesOn = false, caps, now, bin, problem = null, dirty = () => [] }) {
  const steps = [];
  const info = [];
  const multi = handles.length > 1;
  const mine = (t) => !multi || (me !== null && t.owner === me) || !handles.includes(t.owner);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = (t) => t && !CLOSED.has(t.status);
  let liveRuns = 0;
  const liveOf = new Map(); // task → its first live run (sorted by run ID)
  for (const r of [...runs].sort((a, b) => natural(a.runId, b.runId))) {
    if (!LIVE.has(r.status)) continue;
    liveRuns++; // a live run of any task, a closed one too: the loop waits for it
    if (!liveOf.has(r.task)) liveOf.set(r.task, r);
  }
  if (problem) {
    steps.push(action('-', `the task state cannot be read: ${cell(problem.message)}`, cell(problem.hint || 'repair or restore the file'), ['FLW-7']));
  } else {
    if (multi && me === null) steps.push(action('-', 'your git user.email has no handle in this repository', `register it: \`${bin} init\``, []));
    let ownOpen = 0;
    for (const t of [...tasks].sort((a, b) => natural(a.id, b.id))) {
      if (!open(t)) continue;
      if (!mine(t)) { info.push({ task: t.id, state: `${t.owner}: ${t.status}${t.lane ? ` (lane ${t.lane})` : ''}`, kind: 'others' }); continue; }
      ownOpen++;
      const r = taskRow(t, { now, bin, lanesOn, caps });
      const run = liveOf.get(t.id);
      // a live run of the task is its work in progress: wait for it instead of starting the step again
      if (run && r.kind !== 'blocked') steps.push(wait(t.id, `${r.state}; run ${run.runId} ${run.status}`, 'wait for the run; its record changes when it ends', ['FLW-4']));
      else (r.kind === 'blocked' ? info : steps).push(r);
    }
    for (const r of [...runs].sort((a, b) => natural(a.runId, b.runId))) {
      const t = byId.get(r.task);
      if (!t || !mine(t)) continue;
      if (LIVE.has(r.status)) {
        // a live run of an open task waits in its task's row; of a closed task, in its own
        if (!open(t)) steps.push(wait(r.runId, `run ${r.status} for ${t.id}, ${t.status}`, 'wait for the run; its record changes when it ends', ['FLW-4']));
      } else if (FINISHED.has(r.status) && r.endedAt && Date.parse(r.endedAt) > lastEvent(t) && !tasks.some((x) => belongs(x, r.runId))) {
        // collected: an event of its task after it ended, or (a closed task takes no further state) a task named after it
        const record = open(t) ? `then record ${t.id}'s state`
          : `${t.id} is ${t.status}, so record it as a task named after the run: \`${bin} task new "${r.runId}: <what follows>"\` (cancel that task with the reason when nothing follows)`;
        steps.push(action(r.runId, `run ${r.status}${r.exit === null || r.exit === undefined ? '' : `, exit ${r.exit}`} for ${t.id}`, `collect its result: check the exit code and the result count, ${record}`, ['FLW-6']));
      }
    }
    if (plan) {
      const next = plan.entries.find((e) => !tasks.some((t) => belongs(t, e.ref)));
      if (plan.entries.length === 0) steps.push(action('-', `${cell(plan.path)} has no "### Task <id>: <title>" entries`, 'give the plan its task headings, or tick without --plan', ['SPC-11']));
      else if (next && ownOpen === 0) steps.push(action(next.ref, `next in ${cell(plan.path)}`, `create its task: \`${bin} task new "${cell(`${next.ref}: ${next.title}`).replace(/"/g, "'")}"\``, ['SPC-11', 'FLW-9']));
      else if (next) info.push({ task: next.ref, state: `next in ${cell(plan.path)} when a slot frees: ${cell(next.title)}`, kind: 'plan' });
    } else if (tasks.length === 0) {
      steps.push(action('START', 'no tasks yet', `write the spec and the plan (\`${bin} rule SPC-1 SPC-2\`), then create the first task: \`${bin} task new "<title>"\``, ['SPC-1', 'SPC-2']));
    }
  }
  const acting = steps.some((s) => s.kind === 'action');
  const waiting = steps.some((s) => s.kind === 'wait') || info.some((i) => i.kind === 'blocked' || i.kind === 'others') || liveRuns > 0;
  if (!acting && !waiting) {
    const files = dirty();
    if (files.length) {
      const list = files.slice(0, 5).join(', ') + (files.length > 5 ? ', …' : '');
      steps.push(multi
        ? action('-', `state changes not committed: ${files.length} (${cell(list)})`, 'commit them on your process branch and open a pull request; then tick', ['COL-24'])
        : action('-', `state changes not committed: ${files.length} (${cell(list)})`, 'commit them (git add and git commit); then tick', ['PRI-1']));
      return { steps, info, outcome: 'action', nextTickS: null, liveRuns };
    }
    return { steps, info, outcome: 'done', nextTickS: null, liveRuns };
  }
  if (acting) return { steps, info, outcome: 'action', nextTickS: null, liveRuns };
  const s = liveRuns > 0 ? WAIT_S.runs : WAIT_S.agents;
  return { steps, info, outcome: 'wait', nextTickS: Math.min(WAIT_S.max, Math.max(WAIT_S.min, s)), liveRuns };
}
