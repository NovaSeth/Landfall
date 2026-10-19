// Gemini adapter (spec §7.12, U15): fixture-only until a user runs it (tests/fixtures/providers/gemini-stream.jsonl is
// synthetic). `gemini --output-format stream-json --approval-mode <mode> [-m <model>]` in the run's working directory,
// the brief on stdin. The mode per role: plan (read-only) for a reviewer, auto_edit (file edits in the workspace) for an
// implementer. There is no auth probe: auth is unknown, so automatic selection skips it and only an explicit
// --provider runs it. No output file: the final message is the run's last line.
// stream-json events: init, message { role, content, delta }, tool_use, tool_result, error { message }, result
// { status, stats: { input_tokens (cached included), output_tokens, cached } }.
import { LAST_LINE } from './kind.mjs';
import { cleanLine, lastLineOf, versionOf } from './probe.mjs';

export const id = 'gemini';
export const bins = Object.freeze(['gemini']);
export const sandboxes = Object.freeze({ reviewer: 'plan', implementer: 'auto_edit' });

export const detect = ({ env }) => versionOf('gemini', env);
export const auth = () => 'unknown';

export function argv({ sandbox, model }) {
  return ['gemini', '--output-format', 'stream-json', '--approval-mode', sandbox, ...(model ? ['-m', model] : [])];
}

const KNOWN = new Set(['init', 'message', 'tool_use', 'tool_result', 'error', 'result']);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function parse(line) {
  let e;
  try { e = JSON.parse(line); } catch { return { event: 'unknown' }; }
  const type = e && typeof e === 'object' ? e.type : undefined;
  if (!KNOWN.has(type)) return { event: 'unknown' };
  const out = { event: type };
  if (type === 'message' && e.role === 'assistant') out.lastLine = lastLineOf(e.content, LAST_LINE) ?? undefined;
  if (type === 'tool_use') out.lastLine = cleanLine(`$ ${e.parameters?.command ?? e.tool_name ?? ''}`, LAST_LINE) ?? undefined;
  if (type === 'error') { out.error = cleanLine(e.message ?? 'error', 300); out.lastLine = cleanLine(e.message ?? 'error', LAST_LINE); }
  if (type === 'result' && e.stats && typeof e.stats === 'object') {
    const cached = count(e.stats.cached);
    out.tokens = { input: Math.max(0, count(e.stats.input_tokens) - cached), output: count(e.stats.output_tokens), cached };
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}
