// `<bin> tier [--explain]` (spec §7.4, §8.2): evaluates the tier now and records a change by the engine mode (see
// index.mjs); prints the tier, the change or the wait, the signals and the capability set. --explain adds one line
// per signal (value, thresholds, dwell) and the change cadence; with --json they are data.explain.
// Exit 1 a state file is invalid · 7 the engine flag is off, newer schema, no consent · 8 not a git repository.
import { relative } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { ProfileError } from '../profile/index.mjs';
import { StateError, resolve } from '../state/index.mjs';
import { ENGINE_FLAGS, SHADOW_LOG, THRESHOLDS, engineThresholds, evaluate, signalLine } from './index.mjs';

const MODE_TEXT = {
  shadow: 'engine shadow: computed and logged, not enforced',
  on: 'engine on: changes are decision records and set the capability flags',
};

// One line per signal and the change cadence.
export function explainLines(r, thresholds = THRESHOLDS) {
  const out = [];
  for (const [name, rule] of Object.entries(thresholds.tierSignals)) {
    const d = r.detail[name];
    const ups = rule.levels.map((l) => `${d.value >= l.up ? '' : 'not '}≥ ${l.up} → ${l.tier}`).join(', ');
    const downs = rule.levels.map((l) => `${l.tier} < ${l.down}`).join(', ');
    const kept = d.holds ? `; keeps ${d.holds} (not under its down threshold all ${rule.dwellDays} days)` : '';
    const counted = rule.windowDays ? ` (authors with commits on ≥ ${rule.distinctDays} days of the last ${rule.windowDays})` : '';
    out.push(`${name} ${d.value}: ${ups}${kept}; a level falls after ${rule.dwellDays} days under ${downs}${counted}`);
  }
  const t = thresholds.toggles;
  const now = (on) => (on ? 'on' : 'off');
  out.push(`parallelTasks ${r.signals.parallelTasks}: ≥ ${t.parallelTasks.up} turns the L0 scheduler on, off after ${t.parallelTasks.dwellDays} days under ${t.parallelTasks.down} (now ${now(r.toggles.parallelTasks)})`);
  out.push(`incidents30 ${r.signals.incidents30}: ≥ ${t.incidents30.up} in ${t.incidents30.windowDays} days turns the runbooks and release packs on, off after ${t.incidents30.dwellDays} days under ${t.incidents30.down} (now ${now(r.toggles.incidents30)})`);
  for (const [fact, tier] of Object.entries(thresholds.floors)) out.push(`${fact} ${r.signals[fact] ?? 'unknown'}: true sets the ${tier} floor`);
  const last = r.since ? `last change ${r.since}` : 'no change recorded yet';
  out.push(`One change per ${thresholds.changeEveryDays} days: ${last}${r.waiting ? `; ${r.waiting.to} waits until ${r.waiting.until}` : ''}`);
  return out;
}

function render(r, explain, { names, where, thresholds }) {
  const lines = [`Tier ${r.tier} ${r.name} (${MODE_TEXT[r.mode]})`];
  const log = `${relative(where.worktree, where.dir).split('\\').join('/') || '.'}/${SHADOW_LOG}`;
  if (r.change) {
    const how = !r.active ? 'not recorded: the repository is not active' : r.written === 'shadow' ? `proposed in ${log}` : `recorded as ${r.decision}`;
    lines.push(`Change: ${r.change.from} → ${r.change.to}, ${how}`);
  } else if (r.waiting) lines.push(`Waiting: ${r.waiting.to} after ${r.waiting.until} (one change per ${thresholds.changeEveryDays} days)`);
  else lines.push(`No change${r.since ? ` since ${r.since}` : ''}`);
  if (r.reasons.length) lines.push(`Reasons: ${r.reasons.join('; ')}`);
  lines.push(`Signals: ${signalLine(r.signals)}`);
  const c = r.capabilities;
  lines.push(`Review: standard ${c.review.standard}, critical ${c.review.critical} · spec/plan for critical: ${c.specPlan.critical} · scheduler ${c.scheduler}`);
  lines.push(`Flags: ${ENGINE_FLAGS.map((f) => `${f} ${c.flags[f]}`).join(' · ')}`);
  lines.push(`Method packs: ${c.packs.length ? c.packs.join(', ') : '(none)'}`);
  lines.push(`Outcome gates (every tier and task class): ${c.gates.join(', ')}`);
  if (explain) lines.push('Why:', ...explain.map((l) => `  ${l}`));
  if (!r.active) lines.push(`Not active: nothing recorded (start with /${names.plugin}:start).`);
  return `${lines.join('\n')}\n`;
}

export function tier(ctx) {
  try {
    const where = resolve({ cwd: ctx.io.cwd, env: ctx.io.env, names: ctx.names });
    const thresholds = engineThresholds(where, { names: ctx.names, env: ctx.io.env });
    const r = evaluate(where, { names: ctx.names, env: ctx.io.env, thresholds });
    const explain = ctx.flags.explain ? explainLines(r, thresholds) : null;
    const { detail, ...data } = r;
    return { data: explain ? { ...data, explain } : data, text: render(r, explain, { names: ctx.names, where, thresholds }) };
  } catch (err) {
    if (err instanceof StateError || err instanceof ProfileError) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
}
