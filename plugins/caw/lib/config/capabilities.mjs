// Rollout capabilities (spec §14, SD-38): each with its default at 2.0.0, the modes it has (one without a shadow behavior
// has no shadow mode) and what it does in each, for `flags show` and the help. `off` is the rollback: the capability's
// commands are refused naming the flag (lib/cli/main.mjs, a row's `capability`) and its hooks pass through
// (lib/hooks/registry.mjs, a hook's `capability`). A machine override (plugin data config.json) wins over the
// repository's config.json for these. The flags the engine sets by tier (lanes, the generated files) are team flags: no
// default here (unset = what the tier offers) and no machine override.
export const MODES = Object.freeze(['off', 'shadow', 'on']);

export const ROLLOUT = Object.freeze([
  { name: 'guard-bash', default: 'on', modes: ['off', 'on'], on: 'the Bash guard blocks guarded commands', off: 'the guard-bash hook passes every command' },
  { name: 'auto-allow', default: 'shadow', modes: MODES, on: 'own read commands run without a permission prompt', shadow: 'would-allow decisions are logged', off: 'own commands are never auto-allowed' },
  { name: 'engine', default: 'shadow', modes: MODES, on: 'tier changes are decision records and set the team flags', shadow: 'proposed tier changes are logged in local/shadow.jsonl', off: 'tier is refused' },
  { name: 'admission', default: 'shadow', modes: MODES, on: 'implementer spawns wait for a free agent slot', shadow: 'would-deny readings are reported', off: 'agent spawns are not gated' },
  { name: 'edit-retrieval', default: 'on', modes: ['off', 'on'], on: 'decisions are shown before a file is edited', off: 'no decisions are shown at edit time' },
  { name: 'headroom', default: 'shadow', modes: MODES, on: 'context headroom warnings are injected', shadow: 'warnings it would inject are logged', off: 'no headroom warnings' },
  { name: 'executor-ui', default: 'off', modes: ['off', 'on'], on: 'external executors show as agent panel rows', off: 'no agent panel rows for external executors' },
].map((c) => Object.freeze(c)));

export const rollout = (name) => ROLLOUT.find((c) => c.name === name) ?? null;
