// Agent admission (spec §7.8 admission points, §14 capability `admission`): a PreToolUse `Agent` event for the
// implementer subagent of this plugin asks for an `agent` lease keyed by its tool_use_id. Every other agent type,
// an inactive repository, the capability off and malformed input pass. Mode from the `admission` capability flag
// (lib/config: machine override, config.json, default shadow): shadow allows and returns the would-deny record with
// the readings; on denies with "machine busy: <reasons>; run `<bin> slots` to see them". A scheduler error never blocks a spawn (allow + record).
// The caller (the admit-agent hook) emits the decision and logs the shadow record.
import { isAbsolute } from 'node:path';
import { modeOf as flagMode, readConfig } from '../config/index.mjs';
import { resolve } from '../state/index.mjs';
import { acquire } from './leases.mjs';
import { freePct, readings } from './machine.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function modeOf(cwd, names, env) {
  const where = resolve({ cwd, env, names });
  if (!where.active) return 'off';
  return flagMode('admission', readConfig(where, { names, env }));
}

// { action: 'pass' } · { action: 'allow', lease (null without a free slot), env, shadow: record | null } ·
// { action: 'deny', message, reasons }. opts: { names, env, mode (overrides the flag), readings, lockTimeoutMs }.
export function admitAgent(input, opts = {}) {
  const { names, env } = opts;
  const pass = { action: 'pass' };
  const tool = input && typeof input === 'object' ? input.tool_input : null;
  if (!tool || tool.subagent_type !== `${names.plugin}:implementer`) return pass;
  const { tool_use_id: key, session_id: sessionId, cwd } = input;
  if (!ID.test(String(key)) || !ID.test(String(sessionId)) || typeof cwd !== 'string' || !isAbsolute(cwd)) return pass;
  let mode;
  try {
    mode = opts.mode ?? modeOf(cwd, names, env);
  } catch {
    return pass;
  }
  if (mode === 'off') return pass;
  const now = opts.readings ?? readings();
  const seen = { load1: now.load1, freePct: freePct(now) };
  const record = (reasons) => ({ at: new Date().toISOString(), kind: 'agent', action: 'would-deny', key, reasons, readings: seen });
  const transcriptPath = typeof input.transcript_path === 'string' && isAbsolute(input.transcript_path) ? input.transcript_path : undefined;
  let r;
  try {
    r = acquire('agent', { names, env, cwd, mode, transcriptPath, owner: { sessionId, key }, readings: now, lockTimeoutMs: opts.lockTimeoutMs ?? 300 });
  } catch (err) {
    return { action: 'allow', lease: null, env: {}, shadow: record([{ code: 'error', message: String(err?.message ?? err).slice(0, 200) }]) };
  }
  if (r.ok) return { action: 'allow', lease: r.lease, env: r.env, shadow: r.shadow.length ? record(r.shadow) : null };
  if (mode === 'on') return { action: 'deny', reasons: r.reasons, message: `machine busy: ${r.reasons.map((x) => x.message).join(', ')}; run \`${names.bin} slots\` to see them` };
  return { action: 'allow', lease: null, env: {}, shadow: record(r.reasons) };
}
