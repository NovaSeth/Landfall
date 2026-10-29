#!/usr/bin/env node
// gen-method-index.mjs — generate plugins/<plugin>/method/index.json from the method topic files.
//
//   node scripts/gen-method-index.mjs                write index.json
//   node scripts/gen-method-index.mjs --check        exit 1 when index.json is stale (task gate, CI)
//   node scripts/gen-method-index.mjs --dir <path>   method directory (default plugins/<plugin>/method, found via lib/name.json)
//   node scripts/gen-method-index.mjs --help         this help (also -h)
//
// Topic file: "# Title", a purpose line, a "**Section map**" list ("- §<Section> — …"), then a membership
// heading holding "### <Section>" sections with one rule per line: "**<PFX>-<n>.** text". Core topics sit
// in the method directory under "## Core"; pack topics sit in packs/<pack>/<topic>.md under "## Pack: <pack>",
// so the directory and the heading agree. A rule tagged "[always]" is printed at session start (core only).
// A retired rule stays as a tombstone line "**<PFX>-<n>.** Retired → <PFX>-<m>." (or "Retired." alone).
// Each file has its own prefix, and its IDs are continuous from 1 and permanent: the committed index is the
// registry, and an ID in it is never dropped, renumbered or revived.
// Exit codes: 0 written or current · 1 stale (--check) · 2 invalid method, registry violation or usage error.
import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The plugin directory is found by location (the one with lib/name.json), so this script holds no plugin name.
export function pluginDir(root) {
  const plugins = join(root, 'plugins');
  const dirs = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  return dirs.length === 1 ? join(plugins, dirs[0]) : null;
}
const DEFAULT_DIR = join(pluginDir(ROOT) ?? join(ROOT, 'plugins', 'missing-plugin'), 'method');

// Rule-ID prefixes of the method, one per topic file (RES and ADP are reserved family prefixes without a file).
export const V2_PREFIXES = ['PRI', 'FLW', 'DSC', 'SPC', 'COD', 'ORC', 'RES', 'REV', 'SEC', 'DSG', 'MEM', 'TRP', 'ADP', 'COL', 'RUN',
  'SCR', 'CTR', 'WRT', 'SVC', 'SCD', 'REL', 'OWA', 'LLM', 'AGT'];

// Packs and the profile facts or engine signals that activate them. "any" is evaluated by activePacks() (lib/method);
// "when" is the same condition for people. Every pack can also be loaded on request.
export const PACKS = {
  discovery: { when: 'phase = idea, or on request', any: [{ key: 'phase', is: 'idea' }] },
  'design-system': { when: 'ui', any: [{ key: 'ui', is: true }] },
  'backend-data': { when: 'backend', any: [{ key: 'backend', is: true }] },
  // Fail-safe: a sensitivity value that is neither listed nor "none" counts as sensitive.
  security: { when: 'dataSensitivity personal, payment, health or any unknown non-empty value (not none), or tier >= L3',
    any: [{ key: 'dataSensitivity', in: ['personal', 'payment', 'health'], off: ['none'], unknown: 'activate' }, { key: 'tier', atLeast: 'L3' }] },
  ai: { when: 'llm', any: [{ key: 'llm', is: true }] },
  team: { when: 'tier >= L2', any: [{ key: 'tier', atLeast: 'L2' }] },
  runbooks: { when: 'deployedToUsers, or incidents30 >= 1', any: [{ key: 'deployedToUsers', is: true }, { key: 'incidents30', atLeast: 1 }] },
  release: { when: 'deployedToUsers, or incidents30 >= 1, or tier >= L3', any: [{ key: 'deployedToUsers', is: true }, { key: 'incidents30', atLeast: 1 }, { key: 'tier', atLeast: 'L3' }] },
};
// Packs whose MUST rules the registry pins: a rule there that had MUST keeps it (see checkRegistry).
export const MUST_PINNED_PACKS = ['release', 'security', 'team'];

// Pack resolution (activePacks) lives in the plugin's read-only method unit; the generator re-exports it for its callers.
const PLUGIN_DIR = pluginDir(ROOT);
const methodUnit = PLUGIN_DIR ? await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'method', 'index.mjs')).href) : {};
export const { activePacks, TIERS } = methodUnit;

const RULE = /^\*\*([A-Z]{3})-(\d+)\.\*\*(?: (.*))?$/;
const LIST_RULE = /^[-*] \*\*[A-Z]{3}-\d+\.\*\*/;
const TOMBSTONE = /^Retired(?: → ([A-Z]{3}-\d+))?\.(?: .*)?$/;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

// Membership of a file by its place: "core" in the method directory, the pack name in packs/<pack>/, null elsewhere.
export function homeOf(file) {
  if (!file.includes('/')) return 'core';
  const m = file.match(/^packs\/([a-z0-9-]+)\/[^/]+\.md$/);
  return m ? m[1] : null;
}

// One topic file → its title, section map, sections and rules (with structural problems found on the way).
export function parseTopic(file, text) {
  const home = homeOf(file);
  const t = { file, topic: file.replace(/\.md$/, ''), home, title: null, sectionMap: null, sections: [], rules: [], problems: [] };
  const bad = (n, msg) => t.problems.push(`${file}:${n}: ${msg}`);
  if (!home) bad(0, 'a pack file lives in packs/<pack>/<topic>.md');
  const lines = text.split('\n');
  let pack = null;
  let section = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (i === 0) { const m = line.match(/^# (\S.*)$/); if (m) t.title = m[1]; else bad(n, 'first line must be "# <Title>"'); return; }
    if (line === '**Section map**') {
      t.sectionMap = [];
      for (let j = i + 1; j < lines.length && lines[j].startsWith('- §'); j++) t.sectionMap.push(lines[j].slice(3).split(' — ')[0].trim());
      return;
    }
    if (line.startsWith('## ')) {
      const m = line.match(/^## (?:(Core)|Pack: ([a-z0-9-]+))$/);
      if (!m) { bad(n, `unexpected heading "${line}" (use "## Core" or "## Pack: <name>")`); return; }
      pack = m[1] ? 'core' : m[2];
      if (pack !== 'core' && !PACKS[pack]) bad(n, `unknown pack ${pack}`);
      else if (home && pack !== home) bad(n, home === 'core' ? `"${line}" in a core topic; pack rules live in packs/${pack}/` : `"${line}" in packs/${home}/; this file holds only "## Pack: ${home}"`);
      section = null;
      return;
    }
    if (line.startsWith('### ')) {
      if (!pack) { bad(n, `section "${line.slice(4)}" outside "## Core" or "## Pack: <name>"`); return; }
      section = { name: line.slice(4).trim(), slug: slug(line.slice(4)), pack, line: n, rules: [] };
      t.sections.push(section);
      return;
    }
    if (LIST_RULE.test(line)) { bad(n, 'rule written as a list item; a rule is a plain line "**<ID>.** text"'); return; }
    const m = line.match(RULE);
    if (!m) { if (/^\*\*[A-Z]{3}-\d+/.test(line)) bad(n, `malformed rule line "${line.slice(0, 40)}"`); return; }
    const id = `${m[1]}-${m[2]}`;
    const body = (m[3] ?? '').trim();
    if (!body) { bad(n, `${id} has no text`); return; }
    if (!section) { bad(n, `${id} outside a section ("### <Section>")`); return; }
    const tomb = body.match(TOMBSTONE);
    t.rules.push({ id, prefix: m[1], n: Number(m[2]), line: n, text: body, section: section.name, pack: section.pack,
      retired: Boolean(tomb), redirect: tomb?.[1] ?? null, always: !tomb && body.startsWith('[always] ') });
    section.rules.push(id);
  });
  return t;
}

// Core topics (*.md in the method directory), then pack topics (packs/<pack>/*.md, packs in name order).
export function readTopics(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const packs = join(dir, 'packs');
  if (existsSync(packs)) {
    for (const p of readdirSync(packs).sort()) {
      if (statSync(join(packs, p)).isDirectory()) files.push(...readdirSync(join(packs, p)).filter((f) => f.endsWith('.md')).sort().map((f) => `packs/${p}/${f}`));
      else if (p.endsWith('.md')) files.push(`packs/${p}`);
    }
  }
  return files.map((f) => parseTopic(f, readFileSync(join(dir, f), 'utf8')));
}

// Every problem in a set of topic files; [] when the method is valid.
export function validate(topics) {
  const errors = topics.flatMap((t) => t.problems);
  const all = new Map();
  const owner = new Map();
  for (const t of topics) {
    if (!t.sectionMap) errors.push(`${t.file}: missing "**Section map**" block`);
    else if (t.sectionMap.join('\n') !== t.sections.map((s) => s.name).join('\n')) errors.push(`${t.file}: section map [${t.sectionMap.join(', ')}] does not match the sections [${t.sections.map((s) => s.name).join(', ')}]`);
    const names = t.sections.map((s) => s.slug);
    for (const s of new Set(names.filter((x, i) => names.indexOf(x) !== i))) errors.push(`${t.file}: section ${s} appears twice`);
    for (const s of t.sections) if (!s.rules.length) errors.push(`${t.file}: section "${s.name}" has no rules`);
    if (!t.rules.length) { errors.push(`${t.file}: no rules`); continue; }
    const prefixes = [...new Set(t.rules.map((r) => r.prefix))];
    if (prefixes.length > 1) errors.push(`${t.file}: one prefix per file, found ${prefixes.join(', ')}`);
    for (const p of prefixes) {
      if (owner.has(p)) errors.push(`${t.file}: prefix ${p} is already used by ${owner.get(p)}; each file has its own prefix`);
      else owner.set(p, t.file);
    }
    for (const r of t.rules) {
      if (all.has(r.id)) errors.push(`${t.file}:${r.line}: duplicate ${r.id} (also ${all.get(r.id).file}:${all.get(r.id).line})`);
      else all.set(r.id, { ...r, file: t.file });
    }
    for (const p of prefixes) {
      const nums = t.rules.filter((r) => r.prefix === p).map((r) => r.n).sort((a, b) => a - b);
      const want = nums.map((_, i) => i + 1);
      if (nums.join() !== want.join()) errors.push(`${t.file}: ${p} IDs must be continuous from 1 (found ${nums.join(', ')}); retire a rule with a tombstone, never delete it`);
    }
    for (const r of t.rules) if (r.always && r.pack !== 'core') errors.push(`${t.file}:${r.line}: ${r.id} is tagged [always] outside "## Core"`);
  }
  const prefixes = new Set([...V2_PREFIXES, ...[...all.values()].map((r) => r.prefix)]);
  const refRe = new RegExp(`\\b(?:${[...prefixes].join('|')})-\\d+\\b`, 'g');
  for (const r of all.values()) {
    if (r.retired && r.redirect) {
      const to = all.get(r.redirect);
      if (!to || to.retired) errors.push(`${r.file}:${r.line}: tombstone ${r.id} → ${r.redirect} does not point to a live rule`);
      continue;
    }
    for (const [ref] of r.text.matchAll(refRe)) {
      if (ref === r.id) continue;
      const to = all.get(ref);
      if (!to) errors.push(`${r.file}:${r.line}: ${r.id} cites ${ref}; ${ref} does not resolve`);
      else if (to.retired) errors.push(`${r.file}:${r.line}: ${r.id} cites ${ref}, but ${ref} is retired${to.redirect ? ` (cite ${to.redirect})` : ''}`);
    }
  }
  return errors;
}

// First clause of a rule (at least 30 characters when the text allows), at most 100 characters;
// a clause that is too long loses its parentheticals before it is truncated.
export function summary(text) {
  const s = text.replace(/^\[always\] /, '');
  const clause = firstClause(s);
  if (clause.length <= 100) return clause;
  let bare = s;
  for (let prev = ''; prev !== bare;) { prev = bare; bare = bare.replace(/\s*\([^()]*\)/g, ''); }
  const out = firstClause(bare);
  return out.length <= 100 ? out : `${out.slice(0, 99).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…`;
}

function firstClause(s) {
  const cuts = [];
  let tick = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') tick = !tick;
    else if (tick) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || s.startsWith(', because ', i) || ((c === ':' || c === '.') && (i === s.length - 1 || s[i + 1] === ' ')))) cuts.push(i);
  }
  return s.slice(0, cuts.find((i) => i >= 30) ?? s.length).trim();
}

const LEGACY_LOOKUP = 'A rule ID cited in 1.x records (ledger, briefs, reviews) resolves through legacy-ids.json, never as a method rule: the prefixes in legacyPrefixesShared name different rules in 1.x and here.';

// legacyPrefixes: the 1.x rule-ID prefixes (keys of legacy-ids.json "prefixes"); those also used by a topic file are listed as shared.
export function buildIndex(topics, legacyPrefixes = []) {
  const packs = Object.fromEntries(Object.entries(PACKS).map(([name, p]) => [name, { ...p, topics: topics.filter((t) => t.home === name).map((t) => t.topic) }]));
  const inUse = new Set(topics.map((t) => t.rules[0]?.prefix).filter(Boolean));
  const index = { schema: 1, generated: 'by scripts/gen-method-index.mjs from the topic files; do not edit',
    legacyLookup: LEGACY_LOOKUP, legacyPrefixesShared: legacyPrefixes.filter((p) => inUse.has(p)).sort(),
    packs, topics: {}, rules: {}, core: [], always: [] };
  for (const t of topics) {
    index.topics[t.topic] = { file: t.file, title: t.title, prefix: t.rules[0]?.prefix ?? null, pack: t.home,
      sections: t.sections.map((s) => ({ name: s.name, slug: s.slug, pack: s.pack, rules: s.rules })) };
    for (const r of [...t.rules].sort((a, b) => a.n - b.n)) {
      const base = { topic: t.topic, file: t.file, line: r.line, section: r.section, pack: r.pack };
      index.rules[r.id] = r.retired
        ? { ...base, retired: true, ...(r.redirect ? { redirect: r.redirect } : {}), hash: hash(r.text) }
        : { ...base, summary: summary(r.text), ...(r.always ? { always: true } : {}), ...(/\bMUST\b/.test(r.text) ? { must: true } : {}), hash: hash(r.text) };
      if (!r.retired && r.pack === 'core') index.core.push(r.id);
      if (r.always) index.always.push(r.id);
    }
  }
  return index;
}

// The previous index is the registry: IDs are never dropped, renumbered or revived, and a MUST rule of a
// MUST_PINNED_PACKS pack keeps MUST (softening it changes its meaning: retire it and add a new ID).
export function checkRegistry(prev, next) {
  const errors = [];
  const byHash = new Map();
  for (const [id, r] of Object.entries(next.rules)) if (!r.retired) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), id]);
  for (const [id, p] of Object.entries(prev?.rules ?? {})) {
    const n = next.rules[id];
    if (!n) { errors.push(`${id} removed: rule IDs are permanent; keep the line as a tombstone "**${id}.** Retired → <successor>."`); continue; }
    if (p.retired && !n.retired) { errors.push(`${id} was retired: a tombstone is never revived; add a new rule with the next free ID`); continue; }
    if (p.must && MUST_PINNED_PACKS.includes(p.pack) && !n.retired && !n.must) errors.push(`${id} dropped MUST: a softened rule is a new rule; retire ${id} and add one with the next free ID`);
    if (!p.retired && n.hash !== p.hash) {
      const moved = (byHash.get(p.hash) ?? []).filter((x) => x !== id);
      if (moved.length) errors.push(`${id} renumbered: its text now sits under ${moved.join(', ')}; IDs never change, new rules take the next free ID`);
    }
  }
  return errors;
}

export function serialize(index) {
  const one = (o) => JSON.stringify(o);
  const block = (entries, indent) => entries.map(([k, v]) => `${indent}${one(k)}: ${v}`).join(',\n');
  return ['{', `  "schema": ${index.schema},`, `  "generated": ${one(index.generated)},`,
    `  "legacyLookup": ${one(index.legacyLookup)},`, `  "legacyPrefixesShared": ${one(index.legacyPrefixesShared)},`,
    '  "packs": {', block(Object.entries(index.packs).map(([k, v]) => [k, one(v)]), '    '), '  },',
    '  "topics": {', block(Object.entries(index.topics).map(([k, t]) => [k, [`{"file": ${one(t.file)}, "title": ${one(t.title)}, "prefix": ${one(t.prefix)}, "pack": ${one(t.pack)}, "sections": [`,
      t.sections.map((s) => `      ${one(s)}`).join(',\n'), '    ]}'].join('\n')]), '    '), '  },',
    '  "rules": {', block(Object.entries(index.rules).map(([k, r]) => [k, one(r)]), '    '), '  },',
    `  "core": ${one(index.core)},`, `  "always": ${one(index.always)}`, '}', ''].join('\n');
}

const USAGE = 'usage: node scripts/gen-method-index.mjs [--check] [--dir <method directory>]';

export function main(argv) {
  let dir = DEFAULT_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--dir' && argv[i + 1]) dir = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    else { console.error(`gen-method-index: unknown argument ${a}\n${USAGE}`); return 2; }
  }
  if (!existsSync(dir)) { console.error(`gen-method-index: no method directory ${dir}`); return 2; }
  const topics = readTopics(dir);
  const errors = validate(topics);
  const legacyFile = join(dir, 'legacy-ids.json');
  let legacyPrefixes = [];
  if (existsSync(legacyFile)) {
    try { legacyPrefixes = Object.keys(JSON.parse(readFileSync(legacyFile, 'utf8')).prefixes ?? {}); } catch { errors.push('legacy-ids.json is not valid JSON'); }
  }
  const next = buildIndex(topics, legacyPrefixes);
  const path = join(dir, 'index.json');
  let committed = null;
  let prev = null;
  if (existsSync(path)) {
    committed = readFileSync(path, 'utf8');
    try { prev = JSON.parse(committed); } catch { errors.push('index.json is not valid JSON; restore it from git before regenerating'); }
  }
  errors.push(...checkRegistry(prev, next));
  if (errors.length) { for (const e of errors) console.error(`gen-method-index: ${e}`); return 2; }
  const text = serialize(next);
  if (check) {
    if (committed !== text) { console.error('gen-method-index: index.json is stale; run node scripts/gen-method-index.mjs'); return 1; }
    console.log(`gen-method-index: index.json is current (${Object.keys(next.rules).length} rules)`);
    return 0;
  }
  if (committed !== text) { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); }
  console.log(`gen-method-index: index.json — ${Object.keys(next.rules).length} rules, core ${next.core.length}, always ${next.always.length}`);
  return 0;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) process.exitCode = main(process.argv.slice(2));
