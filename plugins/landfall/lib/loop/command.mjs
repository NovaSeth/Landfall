// `tick [--plan <file>]` and `loop start [--caps k=v,…] | stop | status` (spec §7.7, §8.1, §8.2, SD-17, FLW-4, FLW-5).
// tick exits by its result: ACTION 0 (do the steps, tick again), WAIT 3 (schedule one wakeup after NEXT_TICK seconds with
// the fixed prompt, with --plan for a docs/plans/*.md plan), DONE 4, STALLED 5, BUDGET 6 (the loop ended: schedule
// nothing, cancel a pending wakeup, report). After a terminal exit the output never carries a reschedule step (U1).
// The text is a table "task | state | next step | rules" with informational sections, the rule lines of this tick's
// action steps (lib/method) and the NEXT_TICK line; --json carries the same as data. A cost that is a lower bound
// (spec §8.1 partial data): data.partial, the reasons as errors and "partial" in the TICK line; the exit stays the
// tick's. Errors from lib/state (inactive repository, newer schema, lock) reach the CLI unchanged. Printed only by
// lib/cli/output.mjs.
import { EXIT } from '../cli/commands.mjs';
import { getRule, openMethod } from '../method/index.mjs';
import { DATA_MARKER, dataLine } from '../text/data.mjs';
import { CARRIED_PLAN, UNMEASURED, fixedPrompt, parseCaps, showLoop, startLoop, stopLoop, tick as runTick } from './index.mjs';

const CODE = Object.freeze({ ACTION: EXIT.OK, WAIT: EXIT.WAIT, DONE: EXIT.DONE, STALLED: EXIT.STALLED, BUDGET: EXIT.BUDGET });
const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;
const cell = (s) => dataLine(s).replace(/\|/g, '/'); // one data line first (SEC-14): U+2028 and other separators too
const minutes = (loop, now) => Math.max(0, Math.floor((now - Date.parse(loop.startedAt)) / 60000));

// The loop document as data (every field the hooks and the user see).
const summary = (l) => (l === null ? null : {
  id: l.id, startedAt: l.startedAt, caps: l.caps, ticks: l.ticks, sameCount: l.sameCount, sameSince: l.sameSince,
  costMicroUsd: l.costMicroUsd, unmeasured: l.unmeasured, exit: l.exit, exitAt: l.exitAt, reason: l.reason,
});

function usage(l, now) {
  const unmeasured = l.unmeasured ? `; the cost not measurable for ${l.unmeasured} of ${UNMEASURED} ticks in a row` : '';
  return `tick ${l.ticks} of ${l.caps.ticks}, ${minutes(l, now)} of ${l.caps.wallMin} min, ${usd(l.costMicroUsd)} of ${usd(l.caps.costMicroUsd)} spent (estimate)${unmeasured}`;
}

function table(rows, head) {
  const lines = [head, '|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${cell(r.task)} | ${cell(r.state)} | ${cell(r.step ?? '—')} | ${r.rules?.length ? r.rules.join(', ') : '—'} |`);
  return lines.join('\n');
}

// The rule lines of the action steps; a method that cannot be read is a warning, never a failed tick.
function rulesOf(steps) {
  const ids = [...new Set(steps.filter((s) => s.kind === 'action').flatMap((s) => s.rules))];
  if (ids.length === 0) return { rules: [], warning: null };
  try {
    const m = openMethod();
    return { rules: ids.map((id) => getRule(m, id)).filter(Boolean).map((r) => ({ id: r.id, text: r.text })), warning: null };
  } catch (err) {
    return { rules: [], warning: `rule texts unavailable: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

// carried: the plan path the wakeup prompt and the next tick command carry (CARRIED_PLAN), or null.
function render(r, rules, names, now, carried) {
  const ended = r.result === 'DONE' || r.result === 'STALLED' || r.result === 'BUDGET';
  const actions = r.steps.filter((s) => s.kind === 'action').length;
  const partial = r.costPartial ? ' · the cost is partial: a lower bound' : '';
  const out = [`TICK ${new Date(now).toISOString().slice(0, 16)}Z — ${r.result}${!ended && actions ? ` (${actions})` : ''} · loop ${r.loop.id}: ${usage(r.loop, now)}${partial}`];
  if (ended) out.push(`The loop ended (${r.result}${r.repeated ? `, recorded ${r.loop.exitAt}` : ''}): ${r.reason}.`);
  if (r.steps.length || r.info.length) out.push(DATA_MARKER); // the rows carry titles and states from repository files
  const head = ended ? '| left open | state | next step | rules |' : '| task | state | next step | rules |';
  if (r.steps.length) out.push(table(r.steps, head));
  const sections = [['blocked', 'Blocked (informational):'], ['others', 'Others (informational):'], ['plan', 'Next in the plan (informational):']];
  for (const [kind, title] of sections) {
    const rows = r.info.filter((i) => i.kind === kind);
    if (rows.length) out.push('', title, table(rows, '| task | state | next step | rules |'));
  }
  if (rules.length) out.push('', "Rules for this tick's steps:", ...rules.map((x) => `${x.id}. ${x.text}`));
  if (ended) out.push(`NEXT_TICK: none — schedule no wakeup; cancel a pending one (ScheduleWakeup with stop: true) and report to the user.`);
  else if (r.result === 'WAIT') out.push(`NEXT_TICK: ${r.nextTickS}s — work is in progress; schedule one wakeup in ${r.nextTickS}s with the fixed prompt: ${fixedPrompt(names, carried)}`);
  else out.push(`NEXT_TICK: now — do the steps above, then run \`${names.bin} tick${carried ? ` --plan ${carried}` : ''}\` again.`);
  return `${out.join('\n')}\n`;
}

export function tick({ flags, names, io }) {
  const now = Date.now();
  const r = runTick({ cwd: io.cwd, env: io.env, names, now, plan: flags.plan ?? null });
  const ended = r.result === 'DONE' || r.result === 'STALLED' || r.result === 'BUDGET';
  const carried = r.plan !== null && CARRIED_PLAN.test(r.plan) ? r.plan : null;
  const { rules, warning } = ended ? { rules: [], warning: null } : rulesOf(r.steps);
  const warnings = [];
  if (warning) warnings.push(warning);
  if (!ended && r.plan !== null && carried === null) {
    warnings.push(`${r.plan} is not carried by the wakeup prompt: only a docs/plans/*.md path of letters, digits, '.', '_' and '-' is, so the next wakeup ticks without the plan; move the plan there`);
  }
  return {
    code: CODE[r.result],
    data: { result: r.result, repeated: r.repeated, reason: r.reason, nextTickS: r.nextTickS, steps: r.steps, info: r.info, rules, loop: summary(r.loop), partial: r.costPartial },
    errors: r.costProblems.slice(0, 5),
    text: render(r, rules, names, now, carried),
    warnings,
  };
}

// Two lines on the loop document (the status view prints them too).
export const describe = (l, now) => {
  if (l === null) return null;
  const state = l.exit ? `ended ${l.exit} at ${l.exitAt}: ${l.reason}` : `running since ${l.startedAt}; unchanged for ${l.sameCount} tick${l.sameCount === 1 ? '' : 's'}`;
  return `loop ${l.id}: ${state}\n${usage(l, now)}; fix rounds per task ${l.caps.rounds}\n`;
};

export function loopStart({ flags, names, io }) {
  const caps = flags.caps === undefined ? {} : parseCaps(flags.caps);
  const r = startLoop({ cwd: io.cwd, env: io.env, names, caps, byUser: io.stdinIsTTY === true });
  const was = r.replaced ? ` (replaces ${r.replaced.id}, ended ${r.replaced.exit})` : '';
  return { data: { loop: summary(r.loop), replaced: r.replaced ? summary(r.replaced) : null }, text: `started${was}\n${describe(r.loop, Date.now())}` };
}

export function loopStop({ names, io }) {
  const r = stopLoop({ cwd: io.cwd, env: io.env, names });
  const text = r.stopped ? `stopped\n${describe(r.loop, Date.now())}` : r.loop ? `nothing to stop\n${describe(r.loop, Date.now())}` : 'no loop in this repository\n';
  return { data: { loop: summary(r.loop), stopped: r.stopped }, text };
}

export function loopStatus({ names, io }) {
  const r = showLoop({ cwd: io.cwd, env: io.env, names });
  const text = r.loop ? describe(r.loop, Date.now()) : `no loop${r.where.active ? '' : ' (the repository is not active)'}; the first \`${names.bin} tick\` starts one with the default caps\n`;
  return { data: { loop: summary(r.loop) }, text };
}
