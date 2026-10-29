// `<bin> rule <ID…>` and `<bin> rule --core` (spec §7.15, §8.2): method rules by ID, read from method/index.json
// and the topic files through lib/method. --core prints the rules tagged [always]; a retired ID prints its
// redirect and the successor; a malformed or unknown ID exits 2 USAGE with a hint (the rules found are still
// printed). lib/method also owns pack resolution (activePacks); the index generator imports it from there.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// No test here touches the real HOME: the launcher runs with a throwaway HOME, without the calling session
// (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

function locate() {
  const plugins = join(root, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json, found ${hits.length}`);
  const dir = join(plugins, hits[0]);
  return { pluginDir: dir, names: readJson(join(dir, 'lib', 'name.json')) };
}
const { pluginDir, names } = locate();
const METHOD = join(pluginDir, 'method');
const index = readJson(join(METHOD, 'index.json'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const cli = (args, { launcher = join(pluginDir, 'bin', names.bin) } = {}) => spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', timeout: 30000 });

// The printed form of a rule: "<ID>. <text>", without the bold markers and the [always] tag.
const lineOf = (dir, idx, id) => readFileSync(join(dir, idx.rules[id].file), 'utf8').split('\n')[idx.rules[id].line - 1];
const printed = (dir, idx, id) => lineOf(dir, idx, id).replace(/^\*\*([A-Z]{3}-\d+)\.\*\* (?:\[always\] )?/, '$1. ');

function envelope(r) {
  assert.equal(r.stderr, '', `--json keeps stderr empty\n${out(r)}`);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, `one envelope line\n${out(r)}`);
  const env = JSON.parse(lines[0]);
  assert.equal(env.command, 'rule');
  assert.equal(env.code, r.status);
  for (const e of env.errors) assert.ok(e.hint.length > 0 && e.hint.length <= 200, `hint present and ≤ 200: ${JSON.stringify(e)}`);
  return env;
}

test('rule <ID…> prints each rule line in the order given; --json lists them with topic, section and pack', () => {
  const ids = ['FLW-8', 'COD-1', 'ORC-3'];
  const r = cli(['rule', ...ids]);
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, ids.map((id) => `${printed(METHOD, index, id)}\n`).join(''));
  assert.equal(r.stderr, '');
  const env = envelope(cli(['rule', ...ids, '--json']));
  assert.deepEqual([env.ok, env.exit, env.errors], [true, 'OK', []]);
  assert.deepEqual(env.data.rules.map((x) => x.id), ids);
  const cod1 = env.data.rules[1];
  const meta = index.rules['COD-1'];
  assert.deepEqual({ topic: cod1.topic, section: cod1.section, pack: cod1.pack, file: cod1.file, line: cod1.line }, { topic: meta.topic, section: meta.section, pack: meta.pack, file: meta.file, line: meta.line });
  assert.equal(`COD-1. ${cod1.text}`, printed(METHOD, index, 'COD-1'));
  assert.equal(cod1.retired, false);
  // Lower-case IDs are accepted; a repeated ID prints once.
  const again = cli(['rule', 'cod-1', 'COD-1']);
  assert.equal(again.status, 0, out(again));
  assert.equal(again.stdout, `${printed(METHOD, index, 'COD-1')}\n`);
  // A pack rule is found like a core rule.
  const packRule = Object.keys(index.rules).find((id) => index.rules[id].pack !== 'core' && !index.rules[id].retired);
  const p = envelope(cli(['rule', packRule, '--json']));
  assert.equal(p.data.rules[0].pack, index.rules[packRule].pack);
});

test('rule --core prints exactly the [always] set, without the tag', () => {
  assert.ok(index.always.length >= 1, 'the method has an always set');
  const r = cli(['rule', '--core']);
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, index.always.map((id) => `${printed(METHOD, index, id)}\n`).join(''));
  assert.doesNotMatch(r.stdout, /\[always\]|\*\*/);
  const env = envelope(cli(['rule', '--core', '--json']));
  assert.deepEqual(env.data.rules.map((x) => x.id), index.always);
  assert.ok(env.data.rules.every((x) => x.always === true && x.pack === 'core'));
  // --core with IDs: the always set first, then the IDs not already printed.
  const both = envelope(cli(['rule', '--core', 'COD-1', index.always[0], '--json']));
  assert.deepEqual(both.data.rules.map((x) => x.id), [...index.always, ...(index.always.includes('COD-1') ? [] : ['COD-1'])]);
});

test('rule: an unknown ID exits 2 with a hint naming the valid range; the rules found are still printed', () => {
  const max = Math.max(...Object.keys(index.rules).filter((id) => id.startsWith('COD-')).map((id) => Number(id.slice(4))));
  const r = cli(['rule', 'COD-1', 'COD-999']);
  assert.equal(r.status, 2, out(r));
  assert.equal(r.stdout, `${printed(METHOD, index, 'COD-1')}\n`, 'found rules on stdout');
  assert.match(r.stderr, new RegExp(`^${names.bin}: unknown rule ID: COD-999\\n  hint: .*COD-1 to COD-${max}`, 'm'));
  const env = envelope(cli(['rule', 'COD-1', 'COD-999', '--json']));
  assert.deepEqual([env.ok, env.exit], [false, 'USAGE']);
  assert.equal(env.data.partial, true);
  assert.deepEqual(env.data.rules.map((x) => x.id), ['COD-1']);
  assert.deepEqual(env.errors.map((e) => e.code), ['unknown-rule']);
  assert.match(env.errors[0].hint, new RegExp(`COD-1 to COD-${max}`));
  // An unknown prefix: the hint lists the prefixes of the method.
  const prefix = envelope(cli(['rule', 'ZZZ-1', '--json']));
  assert.equal(prefix.code, 2);
  assert.deepEqual(prefix.data.rules, []);
  assert.match(prefix.errors[0].hint, /COD/);
  assert.match(prefix.errors[0].hint, /FLW/);
});

test('rule: a malformed ID or no ID at all exits 2 with a hint', () => {
  for (const bad of ['foo', 'COD7', 'COD-', 'COD-1x', 'CODE-1']) {
    const env = envelope(cli(['rule', bad, '--json']));
    assert.equal(env.code, 2, bad);
    assert.equal(env.errors[0].code, 'invalid-rule-id', bad);
    assert.match(env.errors[0].hint, /COD-7/, bad);
  }
  const none = envelope(cli(['rule', '--json']));
  assert.equal(none.code, 2);
  assert.equal(none.errors[0].code, 'missing-argument');
  assert.match(none.errors[0].hint, /--core/);
  const text = cli(['rule']);
  assert.equal(text.status, 2, out(text));
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /usage: /);
});

test('rule: a 1.x rule ID is not a rule here; its hint names the successor from the legacy table', () => {
  const legacy = readJson(join(METHOD, 'legacy-ids.json')).rules;
  const shared = new Set(index.legacyPrefixesShared);
  const [old, target] = Object.entries(legacy).find(([id, t]) => t.core && !shared.has(id.slice(0, 3)));
  const env = envelope(cli(['rule', old, '--json']));
  assert.equal(env.code, 2, old);
  assert.equal(env.errors[0].code, 'unknown-rule');
  assert.match(env.errors[0].hint, new RegExp(`1\\.x.*${target.core}`));
  const [retiredOld] = Object.entries(legacy).find(([id, t]) => 'retired' in t && !shared.has(id.slice(0, 3)));
  const retired = envelope(cli(['rule', retiredOld, '--json']));
  assert.match(retired.errors[0].hint, /1\.x.*retired/);
});

// A plugin copy outside the repository whose method has a tombstone: the launcher reads the method next to
// itself, and a retired ID prints its redirect followed by the successor.
test('rule: a retired ID prints "Retired → <ID>." and the successor; a stale index is an internal error', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'rule-copy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  cpSync(pluginDir, base, { recursive: true });
  const dir = join(base, 'method');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const topic = ['# Alpha', '', '**Purpose:** p. **Reads:** r. **When:** w.', '', '**Section map**', '- §One — what.', '', '## Core', '',
    '### One', '**ALP-1.** [always] Do the first thing.', '**ALP-2.** Retired → ALP-3.', '**ALP-3.** MUST do the third thing.', '**ALP-4.** Retired.', ''].join('\n');
  writeFileSync(join(dir, 'alpha.md'), topic);
  // The index comes from the real generator, so the fixture has the committed shape.
  const gen = spawnSync(process.execPath, [join(root, 'scripts', 'gen-method-index.mjs'), '--dir', dir], { encoding: 'utf8' });
  assert.equal(gen.status, 0, out(gen));
  const idx = readJson(join(dir, 'index.json'));
  const launcher = join(base, 'bin', names.bin);

  const r = cli(['rule', 'ALP-2'], { launcher });
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, `ALP-2. Retired → ALP-3.\n${printed(dir, idx, 'ALP-3')}\n`);
  const env = envelope(cli(['rule', 'ALP-2', '--json'], { launcher }));
  assert.deepEqual(env.data.rules.map((x) => [x.id, x.retired, x.redirect]), [['ALP-2', true, 'ALP-3'], ['ALP-3', false, null]]);
  assert.equal(env.data.rules[1].must, true);
  const bare = envelope(cli(['rule', 'ALP-4', '--json'], { launcher }));
  assert.deepEqual([bare.code, bare.data.rules.map((x) => [x.id, x.retired, x.redirect])], [0, [['ALP-4', true, null]]]);
  const core = cli(['rule', '--core'], { launcher });
  assert.equal(core.stdout, 'ALP-1. Do the first thing.\n');

  // index.json pointing at a line that does not hold the rule: a broken copy, not a usage error.
  writeFileSync(join(dir, 'alpha.md'), topic.replace('**ALP-1.** [always] Do the first thing.\n', '\n**ALP-1.** [always] Do the first thing.'));
  const stale = cli(['rule', 'ALP-1', '--json'], { launcher });
  assert.equal(stale.status, 70, out(stale));
  assert.match(JSON.parse(stale.stdout).errors[0].message, /index/);
});

test('rule: help comes from the command table; the row is read-only', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const row = COMMANDS.find((x) => x.name === 'rule');
  assert.ok(row && !row.hidden && !row.mutating, 'rule: public, read-only');
  assert.deepEqual(row.exits, ['OK', 'USAGE']);
  assert.deepEqual(row.flags.map((f) => f.flag), ['--core']);
  const help = cli(['rule', '--help']);
  assert.equal(help.status, 0, out(help));
  assert.match(help.stdout, new RegExp(`^usage: ${names.bin} rule \\[<id…>\\] \\[--core\\] \\[--json\\]\\n`));
  assert.match(cli(['--help']).stdout, /^ {2}rule {2,}\S/m);
});

test('lib/method: lookup, unknown IDs and pack resolution; the generator imports activePacks from it', async () => {
  const method = await lib('method/index.mjs');
  const m = method.openMethod();
  assert.deepEqual(m.index, index);
  const { rules, unknown } = method.lookupRules(m, ['COD-3', 'NOPE-1', 'COD-999']);
  assert.deepEqual(rules.map((x) => x.id), ['COD-3']);
  assert.equal(rules[0].always, true);
  assert.doesNotMatch(rules[0].text, /\[always\]/);
  assert.deepEqual(unknown.map((u) => u.id), ['NOPE-1', 'COD-999']);
  assert.equal(method.RULE_ID.test('COD-7'), true);
  assert.equal(method.RULE_ID.test('cod-7'), false);
  // Pack resolution lives in lib/method; the generator re-exports the same function.
  const gen = await import(pathToFileURL(join(root, 'scripts', 'gen-method-index.mjs')).href);
  assert.equal(gen.activePacks, method.activePacks);
  assert.deepEqual(method.activePacks(index.packs, { tier: 'L2' }), ['team']);
  assert.deepEqual(method.activePacks(index.packs, { dataSensitivity: 'banana' }), ['security']);
  assert.match(readFileSync(join(root, 'scripts', 'gen-method-index.mjs'), 'utf8'), /lib', 'method'/, 'the generator loads lib/method');
  assert.doesNotMatch(readFileSync(join(root, 'scripts', 'gen-method-index.mjs'), 'utf8'), /function activePacks/, 'no second copy of activePacks');
});

test('OWASP, LLM and agent rules resolve by ID and the ai pack activates on the llm fact', async () => {
  const r = cli(['rule', 'OWA-1', 'OWA-10', 'LLM-1', 'LLM-10', 'AGT-1', 'AGT-10', 'SEC-13', 'SEC-14', 'SCD-23']);
  assert.equal(r.status, 0, out(r));
  for (const id of ['OWA-1', 'OWA-10', 'LLM-1', 'LLM-10', 'AGT-1', 'AGT-10', 'SEC-13', 'SEC-14', 'SCD-23']) assert.match(r.stdout, new RegExp(`${id}\\. `));
  const { activePacks: active } = await lib('method/index.mjs');
  assert.ok(active(index.packs, { llm: true }).includes('ai'));
  assert.ok(!active(index.packs, { llm: false }).includes('ai'));
  assert.ok(!active(index.packs, {}).includes('ai'));
  assert.ok(index.packs.security.topics.includes('packs/security/owasp'));
});
