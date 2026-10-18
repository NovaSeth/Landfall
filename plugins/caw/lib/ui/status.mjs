// `<bin> status` (spec §8.2, §12; ui unit, §4.2): the read-only view of the repository at the working directory, and
// what `<bin>` prints with no command. Lines: the repository · its activation state (active with the state directory
// and whether it is linked, declined, not active) · the tier from the engine, evaluated without recording (`tier`
// records a change; an engine turned off is a line, not a refusal) · the open tasks with the next step of the loop's
// step table (lib/loop nextSteps: the same rows `tick` acts on) · the loop record when one exists · the scheduler
// leases taken for this repository (lease project = its path; a task ID alone could be another repository's). At
// most 25 lines: the task rows are cut first and counted. --json: data { repo, state, tier, tasks, steps, loop, leases } with every open task and step.
// Writes nothing. Exit 0 · 1 a state file is invalid · 7 a newer state schema · 8 not a git repository, git missing.
import { join } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { TIER_NAMES, evaluate } from '../engine/index.mjs';
import { describe } from '../loop/command.mjs';
import { DEFAULT_CAPS, LOOP, STORE_KINDS, nextSteps } from '../loop/index.mjs';
import { ProfileError } from '../profile/index.mjs';
import { readRuns } from '../receipts/index.mjs';
import { snapshot } from '../sched/index.mjs';
import { StateError, emailHash, gitIdentity, open, resolve } from '../state/index.mjs';

const MAX_LINES = 25;
const CLOSED = new Set(['done', 'cancelled']);
const LEASES_SHOWN = 3;

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
    if (err instanceof StateError && err.code === 'capability-off') return { tier: null, text: 'engine off (flags.engine in state.json)' };
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
  const table = nextSteps({
    tasks: all, runs: readRuns(join(where.local, 'runs')).runs, handles: team.map((d) => d.handle), me: team.find((d) => d.emailSha256 === hash)?.handle ?? null,
    plan: null, lanesOn: store.read('state', null)?.flags?.lanes === 'on', caps: doc?.caps ?? DEFAULT_CAPS, now: Date.now(), bin: names.bin, problem: null, dirty: () => [],
  });
  return { all, open: all.filter((t) => !CLOSED.has(t.status)), rows: [...table.steps, ...table.info], loop: doc };
}

const rowText = (r, status) => {
  const rules = r.rules?.length ? ` (${r.rules.join(', ')})` : '';
  return `  ${r.task}  ${status ?? r.kind}  ${r.state}${r.step ? ` → ${r.step}${rules}` : ''}`;
};
const leaseText = (l) => (l.owner
  ? `  ${l.kind}-${l.slot}  ${l.status}${l.orphan ? ' (orphan child running)' : ''}  ${l.task ?? '-'}  ports ${l.ports[0]}-${l.ports[1]}  db ${l.db}`
  : `  ${l.kind}-${l.slot}  ${l.status}`);

export function status({ names, io }) {
  try {
    return view({ names, env: io.env, cwd: io.cwd });
  } catch (err) {
    if (err instanceof ProfileError) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
}

function view({ names, env, cwd }) {
  const where = resolve({ cwd, env, names });
  const state = stateLine(where, names.bin);
  const tier = tierOf(where, names, env);
  const t = where.active ? tasksOf(where, names, env) : { all: [], open: [], rows: [], loop: null };
  const leases = where.dataDir ? snapshot({ names, env }).leases.filter((l) => l.project === where.repo) : [];

  const head = [where.repo, `State: ${state.text}`, `Tier: ${tier.text}`];
  const tail = [];
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
  const summary = (x) => ({ id: x.id, kind: x.kind, title: x.title, status: x.status, class: x.class, owner: x.owner, lane: x.lane, round: x.round });
  return {
    data: {
      repo: where.repo,
      state: { status: state.status, dir: where.dir, linked: where.linked },
      tier: tier.tier,
      tasks: t.open.map(summary),
      steps: t.rows,
      loop: t.loop,
      leases,
    },
    text: `${[...head, ...body, ...tail].join('\n')}\n`,
  };
}
