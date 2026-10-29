// Context-headroom hook (spec U14, capability `headroom`, default shadow): PostToolUse Bash|Edit|Write|Agent reads at most
// the last 64 KiB of the session transcript, takes the latest assistant usage (input + cache read + cache creation
// tokens) and warns once per session at 35 % remaining and once more at 25 %. Shadow logs {kind: 'headroom', session,
// remaining, threshold} to local/shadow.jsonl and injects nothing; on also injects additionalContext. Dedupe is read from
// the same log, under the store lock. Anything unreadable: allow, no output (GC8).
// The transcript is read here, not through lib/fsx (hooks may not import it, tests/architecture.test.mjs): a regular file
// opened without following a link (O_NOFOLLOW) or blocking, judged by fstat of the descriptor.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { modeOf, readConfig } from '../config/index.mjs';
import { open } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const NONE = { stdout: '' };
const TAIL_BYTES = 64 * 1024;
const LOCK_MS = 300;
const THRESHOLDS = Object.freeze([25, 35]); // percent remaining, lowest first

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

// The last TAIL_BYTES of a regular file as text, or null. A cut first line is dropped.
function tailText(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to do */ }
  }
}

// { total, model } of the latest assistant usage in the last 64 KiB of the transcript, or null. Malformed lines are skipped.
export function headroomUsage(path) {
  const text = tailText(path);
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o?.message;
    if (o?.type !== 'assistant' || !isObj(m) || !isObj(m.usage)) continue;
    const u = m.usage;
    const total = count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
    if (total > 0) return { total, model: typeof m.model === 'string' ? m.model : '' };
  }
  return null;
}

// The context window (D-MG-22): <envPrefix>CONTEXT_WINDOW (a positive integer) overrides; a model id with [1m] is
// 1,000,000; an observed total above 200,000 is 1,000,000 (a 1M model whose id lacks the marker); otherwise 200,000.
export function windowOf({ model, total }, env = process.env) {
  const set = env[`${loadNames().envPrefix}CONTEXT_WINDOW`];
  if (typeof set === 'string' && /^[1-9][0-9]{0,11}$/.test(set)) return Number(set);
  if (model.includes('[1m]') || total > 200000) return 1000000;
  return 200000;
}

const warning = (pct) => `Context is about ${pct}% free. Run /compact or start a fresh session before the next large step.`;

export function headroomHook(input, { env = process.env, deadline = Infinity } = {}) {
  const session = input.session_id;
  const cwd = [input.cwd, env.CLAUDE_PROJECT_DIR].find((d) => typeof d === 'string' && isAbsolute(d));
  if (typeof session !== 'string' || !session || typeof input.transcript_path !== 'string' || !isAbsolute(input.transcript_path) || !cwd) return NONE;
  const usage = headroomUsage(input.transcript_path);
  if (!usage) return NONE;
  const win = windowOf(usage, env);
  const left = win - usage.total;
  const threshold = THRESHOLDS.find((p) => left * 100 <= p * win);
  if (threshold === undefined) return NONE;
  const names = loadNames();
  const where = stateOf(cwd, env, deadline).where;
  if (!where?.active) return NONE;
  const remaining = Math.max(0, Math.round((left / win) * 1000) / 10);
  // Dedupe per session and threshold: 35 is spent once any record of the session at 35 or 25 exists; 25 once at 25.
  const entry = open(where.dir, { names, lockTimeoutMs: LOCK_MS }).append('shadow', (log) => {
    const seen = log.split('\n').filter((l) => l.startsWith('{')).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter((r) => r?.kind === 'headroom' && r.session === session).map((r) => r.threshold);
    return seen.some((t) => t <= threshold) ? undefined : { kind: 'headroom', session, remaining, threshold };
  });
  if (!entry || modeOf('headroom', readConfig(where, { names, env })) !== 'on') return NONE;
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: warning(Math.round(remaining)) } })}\n` };
}
