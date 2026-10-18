// Command names (spec §8.2, GC6, COD-5, COD-11): every `<bin> <command>` that the plugin tells an agent or a user to run
// names a row of the command table (lib/cli/commands.mjs): in the templates (skills, agents, task files, generated
// files), the shipped skills and agents, the loop's step texts (lib/loop), the hook messages (lib/hooks, and the guard
// messages and owned-file texts in lib/guard they show) and the guard's own-command auto-allow list (OWN_COMMANDS).
// A reference is the words after the command where it starts one: `{{bin}}` in a template; a code span "`<bin> …" in
// a shipped Markdown file; "\`${bin} …" or "'${bin} …" in a source file (a template literal's own backtick is no code
// span, prose such as "the ${bin} loop ended" is none). It resolves when a row's words are its first words.
// Commands of units not merged yet are on PENDING, which only shrinks: an entry that became a row, or that nothing
// names any more, fails the test. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { COMMANDS } = await lib('cli/commands.mjs');
const { OWN_COMMANDS } = await lib('guard/allow.mjs');

// Shrink-only (spec §8.2 commands whose unit is not merged yet, and names that differ from the row that exists):
// remove an entry when its row lands or nothing names it any more; never add one to hide a typo.
const PENDING = Object.freeze([
  { name: 'exec', why: 'providers unit (spec §7.12): guard auto-allow list' },
  { name: 'wait', why: 'providers unit (spec §7.12): guard auto-allow list' },
  { name: 'runs', why: 'providers unit (spec §7.12): guard auto-allow list' },
  { name: 'flags', why: 'rollout commands (spec §8.2 flags show|set): owned-file text of state.json' },
  { name: 'team add', why: 'team command (spec §8.2): owned-file text of team/<H>.json' },
  { name: 'decisions context', why: 'spec §8.2 name; the row that exists is `decisions find --path`: guard auto-allow list' },
  { name: 'slot list', why: 'spec §8.2 name; the row that exists is `slots`: guard auto-allow list' },
]);
const PENDING_MAX = 7; // lower it with every entry removed; never raise it

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS = '([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)';
const STARTS = {
  template: '\\{\\{bin\\}\\} ',
  markdown: `\`${esc(names.bin)} `,
  source: "(?:\\\\`|')\\$\\{(?:names\\.)?(?:bin|BIN)\\} ",
};

// The command words of every reference in `text` of the given kind (template | markdown | source).
function references(text, kind) {
  return [...String(text).matchAll(new RegExp(`${STARTS[kind]}${WORDS}`, 'g'))].map((m) => m[1].split(' '));
}

const isPrefix = (name, words) => name.split(' ').every((w, k) => words[k] === w);
// Findings for [{ where, words }]: references that no row and no pending entry resolve.
function unresolved(refs, { commands = COMMANDS, pending = PENDING } = {}) {
  return refs.filter((r) => !commands.some((c) => isPrefix(c.name, r.words)) && !pending.some((p) => isPrefix(p.name, r.words)))
    .map((r) => `${r.where}: \`${names.bin} ${r.words.join(' ')}\` names no command`);
}

const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const rel = (p) => relative(pluginDir, p).split('\\').join('/');

// Every reference of the scanned sources, with where it was found.
function scanned() {
  const files = [
    ...walk(join(pluginDir, 'templates')).map((f) => [f, 'template']),
    ...walk(join(pluginDir, 'skills')).filter((f) => f.endsWith('.md')).map((f) => [f, 'markdown']),
    ...walk(join(pluginDir, 'agents')).filter((f) => f.endsWith('.md')).map((f) => [f, 'markdown']),
    ...['loop', 'hooks', 'guard'].flatMap((u) => walk(join(pluginDir, 'lib', u)).filter((f) => f.endsWith('.mjs')).map((f) => [f, 'source'])),
  ];
  const refs = [];
  for (const [file, kind] of files) for (const words of references(readFileSync(file, 'utf8'), kind)) refs.push({ where: rel(file), words });
  for (const name of OWN_COMMANDS) refs.push({ where: 'lib/guard/allow.mjs OWN_COMMANDS', words: name.split(' ') });
  return { files, refs };
}

test('the checker finds a command a fixture skill names that the table lacks, and passes the commands it has', () => {
  const skill = `# Fixture\n\n1. Run \`${names.bin} doctor --json\`, then \`${names.bin} rule COD-1\` and \`${names.bin} gen apply\`.\n2. Run \`${names.bin} frobnicate --now\` and \`${names.bin} task explode T-AB-1\`.\n3. Prose about the ${names.bin} loop is no reference; neither is \`${names.bin}\` alone or \`${names.bin} --help\`.\n`;
  const refs = references(skill, 'markdown').map((words) => ({ where: 'skills/fixture/SKILL.md', words }));
  assert.deepEqual(refs.map((r) => r.words.join(' ')), ['doctor', 'rule', 'gen apply', 'frobnicate', 'task explode']);
  assert.deepEqual(unresolved(refs), [
    `skills/fixture/SKILL.md: \`${names.bin} frobnicate\` names no command`,
    `skills/fixture/SKILL.md: \`${names.bin} task explode\` names no command`,
  ]);
  // The other kinds: a template placeholder in any context, a source code span or quoted hint, not a template literal.
  assert.deepEqual(references('run: npx x {{bin}} decisions check\n# by `{{bin}} gen apply`', 'template').map((w) => w.join(' ')), ['decisions check', 'gen apply']);
  const src = 'const a = `run \\`${bin} tick\\` now`; const b = `\'${names.bin} loop stop\' ends it`; const c = `${bin} executor rules`; const d = `the ${bin} loop ended`;';
  assert.deepEqual(references(src, 'source').map((w) => w.join(' ')), ['tick', 'loop stop']);
  // A pending entry resolves its own words and longer ones only.
  assert.deepEqual(unresolved([{ where: 'x', words: ['exec', '--task'] }, { where: 'x', words: ['execute'] }]), [`x: \`${names.bin} execute\` names no command`]);
});

test('every command the templates, skills, agents, loop steps, hook messages and the guard allow list name is a row', () => {
  const { files, refs } = scanned();
  // Not vacuous: each source holds references, and the known ones are among them.
  for (const part of ['templates/', 'skills/', 'agents/', 'lib/loop/', 'lib/hooks/', 'lib/guard/']) {
    assert.ok(files.some(([f]) => rel(f).startsWith(part)), `${part} scanned`);
    assert.ok(refs.some((r) => r.where.startsWith(part)), `${part}: references found`);
  }
  const has = (part, name) => refs.some((r) => r.where.startsWith(part) && isPrefix(name, r.words));
  for (const [part, name] of [['templates/', 'gen apply'], ['templates/', 'decisions check'], ['skills/', 'rule'], ['agents/', 'rule'], ['lib/loop/', 'task set'],
    ['lib/loop/', 'brief'], ['lib/loop/', 'verify'], ['lib/hooks/', 'tick'], ['lib/guard/', 'decisions supersede']]) assert.ok(has(part, name), `${part}: names ${name}`);
  assert.ok(OWN_COMMANDS.length >= 10, 'the allow list is scanned');
  assert.deepEqual(unresolved(refs), []);
});

test('PENDING only shrinks: each entry is still no row, something still names it, and the list stays within its cap', () => {
  const { refs } = scanned();
  assert.ok(PENDING.length <= PENDING_MAX, `PENDING has ${PENDING.length} entries; the cap is ${PENDING_MAX}`);
  for (const p of PENDING) {
    assert.ok(!COMMANDS.some((c) => c.name === p.name || isPrefix(c.name, p.name.split(' '))), `${p.name} is a row now: remove it from PENDING`);
    assert.ok(refs.some((r) => isPrefix(p.name, r.words)), `nothing names ${p.name} any more: remove it from PENDING`);
    assert.ok(p.why.length > 0, `${p.name}: why it is pending`);
  }
  assert.equal(new Set(PENDING.map((p) => p.name)).size, PENDING.length, 'no entry twice');
});
