// Method v2 (plugins/<plugin>/method): core and pack topic files, stable rule IDs with tombstones, generated index,
// pack activation, legacy ID table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pluginDir, readTopics, buildIndex, validate, checkRegistry, activePacks, V2_PREFIXES, PACKS, MUST_PINNED_PACKS } from '../scripts/gen-method-index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const METHOD = join(pluginDir(root), 'method');
const GEN = join(root, 'scripts', 'gen-method-index.mjs');
const MAX_TOPIC_BYTES = 12 * 1024;
const MAX_CORE_BYTES = 60 * 1024;
const CORE_RULES = [90, 150]; // near 100 obligations; split into separately citable rules
const MAX_RULE_CHARS = 500; // D-MG-8: OWASP checklist rules keep their full checks
const MAX_RULE_SEMICOLONS = 2;
const MAX_ALWAYS = 8; // session-start injection shows up to 8 always rules
const MAX_ALWAYS_CHARS = 1400; // of the 2,000-char session-start budget
const POLISH = /[\u0104\u0105\u0106\u0107\u0118\u0119\u0141\u0142\u0143\u0144\u00d3\u00f3\u015a\u015b\u0179\u017a\u017b\u017c]/; // Polish diacritics

const topicFiles = readdirSync(METHOD).filter((f) => f.endsWith('.md')).sort(); // core topics
const PACK_DIR = join(METHOD, 'packs');
const packDirs = existsSync(PACK_DIR) ? readdirSync(PACK_DIR).filter((p) => statSync(join(PACK_DIR, p)).isDirectory()).sort() : [];
const packFiles = packDirs.flatMap((p) => readdirSync(join(PACK_DIR, p)).filter((f) => f.endsWith('.md')).sort().map((f) => `packs/${p}/${f}`));
const allTopics = [...topicFiles, ...packFiles];
const homeOf = (f) => (f.startsWith('packs/') ? f.split('/')[1] : 'core');
const everyFile = (rel = '') => readdirSync(join(METHOD, rel)).flatMap((f) => (statSync(join(METHOD, rel, f)).isDirectory() ? everyFile(join(rel, f)) : [join(rel, f)]));
const read = (f) => readFileSync(join(METHOD, f), 'utf8');
const index = JSON.parse(read('index.json'));
const legacy = JSON.parse(read('legacy-ids.json'));
const gen = (...args) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'method-'));
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
}
const topic = (title, sections) => [`# ${title}`, '', '**Purpose:** p. **Reads:** r. **When:** w.', '', '**Section map**',
  ...sections.map(([name]) => `- §${name} — what.`), '', '## Core', '',
  ...sections.flatMap(([name, rules]) => [`### ${name}`, ...rules, '']), ''].join('\n');
const ALPHA = (rules) => topic('Alpha', [['One', rules]]);
const IN_PACK = (pack, rules) => ALPHA(rules).replace('## Core', `## Pack: ${pack}`);
const errorsOf = (files) => validate(readTopics(fixture(files)));

test('method: core and pack topic files carry a title, purpose line, section map and the heading of their place', () => {
  assert.ok(topicFiles.length >= 8, `topic files: ${topicFiles}`);
  for (const f of allTopics) {
    const s = read(f);
    assert.match(s, /^# \S/, `${f}: "# Title" first`);
    assert.match(s, /^\*\*Purpose:\*\* .+ \*\*Reads:\*\* .+ \*\*When:\*\* .+$/m, `${f}: purpose line`);
    assert.match(s, /^\*\*Section map\*\*$/m, `${f}: section map`);
    const want = homeOf(f) === 'core' ? '## Core' : `## Pack: ${homeOf(f)}`;
    assert.deepEqual([...new Set(s.split('\n').filter((l) => l.startsWith('## ')))], [want], `${f}: membership heading`);
  }
  for (const p of packDirs) assert.ok(PACKS[p], `packs/${p}: unknown pack`);
});

test('method: committed topic files validate (IDs, sections, section maps, references)', () => {
  assert.deepEqual(validate(readTopics(METHOD)), []);
});

test('method: rule IDs use one v2 prefix per file, are unique and continuous from 1, one line each', () => {
  const seen = new Map();
  const owner = new Map();
  for (const f of allTopics) {
    const s = read(f);
    const ids = [...s.matchAll(/^\*\*([A-Z]{3})-(\d+)\.\*\*/gm)];
    assert.ok(ids.length >= 3, `${f}: rules`);
    const prefixes = new Set(ids.map((m) => m[1]));
    assert.equal(prefixes.size, 1, `${f}: one prefix (${[...prefixes]})`);
    assert.ok(V2_PREFIXES.includes(ids[0][1]), `${f}: ${ids[0][1]} is a v2 prefix`);
    assert.ok(!owner.has(ids[0][1]), `${f}: prefix ${ids[0][1]} also used by ${owner.get(ids[0][1])}`);
    owner.set(ids[0][1], f);
    const nums = ids.map((m) => Number(m[2])).sort((a, b) => a - b);
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `${f}: continuous from 1, no duplicates`);
    for (const m of ids) { assert.ok(!seen.has(m[0]), `${m[0]} in ${f} and ${seen.get(m[0])}`); seen.set(m[0], f); }
    for (const line of s.split('\n').filter((l) => /^\*\*[A-Z]{3}-\d+\.\*\*/.test(l))) assert.match(line, /^\*\*[A-Z]{3}-\d+\.\*\* \S.*\S$/, `${f}: one complete line: ${line.slice(0, 40)}`);
    assert.doesNotMatch(s, /^[-*] \*\*[A-Z]{3}-\d+\.\*\*/m, `${f}: rules are not list items`);
  }
});

test('method: every rule reference resolves to a live rule; no legacy prefixes in method text', () => {
  const live = new Set(Object.entries(index.rules).filter(([, r]) => !r.retired).map(([id]) => id));
  const old = Object.keys(legacy.prefixes).filter((p) => !V2_PREFIXES.includes(p));
  const oldRe = new RegExp(`\\b(${old.join('|')})-\\d+\\b`);
  const refRe = new RegExp(`\\b(${V2_PREFIXES.join('|')})-\\d+\\b`, 'g');
  assert.doesNotMatch(read('index.json'), oldRe, 'index.json: legacy rule ID');
  for (const f of allTopics) {
    const s = read(f);
    assert.doesNotMatch(s, oldRe, `${f}: legacy rule ID`);
    for (const line of s.split('\n')) {
      const own = line.match(/^\*\*([A-Z]{3}-\d+)\.\*\*/)?.[1];
      for (const [ref] of line.matchAll(refRe)) if (ref !== own) assert.ok(live.has(ref), `${f}: ${ref} does not resolve to a live rule`);
    }
  }
});

test('method: each rule is one citable obligation (≤ 500 chars, ≤ 2 semicolons)', () => {
  for (const f of allTopics) for (const line of read(f).split('\n').filter((l) => /^\*\*[A-Z]{3}-\d+\.\*\*/.test(l))) {
    const id = line.match(/^\*\*([A-Z]{3}-\d+)/)[1];
    assert.ok(line.length <= MAX_RULE_CHARS, `${f}: ${id} has ${line.length} chars; split it (new ID for the new obligation)`);
    assert.ok((line.match(/;/g) ?? []).length <= MAX_RULE_SEMICOLONS, `${f}: ${id} bundles too many clauses; split it`);
  }
});

test('method: sizes within limits (topic ≤ 12 KB, core ≤ 60 KB) and core near 100 rules', () => {
  let total = 0;
  for (const f of allTopics) {
    const b = Buffer.byteLength(read(f));
    assert.ok(b <= MAX_TOPIC_BYTES, `${f}: ${b} B > ${MAX_TOPIC_BYTES}`);
    if (homeOf(f) === 'core') total += b;
  }
  assert.ok(total <= MAX_CORE_BYTES, `core ${total} B > ${MAX_CORE_BYTES}`);
  const core = index.core.length;
  assert.ok(core >= CORE_RULES[0] && core <= CORE_RULES[1], `core rules ${core} outside ${CORE_RULES}`);
});

test('method: no Polish diacritics in any method file', () => {
  for (const f of everyFile()) assert.doesNotMatch(read(f), POLISH, f);
});

test('method: always set is small, core-only and within the session-start budget', () => {
  assert.ok(index.always.length >= 1 && index.always.length <= MAX_ALWAYS, `always: ${index.always.length}`);
  let chars = 0;
  for (const id of index.always) {
    const r = index.rules[id];
    assert.equal(r.pack, 'core', `${id} is core`);
    assert.equal(r.always, true, id);
    chars += read(r.file).split('\n')[r.line - 1].length;
  }
  assert.ok(chars <= MAX_ALWAYS_CHARS, `always lines ${chars} chars > ${MAX_ALWAYS_CHARS}`);
});

test('index: committed index.json equals a fresh generation (--check exits 0)', () => {
  const r = gen('--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(buildIndex(readTopics(METHOD), Object.keys(legacy.prefixes)), index);
});

test('index: --check reports a stale index with exit 1 and leaves it untouched', () => {
  const dir = fixture({ 'alpha.md': ALPHA(['**ALP-1.** Do one.', '**ALP-2.** Do two.']) });
  try {
    assert.equal(gen('--dir', dir).status, 0);
    writeFileSync(join(dir, 'alpha.md'), ALPHA(['**ALP-1.** Do one, changed.', '**ALP-2.** Do two.']));
    const before = readFileSync(join(dir, 'index.json'), 'utf8');
    const r = gen('--dir', dir, '--check');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /stale/);
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before);
    assert.equal(gen('--dir', dir).status, 0);
    assert.equal(gen('--dir', dir, '--check').status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('index: maps topic → sections → rule IDs → summary, with packs and activation', () => {
  for (const [name, t] of Object.entries(index.topics)) {
    assert.ok(existsSync(join(METHOD, t.file)), t.file);
    const fromSections = t.sections.flatMap((s) => s.rules);
    for (const id of fromSections) assert.equal(index.rules[id].topic, name, id);
    for (const s of t.sections) assert.match(s.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, s.slug);
  }
  for (const [id, r] of Object.entries(index.rules)) {
    assert.ok(r.retired || (r.summary.length > 10 && r.summary.length <= 100), `${id} summary: ${r.summary}`);
    assert.doesNotMatch(r.summary ?? '', /\[always\]/, id);
  }
  assert.deepEqual(Object.keys(index.packs).sort(), ['ai', 'backend-data', 'design-system', 'discovery', 'release', 'runbooks', 'security', 'team']);
  for (const [name, p] of Object.entries(index.packs)) {
    assert.ok(typeof p.when === 'string' && p.when.trim().length >= 2, `${name}: activation`);
    assert.ok(Array.isArray(p.any) && p.any.length >= 1, `${name}: machine-readable activation`);
    assert.deepEqual(p.topics, Object.keys(index.topics).filter((k) => index.topics[k].pack === name), `${name}: pack topics`);
  }
  for (const [id, r] of Object.entries(index.rules)) assert.equal(r.pack, index.topics[r.topic].pack, `${id}: rule pack = topic place`);
});

test('packs: every pack has topic files, and every pack directory is a known pack', () => {
  assert.deepEqual(packDirs, Object.keys(PACKS).sort());
  for (const p of Object.keys(PACKS)) {
    assert.ok(packFiles.some((f) => homeOf(f) === p), `pack ${p} has no topic file`);
    assert.ok(index.packs[p].topics.length >= 1, `index: pack ${p} lists no topics`);
    assert.ok(Object.values(index.rules).some((r) => r.pack === p && !r.retired), `pack ${p} has no live rule`);
  }
  assert.deepEqual(readdirSync(PACK_DIR).filter((f) => !statSync(join(PACK_DIR, f)).isDirectory()), [], 'only pack directories in packs/');
});

test('packs: activation resolves from profile facts, engine signals and tier', () => {
  const on = (signals) => activePacks(index.packs, signals).sort();
  assert.deepEqual(on({}), []);
  assert.deepEqual(on({ tier: 'L0', ui: false, backend: false, dataSensitivity: 'none', deployedToUsers: false, incidents30: 0, phase: 'building' }), []);
  assert.deepEqual(on({ tier: 'L1' }), []);
  assert.deepEqual(on({ tier: 'L2' }), ['team']);
  assert.deepEqual(on({ tier: 'L3' }), ['release', 'security', 'team']);
  assert.deepEqual(on({ phase: 'idea' }), ['discovery']);
  assert.deepEqual(on({ ui: true }), ['design-system']);
  assert.deepEqual(on({ backend: true }), ['backend-data']);
  for (const d of ['personal', 'payment', 'health']) assert.deepEqual(on({ dataSensitivity: d }), ['security'], d);
  // Fail-safe: an unknown non-empty sensitivity counts as sensitive; an empty or missing one is absent.
  for (const d of ['biometric', 'banana', 'PERSONAL']) assert.deepEqual(on({ dataSensitivity: d }), ['security'], d);
  for (const d of ['', '  ', null, undefined, 'none']) assert.deepEqual(on({ dataSensitivity: d }), [], String(d));
  const sens = index.packs.security.any.find((c) => c.key === 'dataSensitivity');
  assert.deepEqual(sens, { key: 'dataSensitivity', in: ['personal', 'payment', 'health'], off: ['none'], unknown: 'activate' });
  assert.match(read('packs/security/security.md').split('\n')[2], /unknown sensitivity value counts as sensitive/, 'the pack header states the fail-safe');
  assert.deepEqual(on({ deployedToUsers: true }), ['release', 'runbooks']);
  assert.deepEqual(on({ incidents30: 1 }), ['release', 'runbooks']);
  // Unknown or wrongly typed values never switch a pack on.
  assert.deepEqual(on({ tier: 'L9', ui: 'yes', incidents30: '3', dataSensitivity: null }), []);
});

test('index: rule lookup by ID — file and line hold the rule; core and always lists resolve', () => {
  const lookup = (id) => {
    const r = index.rules[id];
    if (!r) return null;
    if (r.retired) return r.redirect ? lookup(r.redirect) : read(r.file).split('\n')[r.line - 1];
    return read(r.file).split('\n')[r.line - 1];
  };
  for (const id of Object.keys(index.rules)) assert.ok(lookup(id)?.startsWith(`**${index.rules[id].redirect ?? id}.**`), id);
  assert.equal(lookup('XYZ-1'), null);
  assert.deepEqual(index.core, Object.keys(index.rules).filter((id) => index.rules[id].pack === 'core' && !index.rules[id].retired));
  for (const id of index.always) assert.ok(index.core.includes(id), id);
});

test('index: a live rule carries "must" exactly when its text holds MUST or MUST NOT', () => {
  let n = 0;
  for (const [id, r] of Object.entries(index.rules)) {
    const text = read(r.file).split('\n')[r.line - 1];
    const want = !r.retired && /\bMUST\b/.test(text);
    assert.equal(Boolean(r.must), want, `${id}: must flag`);
    n += want;
  }
  assert.ok(n >= 40, `MUST-bearing rules: ${n}`);
  assert.deepEqual(MUST_PINNED_PACKS, ['release', 'security', 'team']);
});

test('index: a 1.x citation resolves through the legacy table; prefixes shared by 1.x and v2 are listed', () => {
  assert.match(index.legacyLookup, /legacy-ids\.json/);
  const inUse = new Set(Object.values(index.topics).map((t) => t.prefix));
  const shared = Object.keys(legacy.prefixes).filter((p) => inUse.has(p)).sort();
  assert.deepEqual(index.legacyPrefixesShared, shared);
  for (const p of ['DSC', 'RUN']) assert.ok(index.legacyPrefixesShared.includes(p), p);
});

test('packs: a reference to a rule of another pack names that pack', () => {
  const ref = new RegExp(`\\b(?:${V2_PREFIXES.join('|')})-\\d+\\b`, 'g');
  const bad = [];
  let crossRefs = 0;
  for (const [id, r] of Object.entries(index.rules)) {
    if (r.pack === 'core' || r.retired) continue;
    const text = read(r.file).split('\n')[r.line - 1];
    for (const m of text.matchAll(ref)) {
      const to = index.rules[m[0]];
      if (!to || to.pack === 'core' || to.pack === r.pack) continue;
      crossRefs++;
      if (!text.slice(Math.max(0, m.index - 40), m.index).includes(`${to.pack} pack`)) bad.push(`${id} → ${m[0]} (${to.pack})`);
    }
  }
  assert.ok(crossRefs >= 5, `cross-pack references: ${crossRefs}`);
  assert.deepEqual(bad, []);
});

test('validate: catches duplicate, gap, mixed prefix, list-item rule, rule outside a section, unknown pack', () => {
  assert.deepEqual(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-2.** Two.']) }), []);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-1.** Again.']) }).join('\n'), /duplicate ALP-1/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-3.** Three.']) }).join('\n'), /continuous/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**BET-2.** Two.']) }).join('\n'), /one prefix/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '- **ALP-2.** Two.']) }).join('\n'), /list item/);
  const outside = ALPHA(['**ALP-1.** One.']).replace('## Core\n', '## Core\n**ALP-2.** Loose.\n');
  assert.match(errorsOf({ 'alpha.md': outside }).join('\n'), /outside a section/);
  const badPack = ALPHA(['**ALP-1.** One.']).replace('## Core', '## Pack: nonsense');
  assert.match(errorsOf({ 'alpha.md': badPack }).join('\n'), /unknown pack nonsense/);
});

test('validate: a pack file sits in packs/<pack>/ and holds only that pack; each file has its own prefix', () => {
  assert.deepEqual(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.']), 'packs/team/beta.md': IN_PACK('team', ['**BET-1.** One, see ALP-1.']) }), []);
  const index = buildIndex(readTopics(fixture({ 'alpha.md': ALPHA(['**ALP-1.** One.']), 'packs/team/beta.md': IN_PACK('team', ['**BET-1.** One.']) })));
  assert.deepEqual(index.packs.team.topics, ['packs/team/beta']);
  assert.equal(index.rules['BET-1'].pack, 'team');
  assert.equal(index.rules['BET-1'].file, 'packs/team/beta.md');
  assert.deepEqual(index.core, ['ALP-1']);
  assert.match(errorsOf({ 'packs/team/beta.md': ALPHA(['**BET-1.** One.']) }).join('\n'), /holds only "## Pack: team"/);
  assert.match(errorsOf({ 'alpha.md': IN_PACK('team', ['**ALP-1.** One.']) }).join('\n'), /pack rules live in packs\/team\//);
  assert.match(errorsOf({ 'packs/team/beta.md': IN_PACK('security', ['**BET-1.** One.']) }).join('\n'), /holds only "## Pack: team"/);
  assert.match(errorsOf({ 'packs/nonsense/beta.md': IN_PACK('nonsense', ['**BET-1.** One.']) }).join('\n'), /unknown pack nonsense/);
  assert.match(errorsOf({ 'packs/beta.md': IN_PACK('team', ['**BET-1.** One.']) }).join('\n'), /packs\/<pack>\/<topic>\.md/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.']), 'packs/team/beta.md': IN_PACK('team', ['**ALP-1.** One.']) }).join('\n'), /prefix ALP is already used by alpha\.md/);
  assert.match(errorsOf({ 'packs/team/beta.md': IN_PACK('team', ['**BET-1.** [always] One.']) }).join('\n'), /\[always\] outside "## Core"/);
});

test('validate: catches section-map drift, unresolved references and bad tombstones', () => {
  const drift = ALPHA(['**ALP-1.** One.']).replace('- §One — what.', '- §Other — what.');
  assert.match(errorsOf({ 'alpha.md': drift }).join('\n'), /section map/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One, see ALP-9.']) }).join('\n'), /ALP-9 does not resolve/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** Retired → ALP-7.']) }).join('\n'), /tombstone ALP-1 → ALP-7/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-2.** Retired → ALP-3.', '**ALP-3.** Retired → ALP-1.']) }).join('\n'), /tombstone ALP-2 → ALP-3/);
  assert.match(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-2.** Two, see ALP-3.', '**ALP-3.** Retired → ALP-1.']) }).join('\n'), /ALP-3 is retired/);
  assert.deepEqual(errorsOf({ 'alpha.md': ALPHA(['**ALP-1.** One, see ALP-2.', '**ALP-2.** Retired → ALP-1.']) }).filter((e) => !/retired/.test(e)), []);
});

test('registry: a rule is never deleted, renumbered or revived; a tombstone keeps its ID', () => {
  const v1 = buildIndex(readTopics(fixture({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-2.** Two.', '**ALP-3.** Three.']) })));
  const next = (rules) => buildIndex(readTopics(fixture({ 'alpha.md': ALPHA(rules) })));
  assert.deepEqual(checkRegistry(v1, next(['**ALP-1.** One.', '**ALP-2.** Two, edited.', '**ALP-3.** Three.', '**ALP-4.** Four.'])), []);
  assert.match(checkRegistry(v1, next(['**ALP-1.** One.', '**ALP-2.** Two.'])).join('\n'), /ALP-3 removed/);
  assert.deepEqual(checkRegistry(v1, next(['**ALP-1.** One.', '**ALP-2.** Two.', '**ALP-3.** Retired → ALP-1.'])), []);
  assert.match(checkRegistry(v1, next(['**ALP-1.** One.', '**ALP-2.** New rule.', '**ALP-3.** Two.', '**ALP-4.** Three.'])).join('\n'), /renumbered/);
  const v2 = next(['**ALP-1.** One.', '**ALP-2.** Two.', '**ALP-3.** Retired → ALP-1.']);
  assert.match(checkRegistry(v2, next(['**ALP-1.** One.', '**ALP-2.** Two.', '**ALP-3.** Revived.'])).join('\n'), /ALP-3 was retired/);
});

test('registry: a MUST rule of the security, release or team pack never loses MUST (a softened rule is a new rule)', () => {
  const build = (pack, rule) => buildIndex(readTopics(fixture({ 'alpha.md': ALPHA(['**ALP-1.** MUST do one.']), [`packs/${pack}/beta.md`]: IN_PACK(pack, [rule]) })));
  for (const pack of MUST_PINNED_PACKS) {
    const v1 = build(pack, '**BET-1.** MUST NOT do two.');
    assert.equal(v1.rules['BET-1'].must, true, pack);
    assert.deepEqual(checkRegistry(v1, build(pack, '**BET-1.** Never do two; MUST NOT do it either.')), [], `${pack}: rephrased, MUST kept`);
    assert.match(checkRegistry(v1, build(pack, '**BET-1.** Should not do two.')).join('\n'), /BET-1 dropped MUST/, pack);
    assert.deepEqual(checkRegistry(v1, build(pack, '**BET-1.** Retired → ALP-1.')), [], `${pack}: retiring is allowed`);
  }
  const free = build('discovery', '**BET-1.** MUST NOT do two.');
  assert.deepEqual(checkRegistry(free, build('discovery', '**BET-1.** Should not do two.')), [], 'other packs are pinned by tables, not by the registry');
});

test('registry: the generator refuses to write an index that drops an ID (exit 2, index untouched)', () => {
  const dir = fixture({ 'alpha.md': ALPHA(['**ALP-1.** One.', '**ALP-2.** Two.']) });
  try {
    assert.equal(gen('--dir', dir).status, 0);
    const before = readFileSync(join(dir, 'index.json'), 'utf8');
    writeFileSync(join(dir, 'alpha.md'), ALPHA(['**ALP-1.** One.']));
    const r = gen('--dir', dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /ALP-2 removed/);
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Legacy table: importer data only (IDs, no rule text).
const legacyKeys = [...read('legacy-ids.json').matchAll(/^\s+"([A-Z]{3}-\d+)":/gm)].map((m) => m[1]);

test('legacy: every legacy rule ID is mapped exactly once', () => {
  assert.equal(new Set(legacyKeys).size, legacyKeys.length, 'duplicate keys in legacy-ids.json');
  assert.deepEqual(Object.keys(legacy.rules), legacyKeys);
  const total = Object.values(legacy.counts).reduce((a, b) => a + b, 0);
  assert.equal(legacyKeys.length, total);
  for (const [p, n] of Object.entries(legacy.counts)) {
    const nums = legacyKeys.filter((k) => k.startsWith(`${p}-`)).map((k) => Number(k.slice(4))).sort((a, b) => a - b);
    assert.deepEqual(nums, Array.from({ length: n }, (_, i) => i + 1), `${p}: 1..${n}`);
  }
  // While the 1.x method documents are still in the repository, the table covers exactly their rule IDs.
  const old = Object.keys(legacy.prefixes);
  const re = new RegExp(`^(?:[-*] )?\\*\\*((?:${old.join('|')})-\\d+)\\.\\*\\*`, 'gm');
  const docsDir = join(root, 'docs');
  const inDocs = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => /^\d\d-.*\.md$/.test(f)).flatMap((f) => [...readFileSync(join(docsDir, f), 'utf8').matchAll(re)].map((m) => m[1])) : [];
  const oldOnly = old.filter((p) => !V2_PREFIXES.includes(p));
  if (inDocs.some((id) => oldOnly.includes(id.slice(0, 3)))) assert.deepEqual([...new Set(inDocs)].sort(), [...legacyKeys].sort(), 'legacy docs and table disagree');
});

test('legacy: each target resolves — core rule, live rule of its pack, or retired with a reason', () => {
  const packs = Object.keys(index.packs);
  for (const [id, t] of Object.entries(legacy.rules)) {
    const kinds = ['core', 'pack', 'retired'].filter((k) => k in t);
    assert.equal(kinds.length, 1, `${id}: exactly one target kind`);
    if (t.core) assert.ok(index.rules[t.core] && !index.rules[t.core].retired && index.rules[t.core].pack === 'core', `${id} → ${t.core} is not a live core rule`);
    if (t.pack) {
      assert.ok(packs.includes(t.pack), `${id}: pack ${t.pack}`);
      assert.match(t.id, /^[A-Z]{3}-\d+$/, `${id}: pack rule ID`);
      const r = index.rules[t.id];
      assert.ok(r && !r.retired && r.pack === t.pack, `${id} → ${t.id} is not a live rule of pack ${t.pack}`);
    }
    if ('retired' in t) assert.ok(typeof t.retired === 'string' && t.retired.length > 15, `${id}: retirement reason`);
    assert.equal(Object.keys(t).length, t.pack ? 2 : 1, `${id}: no extra fields`);
  }
});

test('legacy: values are importer data only (prefix map matches the rule-ID rename)', () => {
  assert.deepEqual(legacy.prefixes, { ZAS: 'PRI', PRC: 'FLW', DSC: 'DSC', SPC: 'SPC', KOD: 'COD', ORK: 'ORC', RES: 'RES', REV: 'REV', BZP: 'SEC', DSN: 'DSG', MEM: 'MEM', PUL: 'TRP', WDR: 'ADP', ZES: 'COL', RUN: 'RUN' });
  for (const p of new Set(Object.values(legacy.prefixes))) assert.ok(V2_PREFIXES.includes(p), `${p}: family prefix is a v2 prefix`);
  assert.equal(legacy.schema, 1);
});
