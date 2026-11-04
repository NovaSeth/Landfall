// Seven KPIs from task events and Claude Code transcripts. No receipts, snapshots or writes.
// Task cohort and timing fallbacks match the measurement scripts: any event in the period; last merged,
// else last done; first started; last review/implementer, else started. Backlog is the current open state.
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectDirs, slug } from '../receipts/sessions.mjs';
import { parseTranscript } from '../receipts/transcript.mjs';
import { open, resolve, StateError } from '../state/index.mjs';

const median = (xs) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b), m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const time = (s) => Date.parse(s);
const last = (events, kinds) => events.filter((e) => kinds.includes(e.event)).at(-1);
const row = (id, label, unit, value, reason, extra = {}) => ({ id, label, value: reason ? null : value, unit, reason: reason || null, ...extra });
const isFile = (p) => lstatSync(p, { throwIfNoEntry: false })?.isFile();

function periodOf(flags) {
  if (flags.day !== undefined && flags.since !== undefined) throw new StateError('conflicting-flags', 'USAGE', '--day and --since exclude each other');
  const key = flags.since !== undefined ? 'since' : 'day';
  const date = flags[key] ?? new Date().toISOString().slice(0, 10);
  const start = time(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) {
    throw new StateError('invalid-date', 'USAGE', `--${key} needs a real date YYYY-MM-DD`);
  }
  const end = key === 'day' ? start + 86400000 : Infinity;
  return { period: { [key]: date }, includes: (at) => time(at) >= start && time(at) < end };
}

// Main-checkout sessions are the orchestrator; worktree sessions and subagents contribute cache reads only.
// Reuse discovery (including real paths and CLAUDE_CONFIG_DIR) and streaming parsing from receipts. Repeated
// requests in resumed files are counted once, with the greatest token counts observed across their copies.
function transcripts(where, env, bin, includes) {
  const requests = new Map();
  let problem = null;
  const read = (file, orchestrator) => {
    try {
      const parsed = parseTranscript(file, { bin });
      if (parsed.malformed) problem = 'Transcript lines are malformed or exceed the parser limit';
      for (const r of parsed.requests) {
        if (!r.at) { problem = 'Transcript request timestamps are missing'; continue; }
        if (!includes(r.at)) continue;
        const prev = requests.get(r.key);
        if (!prev) requests.set(r.key, { ...r, orchestrator });
        else {
          prev.orchestrator ||= orchestrator;
          for (const k of Object.keys(r.tokens)) prev.tokens[k] = Math.max(prev.tokens[k], r.tokens[k]);
        }
      }
    } catch { problem = 'A repository transcript could not be read'; }
  };
  try {
    for (const dir of projectDirs({ repo: where.repo, env })) {
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.jsonl') || !isFile(join(dir, name))) continue;
        read(join(dir, name), basename(dir) === slug(where.repo));
        const sub = join(dir, name.slice(0, -6), 'subagents');
        if (!lstatSync(sub, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const agent of readdirSync(sub).sort()) {
          if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(agent) && isFile(join(sub, agent))) read(join(sub, agent), false);
        }
      }
    }
  } catch { problem = 'Repository transcript directories could not be read'; }
  const all = [...requests.values()], main = all.filter((r) => r.orchestrator);
  const context = main.map(({ tokens: t }) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h);
  return { calls: main.length, context: median(context), cache: all.reduce((n, r) => n + r.tokens.cacheRead, 0),
    mainReason: problem ?? (main.length ? null : 'No orchestrator transcript requests in the period'),
    cacheReason: problem ?? (all.length ? null : 'No transcript requests in the period') };
}

export function metrics({ flags, names, io }) {
  const { period, includes } = periodOf(flags);
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  const store = where.active ? open(where.dir, { names }) : null;
  const tasks = store ? store.list('task').map((id) => store.read('task', id)) : [];
  const touched = tasks.filter((t) => t.events.some((e) => includes(e.at)));
  const closed = [], starts = [], reviews = [];
  for (const task of touched) {
    const events = [...task.events].sort((a, b) => time(a.at) - time(b.at));
    const end = last(events, ['merged']) ?? last(events, ['done']);
    if (!end) continue;
    closed.push(task);
    const start = events.find((e) => e.event === 'started');
    if (!start) continue;
    const review = last(events, ['review', 'implementer']) ?? start;
    const lead = (time(end.at) - time(start.at)) / 60000;
    const handoff = (time(end.at) - time(review.at)) / 60000;
    if (lead >= 0) starts.push(lead);
    if (handoff >= 0) reviews.push(handoff);
  }
  const t = transcripts(where, io.env, names.bin, includes);
  const inactive = where.active ? null : 'Repository has no active task state';
  const denominator = inactive ?? (closed.length ? null : 'No closed tasks in the period');
  const rows = [
    row('orchestratorCallsPerClosedTask', 'Orchestrator calls per closed task', 'calls/task', t.calls / closed.length, t.mainReason ?? denominator),
    row('medianOrchestratorContext', 'Median context per orchestrator call', 'tokens', t.context, t.mainReason),
    row('cacheReadsPerClosedTask', 'Cache reads per closed task', 'tokens/task', t.cache / closed.length, t.cacheReason ?? denominator),
    row('tasksOverTwoFixRounds', 'Tasks with more than 2 fix rounds', 'tasks', touched.filter((x) => x.events.filter((e) => e.event === 'fix-round').length > 2).length,
      inactive ?? (touched.length ? null : 'No tasks touched in the period'), { total: touched.length }),
    row('medianStartToMerge', 'Median start → merge', 'minutes', median(starts), inactive ?? (starts.length ? null : 'No closed tasks with start and end events')),
    row('medianLastReviewToMerge', 'Median last review → merge', 'minutes', median(reviews), inactive ?? (reviews.length ? null : 'No closed tasks with start and end events')),
    row('openBacklog', 'Open backlog', 'tasks', tasks.filter((x) => !['done', 'cancelled'].includes(x.status)).length, inactive),
  ];
  const format = (r) => {
    if (r.reason) return `n/a (${r.reason})`;
    const n = String(Number(r.value.toFixed(2)));
    if (r.total !== undefined) return `${n} of ${r.total}`;
    return `${n}${r.unit === 'minutes' ? ' min' : ''}`;
  };
  return { data: { period, rows }, text: `| KPI | Value |\n| --- | --- |\n${rows.map((r) => `| ${r.label} | ${format(r)} |`).join('\n')}\n` };
}
