// `<bin> rule <ID…>` and `<bin> rule --core` (spec §7.15, §8.2): method rules by ID through lib/method. --core
// prints the rules tagged [always] first. A retired ID prints its tombstone, then its successor. Text: one line per
// rule, "<ID>. <text>". Exit 0 all found · 2 a malformed or unknown ID (the rules found are still printed; with
// --json, data.partial is true). A stale index is a broken copy: it throws, so the CLI reports INTERNAL (70).
import { RULE_ID, lookupRules, openMethod } from '../method/index.mjs';
import { COMMANDS, EXIT } from './commands.mjs';
import { commandUsage } from './help.mjs';

const EXAMPLE = 'COD-7';

function unknownHint({ id, range, prefixes, legacy }) {
  if (legacy?.core) return `${id} is a 1.x rule ID; its successor here is ${legacy.core}`;
  if (legacy?.pack) return `${id} is a 1.x rule ID; its successor here is ${legacy.id} (${legacy.pack} pack)`;
  if (legacy && 'retired' in legacy) return `${id} is a 1.x rule ID, retired in this method: ${legacy.retired}`;
  if (range) return `${id.slice(0, 3)} rules run from ${range[0]} to ${range[1]}`;
  return `rule IDs start with one of: ${prefixes.join(', ')}`;
}

export function rule({ args, flags, names }) {
  const method = openMethod();
  const requested = [...(flags.core ? method.index.always : []), ...(args.id ?? [])];
  if (!requested.length) {
    return {
      code: EXIT.USAGE,
      errors: [{ code: 'missing-argument', message: 'rule: give one or more rule IDs, or --core', hint: `${names.bin} rule ${EXAMPLE} · ${names.bin} rule --core` }],
      usage: commandUsage(COMMANDS.find((r) => r.name === 'rule'), names.bin),
    };
  }
  const errors = [];
  const ids = [];
  for (const raw of requested) {
    const id = String(raw).toUpperCase();
    if (RULE_ID.test(id)) ids.push(id);
    else errors.push({ code: 'invalid-rule-id', message: `not a rule ID: ${raw}`, hint: `a rule ID is three capital letters, a dash and a number, such as ${EXAMPLE}` });
  }
  const { rules, unknown } = lookupRules(method, ids);
  for (const u of unknown) errors.push({ code: 'unknown-rule', message: `unknown rule ID: ${u.id}`, hint: unknownHint(u) });
  return {
    code: errors.length ? EXIT.USAGE : EXIT.OK,
    data: { rules, ...(errors.length ? { partial: true } : {}) },
    errors,
    text: rules.map((r) => `${r.id}. ${r.text}\n`).join(''),
  };
}
