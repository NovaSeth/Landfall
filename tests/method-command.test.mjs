// `<bin> method <pack|section>` (spec §7.15, §8.2): one pack or one section of the method by name, read from
// method/index.json and the topic files through lib/method (the counterpart of `rule`). A pack is a key of the index
// "packs" table; a section is "<topic>/<section slug>" (slugs repeat across topics). An unknown name exits 2 with
// the list of names. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = readJson(join(pluginDir, 'lib', 'name.json'));
const METHOD = join(pluginDir, 'method');
const index = readJson(join(METHOD, 'index.json'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const cli = (args) => spawnSync(process.execPath, [join(pluginDir, 'bin', names.bin), ...args], { encoding: 'utf8', timeout: 30000 });

// The printed form of a rule, straight from its topic file: "<ID>. <text>" without the bold markers and the tag.
const printed = (id) => readFileSync(join(METHOD, index.rules[id].file), 'utf8').split('\n')[index.rules[id].line - 1]
  .replace(/^\*\*([A-Z]{3}-\d+)\.\*\* (?:\[always\] )?/, '$1. ');
const sectionsOf = (topic) => index.topics[topic].sections.map((s) => ({ topic, ...s }));
// The expected text of a list of sections: a heading per section, then its rule lines in index order.
const render = (sections) => sections.map((s) => [`## ${index.topics[s.topic].title} › ${s.name} (${s.topic}/${s.slug})`, ...s.rules.map(printed)].join('\n')).join('\n\n');

function envelope(r) {
  assert.equal(r.stderr, '', `--json keeps stderr empty\n${out(r)}`);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, `one envelope line\n${out(r)}`);
  const env = JSON.parse(lines[0]);
  assert.equal(env.command, 'method');
  assert.equal(env.code, r.status);
  return env;
}

test('method <pack>: every section of every topic of the pack, with each rule line in index order', () => {
  const pack = 'team';
  const sections = index.packs[pack].topics.flatMap(sectionsOf);
  assert.ok(sections.length >= 5, 'the pack has sections');
  const r = cli(['method', pack]);
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, `Pack ${pack} (when: ${index.packs[pack].when})\n\n${render(sections)}\n`);
  const env = envelope(cli(['method', pack, '--json']));
  assert.deepEqual([env.ok, env.data.kind, env.data.name, env.data.when], [true, 'pack', pack, index.packs[pack].when]);
  assert.deepEqual(env.data.sections.map((s) => s.name), sections.map((s) => `${s.topic}/${s.slug}`));
  assert.deepEqual(env.data.sections.flatMap((s) => s.rules.map((x) => x.id)), sections.flatMap((s) => s.rules));
});

test('method <topic>/<section>: only that section; a slug shared by two topics is told apart by its topic', () => {
  const [one] = sectionsOf('coding');
  const r = cli(['method', `coding/${one.slug}`]);
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, `${render([one])}\n`);
  // "roles" is a section of both orchestration and principles
  const shared = ['orchestration', 'principles'].map((t) => sectionsOf(t).find((s) => s.slug === 'roles'));
  assert.ok(shared.every(Boolean), 'both topics have a roles section');
  const a = envelope(cli(['method', 'orchestration/roles', '--json']));
  const b = envelope(cli(['method', 'principles/roles', '--json']));
  assert.deepEqual(a.data.sections.map((s) => s.rules.map((x) => x.id)), [shared[0].rules]);
  assert.deepEqual(b.data.sections.map((s) => s.rules.map((x) => x.id)), [shared[1].rules]);
  assert.equal(a.data.kind, 'section');
  // A rule's text is the one `rule` prints for the same ID.
  const viaRule = cli(['rule', ...shared[0].rules]);
  assert.equal(viaRule.status, 0, out(viaRule));
  assert.equal(cli(['method', 'orchestration/roles']).stdout, `## ${index.topics.orchestration.title} › ${shared[0].name} (orchestration/roles)\n${viaRule.stdout}`);
});

test('method: an unknown name exits 2 with every pack and section name; a bare slug or topic is not a name', async () => {
  const { partNames, openMethod } = await lib('method/index.mjs');
  const all = partNames(openMethod());
  assert.deepEqual(all.packs, Object.keys(index.packs));
  assert.deepEqual(all.sections, Object.entries(index.topics).flatMap(([t, v]) => v.sections.map((s) => `${t}/${s.slug}`)));
  for (const name of ['frobnicate', 'roles', 'coding', 'Team']) {
    const r = cli(['method', name, '--json']);
    assert.equal(r.status, 2, `${name}\n${out(r)}`);
    const env = envelope(r);
    assert.deepEqual([env.ok, env.exit, env.errors[0].code], [false, 'USAGE', 'unknown-method-name']);
    assert.ok(env.errors[0].hint.length > 0 && env.errors[0].hint.length <= 200, env.errors[0].hint);
    assert.deepEqual(env.data.names, all, `${name}: data.names lists every name`);
  }
  const text = cli(['method', 'frobnicate']);
  assert.equal(text.status, 2, out(text));
  assert.match(text.stderr, /unknown pack or section: frobnicate/);
  for (const p of all.packs) assert.ok(text.stdout.includes(p), `text lists pack ${p}`);
  for (const s of all.sections) {
    const [topic, slug] = [s.slice(0, s.lastIndexOf('/')), s.slice(s.lastIndexOf('/') + 1)];
    assert.match(text.stdout, new RegExp(`^  ${topic}/: .*\\b${slug}\\b`, 'm'), `text lists section ${s}`);
  }
  const missing = cli(['method', '--json']);
  assert.equal(missing.status, 2, out(missing));
  assert.equal(envelope(missing).errors[0].code, 'missing-argument');
});
