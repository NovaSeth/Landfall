// `trust` (T-MG-77 slice B): shows the gate commands and threshold overrides of this repository that this machine does
// not trust yet, and records them after a y answer at a terminal. Gates run (verify, baseline pin, task merge) and
// overrides count (route) only once trusted (lib/state trust.mjs). Without a terminal, or with --yes, it is refused:
// an agent cannot consent for the user. --json lists the state and writes nothing (no adoption either).
import { PROFILE_KINDS } from '../profile/index.mjs';
import * as state from '../state/index.mjs';
import { EXIT } from './commands.mjs';
import { ask } from './output.mjs';

const QUESTION = 'Trust these for this repository on this machine? [y/N] ';

export async function trust({ names, io, json, yes = false }) {
  const where = state.resolve({ cwd: io.cwd, env: io.env, names });
  if (!where.active) return { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${where.repo} is not active: it has no gates or overrides to trust`, hint: `'${names.bin} init' activates it` }] };
  const store = state.open(where.dir, { names, kinds: { ...state.KINDS, ...PROFILE_KINDS } });
  const gates = store.read('profile', null)?.gates ?? [];
  const thresholds = store.read('config', null)?.thresholds ?? {};
  const hint = state.TRUST_HINT.replaceAll('{bin}', names.bin);
  const check = (kind, sha) => (sha ? state.isTrusted({ dir: where.dir, dataDir: where.dataDir, names, env: io.env, kind, sha, adopt: !json }).trusted : true);
  const gatesSha = gates.length ? state.gatesShaOf(gates) : null;
  const overridesSha = Object.keys(thresholds).length ? state.overridesShaOf(thresholds) : null;
  const untrusted = {
    gates: check('gates', gatesSha) ? [] : gates.map((g) => ({ name: g.name, cmd: g.cmd })),
    overrides: check('overrides', overridesSha) ? [] : Object.entries(thresholds).map(([key, o]) => ({ key, value: o.value, decision: o.decision })),
  };
  const data = { repo: where.repo, key: state.repoKey(where.dir, { env: io.env }), gatesSha, overridesSha, untrusted, recorded: false };
  const lines = [`repository: ${where.repo}`];
  if (untrusted.gates.length) lines.push('gate commands (not trusted on this machine):', ...untrusted.gates.map((g) => `  ${g.name}: ${g.cmd}`));
  if (untrusted.overrides.length) lines.push('threshold overrides (not trusted on this machine):', ...untrusted.overrides.map((o) => `  ${o.key} = ${o.value} · ${o.decision}`));
  const none = untrusted.gates.length === 0 && untrusted.overrides.length === 0;
  if (none) lines.push('nothing to trust: this machine trusts the gate commands and threshold overrides of this repository');
  const text = `${lines.join('\n')}\n`;
  if (json || none) return { data, text };
  if (yes || !io.stdinIsTTY) {
    return { code: EXIT.REFUSED, data, text, errors: [{ code: 'trust-needs-terminal', message: 'trusting gate commands and threshold overrides needs your answer at a terminal; --yes does not count', hint }] };
  }
  const answer = await ask(io, `${text}${QUESTION}`);
  if (!/^\s*y(?:es)?\s*$/i.test(answer)) return { code: EXIT.REFUSED, data, errors: [{ code: 'not-trusted', message: 'nothing was trusted', hint }] };
  state.recordTrust({ dataDir: where.dataDir, names, key: data.key, gates: untrusted.gates.length ? gatesSha : null, overrides: untrusted.overrides.length ? overridesSha : null });
  return { data: { ...data, recorded: true }, text: 'trusted for this repository on this machine\n' };
}
