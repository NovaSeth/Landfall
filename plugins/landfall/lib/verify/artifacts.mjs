// Required artifacts (spec §5.1, §7.6 step 5, SD-15 (3), SD-47):
//   report  tasks/<id>/report.md opens with a frontmatter block (between --- lines) holding `red` and `green`, each a
//           JSON object { command, exit, excerpt }: command non-empty, exit an integer (red: not 0, green: 0),
//           excerpt text of at most 2 KB. The body is prose and decides nothing.
//   review  needed as the tier table lib/router/review-need.json says (spec §7.4): class × applied tier → none | any |
//           external (external-if-provider: external when a reviewer provider is detected and authenticated, else
//           any). The class is the one whose route has the given steps. The applied tier is the latest active tier
//           decision while the engine flag is on; in shadow mode or without a tier decision it is L0. When needed,
//           the latest round (highest k of review-r<k>.json) has verdict approved, and for external an external
//           reviewer. → approved | missing | not-required
//           It is also approved by review close (reviewClosed): an active review-close decision for the task, once the
//           latest round has reached the loop's rounds cap (default 2), listing in `remaining` every blocking finding ID of
//           that round. It closes only the review step: the report evidence and the gates are checked as before.
// The report is read as a plain file (never through a link) of at most 256 KB; the review through lib/state.
// No provider detection exists yet (lib/providers): providerAvailable defaults to false.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecords } from '../decisions/records.mjs';
import { StateError } from '../state/index.mjs';
import { CAP_RANGE, DEFAULT_CAPS, LOOP } from '../loop/kind.mjs';
import { ENGINE_FLAG, lastRecordedChange } from '../engine/index.mjs';
import { detectProviders } from '../providers/registry.mjs';

const REVIEW_NEED = JSON.parse(readFileSync(new URL('../router/review-need.json', import.meta.url), 'utf8'));

const REPORT_MAX = 256 * 1024;
const EXCERPT_MAX = 2048;

export function readReport(dir, id) {
  const file = join(dir, 'tasks', id, 'report.md');
  try {
    const st = lstatSync(file);
    return st.isFile() && st.size <= REPORT_MAX ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function evidence(raw, exitOk) {
  let v;
  try { v = JSON.parse(raw ?? ''); } catch { return false; }
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && typeof v.command === 'string' && v.command.trim() !== ''
    && Number.isInteger(v.exit) && exitOk(v.exit)
    && typeof v.excerpt === 'string' && Buffer.byteLength(v.excerpt) <= EXCERPT_MAX;
}

export function reportHasEvidence(text) {
  if (typeof text !== 'string') return false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return false;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (m && !Object.hasOwn(fields, m[1])) fields[m[1]] = m[2].trim();
  }
  return evidence(fields.red, (e) => e !== 0) && evidence(fields.green, (e) => e === 0);
}

// The review a task needs: 'none', 'any' (a review) or 'external' (a cross-provider review).
export function reviewNeed(cls, tier, providerAvailable = false) {
  const need = REVIEW_NEED[cls]?.[tier] ?? 'none';
  return need === 'external-if-provider' ? (providerAvailable ? 'external' : 'any') : need;
}

// The tier the engine applies: the latest active tier decision when the engine flag is on, else L0.
export const appliedTier = (store) => ((store.read('config', null)?.flags?.[ENGINE_FLAG] ?? 'shadow') === 'on' ? lastRecordedChange(store.dir).tier : 'L0');

// The review line `route` and `brief` print: { need, text } for a class, the applied tier of `store` and, only where it
// decides the need (critical at L1), whether a reviewer provider is detected and authenticated (no probe cache written).
// The need shown by route and brief. An unreadable config.json (the tier's flag) is reported as unknown rather than
// failing the command: route still classifies from the shipped defaults; verify itself refuses on that state.
export function reviewShown(store, cls, { names, env }) {
  let tier;
  try { tier = appliedTier(store); } catch (err) {
    if (!(err instanceof StateError)) throw err;
    return { need: null, text: `unknown (${err.message})` };
  }
  const [low, high] = [reviewNeed(cls, tier, false), reviewNeed(cls, tier, true)];
  const available = low !== high && detectProviders({ names, env, write: false }).rows.some((r) => r.found && r.auth === 'ok' && r.roles.includes('reviewer'));
  const need = available ? high : low;
  const text = need === 'none' ? 'none' : need === 'external' ? 'cross-provider' : low !== high ? 'cross-provider (if a provider is available)' : 'any reviewer';
  return { need, text };
}

const classOf = (steps) => (steps.includes('cross-provider-review') ? 'critical' : steps.includes('review') ? 'standard' : 'trivial');

export function reviewState(store, id, steps, { tier = appliedTier(store), providerAvailable = false } = {}) {
  const need = reviewNeed(classOf(steps), tier, providerAvailable);
  const round = (key) => Number(key.slice(key.lastIndexOf('-r') + 2));
  const keys = store.list('review').filter((k) => k.startsWith(`${id}/`)).sort((a, b) => round(a) - round(b));
  // Nothing is required: a recorded approved latest round is still reported, never "missing".
  if (need === 'none') return keys.length && store.read('review', keys[keys.length - 1]).verdict === 'approved' ? 'approved' : 'not-required';
  if (!keys.length) return 'missing';
  const latest = store.read('review', keys[keys.length - 1]);
  if (latest.verdict === 'approved' && (need === 'any' || latest.reviewer.kind === 'external')) return 'approved';
  return reviewClosed(store, id, round(keys[keys.length - 1]), latest) ? 'approved' : 'missing';
}

// The loop's rounds cap (local/loop.json, read through the store), else the default.
function roundsCap(store) {
  let rounds;
  try { rounds = JSON.parse(store.readText(LOOP.path()) ?? 'null')?.caps?.rounds; } catch { rounds = undefined; }
  const [min, max] = CAP_RANGE.rounds;
  return Number.isInteger(rounds) && rounds >= min && rounds <= max ? rounds : DEFAULT_CAPS.rounds;
}

// Review close: round `k` (the latest, document `latest`) is at or past the rounds cap and an active review-close
// decision for task `id` lists every blocking finding ID of that round.
export function reviewClosed(store, id, k, latest) {
  if (!(k >= roundsCap(store))) return false;
  const blocking = (latest.findings ?? []).filter((f) => f.severity === 'blocking').map((f) => f.id);
  return readRecords(store.dir).records.some(({ doc }) => doc.status === 'active' && doc.kind === 'review-close' && doc.task === id
    && blocking.every((f) => (doc.remaining ?? []).includes(f)));
}
