// `<bin> profile show|observe|set` (spec §7.3, §8.2): the command implementations behind the command table rows.
// show: the profile and whether a scan is due (read-only) · observe: the observation scan, merged into the
// profile in an active repository (read-only preview otherwise) · set: one said or observed fact.
// Exit 1 a said fact outranks the observed value, or a state file is invalid · 2 bad key, value, source or
// evidence · 7 inactive repository (set), newer schema, no consent · 8 not a git repository, git missing.
import { StateError, resolve } from '../state/index.mjs';
import { EXIT } from '../cli/commands.mjs';
import { FACT_KEYS, ProfileError } from './keys.mjs';
import { readProfile, runObserve, setFact } from './index.mjs';

const fail = (err) => {
  if (err instanceof StateError || err instanceof ProfileError) return { code: EXIT[err.exit], errors: [err] };
  throw err;
};
const where = ({ io, names }) => resolve({ cwd: io.cwd, env: io.env, names });
const shown = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v));
const quote = (s, max = 60) => {
  const chars = [...s];
  return `"${chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s}"`;
};

function factLines(facts) {
  const keys = Object.keys(FACT_KEYS).filter((k) => facts[k]);
  const width = Math.max(0, ...keys.map((k) => k.length)) + 2;
  return keys.map((k) => {
    const f = facts[k];
    const from = f.source === 'said' ? `said: ${quote(f.evidence)}` : `${f.source}: ${f.evidence}`;
    return `  ${k.padEnd(width)}${shown(f.value).padEnd(24)}  ${from} · ${f.at.slice(0, 10)}`;
  });
}

export function show(ctx) {
  try {
    const w = where(ctx);
    const r = readProfile(w, { names: ctx.names, env: ctx.io.env });
    if (!r.active) return { data: { active: false, repo: w.repo, profile: null, scan: null }, text: `${w.repo} is not active: no profile yet (start with /${ctx.names.plugin}:start).\n` };
    const p = r.profile;
    const lines = [`Profile of ${w.repo}`, ...(Object.keys(p.facts).length ? factLines(p.facts) : ['  (no facts yet)'])];
    lines.push(`Gates: ${p.gates.length ? p.gates.map((g) => `${g.name}: ${g.cmd}`).join(' · ') : '(none)'}`);
    lines.push(`Risk paths: ${p.riskPaths.length ? p.riskPaths.join(', ') : '(none)'}`);
    const last = p.lastScan ? `last scan ${p.lastScan.at} at ${p.lastScan.head ? p.lastScan.head.slice(0, 12) : 'no commit'}` : 'never scanned';
    lines.push(`Scan: ${last}; ${r.scan.due ? `due (${r.scan.reason}): run ${ctx.names.bin} profile observe` : 'not due'}`);
    return { data: { active: true, repo: w.repo, profile: p, scan: r.scan }, text: `${lines.join('\n')}\n` };
  } catch (err) {
    return fail(err);
  }
}

export function observe(ctx) {
  try {
    const w = where(ctx);
    const r = runObserve(w, { names: ctx.names, env: ctx.io.env });
    const o = r.observation;
    const lines = [`Observed ${o.files} files${r.cached ? ' (cached for this HEAD)' : ''} in ${w.worktree}`, ...Object.entries(o.facts).map(([k, f]) => `  ${k}: ${shown(f.value)} (${f.evidence})`)];
    lines.push(`  gate candidates: ${o.gates.length ? o.gates.map((g) => g.cmd).join(' · ') : '(none)'}`);
    if (!r.active) lines.push(`Not active: nothing written (start with /${ctx.names.plugin}:start).`);
    else {
      lines.push(`Profile updated: ${r.changed.length ? r.changed.join(', ') : 'no change'}${r.removed.length ? `; no longer observed: ${r.removed.join(', ')}` : ''}.`);
      if (r.gates.differ && !r.gates.applied) lines.push('Gate candidates differ from the profile gates; changing gates is a decision (kind gate-change).');
      for (const c of r.conflicts) lines.push(`Said ${c.key} = ${shown(c.said)}, observed ${shown(c.observed)} (${c.evidence})${c.askable ? ': ask the user once' : ''}.`);
    }
    return { data: { ...r, repo: w.repo, files: o.files }, text: `${lines.join('\n')}\n` };
  } catch (err) {
    return fail(err);
  }
}

export function set(ctx) {
  try {
    const w = where(ctx);
    const { fact, previous } = setFact(w, { names: ctx.names, key: ctx.args.key, raw: ctx.args.value, source: ctx.flags.source, evidence: ctx.flags.evidence });
    return { data: { key: ctx.args.key, fact, previous }, text: `Recorded ${ctx.args.key} = ${shown(fact.value)} (${fact.source}: ${quote(fact.evidence)}).\n` };
  } catch (err) {
    return fail(err);
  }
}
