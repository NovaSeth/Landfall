// `<bin> status` (spec §8.2, §12; ui unit, §4.2): the read-only view of the repository at the working directory, and
// what `<bin>` prints with no command. Lines: the repository · its activation state (active with the state directory
// and whether it is linked, declined, not active) · the tier from the engine, evaluated without recording (`tier`
// records a change; an engine turned off is a line, not a refusal) · the open tasks with the next step of the loop's
// step table (lib/loop nextSteps: the same rows `tick` acts on) · the loop record when one exists · the scheduler
// leases taken for this repository (lease project = its path; a task ID alone could be another repository's). At
// most 25 lines: the task rows are cut first and counted. --json: data { repo, state, tier, tasks, steps, loop,
// leases, watch, findings } with every open task (and its timing: startedAt, lastEventAt, expectedMs, expectedFrom) and step; watch: the ORC-24 rows (a heavy-queue wait over 10 min, load
// over the max); findings: the backlog counts { open, taken }.
// Writes nothing. Exit 0 · 1 a state file is invalid · 7 a newer state schema · 8 not a git repository, git missing.
import { join } from 'node:path';
import { findingCounts } from '../findings/index.mjs';
import { TIER_NAMES, evaluate } from '../engine/index.mjs';
import { describe } from '../loop/command.mjs';
import { DEFAULT_CAPS, LOOP, STORE_KINDS, nextSteps, outsideMerges, readBudgets } from '../loop/index.mjs';
import { readWatch } from '../loop/table.mjs';
import { readRuns } from '../receipts/index.mjs';
import { snapshot } from '../sched/index.mjs';
import { StateError, emailHash, gitIdentity, open, resolve } from '../state/index.mjs';

const MAX_LINES = 25;
const CLOSED = new Set(['done', 'cancelled']);
const LEASES_SHOWN = 3;
const HISTORY_MIN = 3; // done tasks of a class needed before their median replaces the default
const EXPECTED_MS = Object.freeze({ trivial: 900000, standard: 2700000, critical: 7200000 }); // 15 min, 45 min, 2 h
const NO_CLASS_MS = 2700000;

const startOf = (task) => (task.events ?? []).find((e) => e.event === 'dispatched' || e.event === 'started')?.at ?? null;
const doneOf = (task) => [...(task.events ?? [])].reverse().find((e) => e.event === 'done')?.at ?? null;

// Median start-to-done milliseconds per class over the done tasks, computed once per call.
function medians(all) {
  const spans = new Map();
  for (const t of all) {
    if (t.status !== 'done' || !t.class) continue;
    const span = Date.parse(doneOf(t)) - Date.parse(startOf(t));
    if (!Number.isFinite(span)) continue;
    if (!spans.has(t.class)) spans.set(t.class, []);
    spans.get(t.class).push(span);
  }
  const out = new Map();
  for (const [cls, xs] of spans) {
    if (xs.length < HISTORY_MIN) continue;
    xs.sort((a, b) => a - b);
    const m = xs.length >> 1;
    out.set(cls, xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2);
  }
  return out;
}

function stateLine(where, bin) {
  if (where.active) return { status: 'active', text: `active · ${where.dir} (${where.linked ? 'linked' : 'in the repository'})` };
  if (where.declined) return { status: 'declined', text: `declined · '${bin} init' starts tracking explicitly` };
  return { status: 'not-active', text: `not active · '${bin} init' activates it` };
}

// The tier as recorded (a change the evaluation finds is due, not made), or null when the engine is off.
function tierOf(where, names, env) {
  let r;
  try {
    r = evaluate(where, { names, env, record: false });
  } catch (err) {
    if (err instanceof StateError && err.code === 'capability-off') return { tier: null, text: `engine off (flags.engine; '${names.bin} flags set engine shadow' turns it back on)` };
    throw err;
  }
  const tier = r.change ? r.change.from : r.tier;
  const due = r.change ? ` · change due: ${r.change.from} → ${r.change.to}${where.active ? `, recorded by \`${names.bin} tier\`` : ''}`
    : r.waiting ? ` · waiting: ${r.waiting.to} after ${r.waiting.until}` : '';
  return {
    tier: { tier, name: TIER_NAMES[tier], mode: r.mode, change: r.change, waiting: r.waiting, reasons: r.reasons, signals: r.signals },
    text: `${tier} ${TIER_NAMES[tier]} (engine ${r.mode})${due}`,
  };
}

// Open tasks and the step table's rows for them (state of an active repository only).
function tasksOf(where, names, env) {
  const store = open(where.dir, { names, kinds: STORE_KINDS });
  const all = store.list('task').map((id) => store.read('task', id));
  const team = store.list('team').map((h) => store.read('team', h));
  const { email } = gitIdentity(where.repo, { env });
  const hash = email ? emailHash(email) : null;
  const doc = store.read(LOOP.name, null);
  const outside = outsideMerges({ where, env, tasks: all });
  const table = nextSteps({
    tasks: all, runs: readRuns(join(where.local, 'runs')).runs, handles: team.map((d) => d.handle), me: team.find((d) => d.emailSha256 === hash)?.handle ?? null,
    plan: null, lanesOn: store.read('config', null)?.flags?.lanes === 'on', caps: doc?.caps ?? DEFAULT_CAPS, now: Date.now(), bin: names.bin, budgets: readBudgets(where.dir, all), problem: null, dirty: () => [], outside,
  });
  return { all, open: all.filter((t) => !CLOSED.has(t.status)), rows: [...table.steps, ...table.info], outside, loop: doc };
}

const rowText = (r, status) => {
  const rules = r.rules?.length ? ` (${r.rules.join(', ')})` : '';
  return `  ${r.task}  ${status ?? r.kind}  ${r.state}${r.step ? ` → ${r.step}${rules}` : ''}`;
};
const leaseText = (l) => (l.owner
  ? `  ${l.kind}-${l.slot}  ${l.status}${l.orphan ? ' (orphan child running)' : ''}  ${l.task ?? '-'}  ports ${l.ports[0]}-${l.ports[1]}  db ${l.db}`
  : `  ${l.kind}-${l.slot}  ${l.status}`);

export function status({ names, io }) {
  const { env, cwd } = io;
  const where = resolve({ cwd, env, names });
  const state = stateLine(where, names.bin);
  const tier = tierOf(where, names, env);
  const t = where.active ? tasksOf(where, names, env) : { all: [], open: [], rows: [], outside: [], loop: null };
  const leases = where.dataDir ? snapshot({ names, env }).leases.filter((l) => l.project === where.worktree) : []; // leases name their checkout (lib/sched)

  const watch = where.dataDir ? readWatch({ names, env, readings: io.readings ?? null }) : []; // ORC-24
  const findings = where.active ? findingCounts(open(where.dir, { names })) : { open: 0, taken: 0 };
  const head = [where.repo, `State: ${state.text}`, `Tier: ${tier.text}`, ...watch.map((w) => w.message)];
  const tail = [];
  if (findings.open + findings.taken > 0) tail.push(`Findings: ${findings.open} open, ${findings.taken} taken (${names.bin} findings list)`);
  if (t.loop) tail.push(...describe(t.loop, Date.now()).trimEnd().split('\n').map((x, i) => (i === 0 ? `Loop: ${x}` : `      ${x}`)));
  if (leases.length) {
    tail.push(`Leases: ${leases.length}`, ...leases.slice(0, LEASES_SHOWN).map(leaseText));
    if (leases.length > LEASES_SHOWN) tail.push(`  … ${leases.length - LEASES_SHOWN} more: \`${names.bin} slots\``);
  }
  const body = [];
  if (where.active) {
    body.push(`Tasks: ${t.open.length} open of ${t.all.length}`);
    const statusOf = new Map(t.all.map((x) => [x.id, x.status]));
    const rows = t.rows.map((r) => rowText(r, statusOf.get(r.task)));
    const room = MAX_LINES - head.length - tail.length - body.length;
    if (rows.length <= room) body.push(...rows);
    else body.push(...rows.slice(0, room - 1), `  … ${rows.length - (room - 1)} more: \`${names.bin} task list\``);
  }
  const history = medians(t.all);
  const summary = (x) => {
    const med = history.get(x.class);
    return {
      id: x.id, kind: x.kind, title: x.title, status: x.status, class: x.class, owner: x.owner, lane: x.lane, round: x.round,
      startedAt: startOf(x), lastEventAt: x.events?.at(-1)?.at ?? null,
      expectedMs: med ?? EXPECTED_MS[x.class] ?? NO_CLASS_MS, expectedFrom: med === undefined ? 'default' : 'history',
    };
  };
  return {
    data: {
      repo: where.repo,
      state: { status: state.status, dir: where.dir, linked: where.linked },
      tier: tier.tier,
      tasks: t.open.map(summary),
      steps: t.rows,
      outsideMerges: t.outside,
      loop: t.loop,
      leases,
      watch,
      findings,
    },
    text: `${[...head, ...body, ...tail].join('\n')}\n`,
  };
}
