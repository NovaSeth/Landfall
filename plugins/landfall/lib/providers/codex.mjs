// Codex adapter (spec §7.12, U8; Codex CLI 0.160.0): `codex exec -s <sandbox> -C <cwd> --json -o <out>
// [--output-schema <schema>] [-m <model>] -` with the brief on stdin; auth from `codex login status`. The sandbox per
// role is read-only (reviewer) or workspace-write (implementer); nothing else widens it.
// --json prints one event per line (tests/fixtures/providers/codex-review.jsonl is a recorded run): thread.started,
// turn.started, item.started | item.updated | item.completed { item: { type: agent_message (text) | command_execution
// (command) | reasoning | … } }, turn.completed { usage: { input_tokens (cached included), cached_input_tokens,
// output_tokens } }, turn.failed { error: { message } }, error { message }. Any other line is an unknown event.
import { LAST_LINE } from './kind.mjs';
import { cleanLine, lastLineOf, probe, versionOf, which } from './probe.mjs';

export const id = 'codex';
export const bins = Object.freeze(['codex']);
export const sandboxes = Object.freeze({ reviewer: 'read-only', implementer: 'workspace-write' });
// The parent's variables the provider gets besides the base and lease ones (exec childEnv, B-6); NAME_* is a prefix.
export const envNames = Object.freeze(['OPENAI_*', 'CODEX_*', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);

export const detect = ({ env }) => versionOf('codex', env);

export function auth({ env }) {
  const path = which('codex', env);
  if (!path) return 'missing';
  const r = probe(path, ['login', 'status'], { env });
  if (r.error === 'timeout' || r.error === 'failed') return 'unknown';
  return r.status === 0 && /logged in/i.test(`${r.stdout}\n${r.stderr}`) ? 'ok' : 'missing';
}

export function argv({ sandbox, cwd, outFile, schemaFile, model }) {
  return ['codex', 'exec', '-s', sandbox, '-C', cwd, '--json', '-o', outFile, ...(schemaFile ? ['--output-schema', schemaFile] : []), ...(model ? ['-m', model] : []), '-'];
}

const KNOWN = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function parse(line) {
  let e;
  try { e = JSON.parse(line); } catch { return { event: 'unknown' }; }
  const type = e && typeof e === 'object' ? e.type : undefined;
  if (!KNOWN.has(type)) return { event: 'unknown' };
  const out = { event: type };
  if (type === 'turn.completed' && e.usage && typeof e.usage === 'object') {
    const cached = count(e.usage.cached_input_tokens);
    out.tokens = { input: Math.max(0, count(e.usage.input_tokens) - cached), output: count(e.usage.output_tokens), cached };
  }
  const item = e.item && typeof e.item === 'object' ? e.item : null;
  if (item?.type === 'agent_message') out.lastLine = lastLineOf(item.text, LAST_LINE) ?? undefined;
  if (item?.type === 'command_execution' && type === 'item.started') out.lastLine = cleanLine(`$ ${item.command ?? ''}`, LAST_LINE) ?? undefined;
  if (type === 'error' || type === 'turn.failed') {
    const message = type === 'error' ? e.message : e.error?.message;
    out.error = cleanLine(message ?? type, 300);
    out.lastLine = cleanLine(message ?? type, LAST_LINE);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}
