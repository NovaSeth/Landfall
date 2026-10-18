// Method access (spec §4.2, §7.15): rule lookup by ID from method/index.json and the topic files, the always
// set, and pack resolution. Read-only: this unit makes no write call and imports only Node built-ins
// (tests/architecture.test.mjs). scripts/gen-method-index.mjs generates index.json and imports activePacks()
// from here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const METHOD_DIR = fileURLToPath(new URL('../../method/', import.meta.url));
export const TIERS = ['L0', 'L1', 'L2', 'L3'];
export const RULE_ID = /^[A-Z]{3}-\d{1,5}$/;

// Pack resolution: the packs whose conditions hold for the given facts and signals ({tier, ui, phase, …}).
// packs: the "packs" table of index.json. Conditions: {key, is} equals · {key, atLeast} number or tier ·
// {key, in, off, unknown} enumeration, where a value in "off" is inactive and any other present value activates
// only when listed in "in" or when unknown is "activate". A missing value (undefined, null, empty string) never
// activates a pack.
export function activePacks(packs, signals) {
  const holds = (c) => {
    const v = signals?.[c.key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return false;
    if ('is' in c) return v === c.is;
    if ('in' in c) return !(c.off ?? []).includes(v) && (c.in.includes(v) || c.unknown === 'activate');
    if ('atLeast' in c) {
      if (c.key !== 'tier') return typeof v === 'number' && v >= c.atLeast;
      return TIERS.includes(v) && TIERS.indexOf(v) >= TIERS.indexOf(c.atLeast);
    }
    return false;
  };
  return Object.keys(packs).filter((name) => (packs[name].any ?? []).some(holds));
}

// The method in a directory: its index and the rule lines of its topic files, read on first use.
export function openMethod(dir = METHOD_DIR) {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  const files = new Map();
  let legacy = null;
  return {
    dir,
    index,
    line(file, n) {
      if (!files.has(file)) files.set(file, readFileSync(join(dir, file), 'utf8').split('\n'));
      return files.get(file)[n - 1] ?? '';
    },
    // The 1.x rule-ID table (legacy-ids.json "rules"); {} when the file is absent.
    legacy() {
      if (legacy === null) {
        try { legacy = JSON.parse(readFileSync(join(dir, 'legacy-ids.json'), 'utf8')).rules ?? {}; } catch (err) { if (err.code !== 'ENOENT') throw err; legacy = {}; }
      }
      return legacy;
    },
  };
}

const LINE = /^\*\*([A-Z]{3}-\d+)\.\*\* (.+)$/;

// One rule by ID, or null when the method has no such ID. The text drops the [always] tag; a tombstone's text is
// "Retired → <ID>." or "Retired.". An index entry whose line does not hold the rule throws: the copy is broken.
export function getRule(method, id) {
  const r = method.index.rules[id];
  if (!r) return null;
  const m = method.line(r.file, r.line).match(LINE);
  if (!m || m[1] !== id) throw new Error(`method/index.json is stale: ${r.file}:${r.line} does not hold ${id}; regenerate the index or reinstall the plugin`);
  return {
    id, text: m[2].replace(/^\[always\] /, ''), topic: r.topic, file: r.file, line: r.line, section: r.section, pack: r.pack,
    always: r.always === true, must: r.must === true, retired: r.retired === true, redirect: r.redirect ?? null,
  };
}

// What the method knows about an ID it does not hold: the rule-number range of its prefix, the prefixes in use,
// and the 1.x successor when legacy-ids.json maps the ID ({core} | {pack, id} | {retired: reason}).
export function explainUnknown(method, id) {
  const prefix = id.slice(0, 3);
  const numbers = Object.keys(method.index.rules).filter((k) => k.startsWith(`${prefix}-`)).map((k) => Number(k.slice(4)));
  const prefixes = [...new Set(Object.values(method.index.topics).map((t) => t.prefix).filter(Boolean))].sort();
  return { id, range: numbers.length ? [`${prefix}-${Math.min(...numbers)}`, `${prefix}-${Math.max(...numbers)}`] : null, prefixes, legacy: method.legacy()[id] ?? null };
}

// The rule IDs a task brief cites (ORC-4), by executor role and by task class (the route's depth, spec §7.5): what the
// role's agent follows, then what the class adds (planning depth, PRI-2; the same outcome gates, PRI-15).
export const BRIEF_RULES = Object.freeze({
  role: Object.freeze({
    implementer: Object.freeze(['ORC-2', 'ORC-17', 'ORC-18', 'ORC-12', 'ORC-13', 'COD-1', 'COD-2', 'COD-3', 'COD-14', 'REV-10', 'REV-9', 'REV-18', 'ORC-7']),
    reviewer: Object.freeze(['ORC-2', 'ORC-18', 'REV-1', 'REV-2', 'REV-3', 'REV-4', 'REV-6', 'REV-9', 'COD-2', 'COD-3', 'ORC-7']),
  }),
  class: Object.freeze({
    trivial: Object.freeze(['PRI-15']),
    standard: Object.freeze(['PRI-2', 'PRI-15', 'SPC-13', 'SPC-14']),
    critical: Object.freeze(['PRI-2', 'PRI-15', 'PRI-6', 'SPC-1', 'SPC-3', 'SPC-13', 'SPC-14']),
  }),
});

// The rule IDs of a brief for class `cls` and role `role`: the role's, then the class's, each once.
export function briefRules({ cls, role }) {
  const r = BRIEF_RULES.role[role];
  const c = BRIEF_RULES.class[cls];
  if (!Object.hasOwn(BRIEF_RULES.role, role) || !Object.hasOwn(BRIEF_RULES.class, cls)) throw new TypeError(`briefRules: no rules for class ${cls} and role ${role}`);
  return [...new Set([...r, ...c])];
}

// The names `method` prints a part of the method by (spec §7.15): every pack of the index "packs" table, and every
// section as "<topic>/<section slug>" (the topic key of the index; a slug alone repeats across topics).
export function partNames(method) {
  const { packs, topics } = method.index;
  return { packs: Object.keys(packs), sections: Object.entries(topics).flatMap(([topic, t]) => t.sections.map((s) => `${topic}/${s.slug}`)) };
}

// One pack or section by name, or null: { kind: pack | section, name, when (packs), sections: [{ name, topic, title,
// section, pack, rules: [getRule()] }] }, sections and rules in index order.
export function methodPart(method, name) {
  const { packs, topics } = method.index;
  const section = (topic, s) => ({ name: `${topic}/${s.slug}`, topic, title: topics[topic].title, section: s.name, pack: s.pack, rules: s.rules.map((id) => getRule(method, id)) });
  if (Object.hasOwn(packs, name)) {
    return { kind: 'pack', name, when: packs[name].when, sections: packs[name].topics.flatMap((topic) => topics[topic].sections.map((s) => section(topic, s))) };
  }
  const cut = name.lastIndexOf('/');
  const topic = cut > 0 ? name.slice(0, cut) : null;
  const s = topic !== null && Object.hasOwn(topics, topic) ? topics[topic].sections.find((x) => x.slug === name.slice(cut + 1)) : undefined;
  return s ? { kind: 'section', name, when: null, sections: [section(topic, s)] } : null;
}

// The rules to print for the requested IDs, in order and without repeats: each found ID, followed by the successor
// of a retired one. unknown: explainUnknown() for each ID the method does not hold. IDs must match RULE_ID.
export function lookupRules(method, ids) {
  const rules = [];
  const unknown = [];
  const seen = new Set();
  const push = (rule) => { if (!seen.has(rule.id)) { seen.add(rule.id); rules.push(rule); } };
  for (const id of ids) {
    const rule = getRule(method, id);
    if (!rule) { unknown.push(explainUnknown(method, id)); continue; }
    push(rule);
    if (rule.redirect) {
      const next = getRule(method, rule.redirect);
      if (next) push(next);
    }
  }
  return { rules, unknown };
}
