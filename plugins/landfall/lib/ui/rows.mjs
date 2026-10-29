// `<bin> ui rows`: the body of the agent-panel rows, the command of the plugin's subagentStatusLine. It reads the
// statusline JSON on stdin ({ tasks[], columns }) and prints one {"id","content"} line per row named
// <provider>-<role>-<task> (the wrapper agent's name). The row's run is the first record of that task and role under
// the row's cwd queued after the row started (each wrapper starts one exec). Other rows get no line (Claude Code keeps
// its own); malformed input prints nothing and exits 0.
// Line: `<provider> · <role> · <task> · <elapsed> · [<n>k tok · ][$<cost> · ]<status> · <last line>`, cut to columns.
import { readRunRecords, runsStore } from '../runs/index.mjs';
import { resolve } from '../state/index.mjs';

const ROW_NAME = /^[a-z0-9]+-(reviewer|implementer)-(T-[A-Z]{2,4}-\d+)$/;
const MAX_INPUT = 1024 * 1024;
const DEADLINE_MS = 1000;
const pad = (n) => String(n).padStart(2, '0');

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function elapsed(rec, now) {
  if (rec.endedAt || rec.status === 'done' || rec.status === 'failed' || rec.status === 'timeout') return rec.elapsedMs;
  const from = Date.parse(rec.startedAt ?? rec.queuedAt);
  return Number.isFinite(from) ? now - from : 0;
}

function cut(text, columns) {
  const chars = [...text];
  return Number.isInteger(columns) && columns > 1 && chars.length > columns ? `${chars.slice(0, columns - 1).join('')}…` : text;
}

function content(rec, now, columns) {
  const tok = rec.tokens ? (rec.tokens.input + rec.tokens.output + rec.tokens.cached) / 1000 : null;
  const parts = [rec.provider, rec.role, rec.task, clock(elapsed(rec, now)),
    ...(tok === null ? [] : [`${tok.toFixed(1)}k tok`]),
    ...(rec.costMicroUsd === null || rec.costMicroUsd === undefined ? [] : [`$${(rec.costMicroUsd / 1e6).toFixed(2)}`]),
    rec.status, ...(rec.lastLine ? [rec.lastLine] : [])];
  return cut(parts.join(' · '), columns);
}

// input: the parsed statusline JSON; deps: { now, runsOf(cwd) → run records } (injected by the tests).
export function rowLines(input, { now, runsOf }) {
  if (!input || !Array.isArray(input.tasks)) return [];
  const cache = new Map();
  const runs = (cwd) => {
    if (!cache.has(cwd)) cache.set(cwd, runsOf(cwd));
    return cache.get(cwd);
  };
  const lines = [];
  for (const t of input.tasks) {
    const m = t && typeof t.name === 'string' && typeof t.id === 'string' && typeof t.cwd === 'string' ? ROW_NAME.exec(t.name) : null;
    if (!m || !Number.isFinite(t.startTime)) continue;
    const rec = runs(t.cwd).filter((r) => r.task === m[2] && r.role === m[1] && Date.parse(r.queuedAt) >= t.startTime)
      .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt))[0];
    if (rec) lines.push({ id: t.id, content: content(rec, now, input.columns) });
  }
  return lines;
}

async function readStdin(stdin) {
  if (!stdin) return '';
  const chunks = [];
  let size = 0;
  let timer;
  const read = (async () => {
    for await (const c of stdin) {
      size += c.length;
      if (size > MAX_INPUT) return null;
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  const late = new Promise((r) => { timer = setTimeout(() => r(null), DEADLINE_MS); });
  try { return await Promise.race([read, late]); } catch { return null; } finally { clearTimeout(timer); }
}

export async function rows({ names, io }) {
  const text = io.stdinIsTTY ? null : await readStdin(io.stdin);
  let input = null;
  try { input = JSON.parse(text); } catch { /* malformed: no rows */ }
  const runsOf = (cwd) => {
    try {
      const w = resolve({ cwd, env: io.env, names });
      return w.active ? readRunRecords(runsStore(w.dir, names)) : [];
    } catch { return []; }
  };
  const lines = rowLines(input, { now: Date.now(), runsOf });
  return { text: lines.map((l) => `${JSON.stringify(l)}\n`).join('') };
}
