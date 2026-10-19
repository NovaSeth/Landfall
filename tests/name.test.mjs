// Codename single source (SD-30, REV-54): plugins/<plugin>/lib/name.json holds every name the plugin is
// published under; scripts/gen-names.mjs generates the manifests and the package.json bin entry from it.
// This file never spells the codename: it reads it from name.json, so a rename needs no edit here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// npm and git run with a throwaway HOME and global config, without the npm_* variables of `npm test` (e.g.
// npm_config_dry_run) or the calling session (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEN = join(root, 'scripts', 'gen-names.mjs');
const KEYS = ['bin', 'claimRefPrefix', 'codename', 'displayName', 'envPrefix', 'marketplace', 'plugin', 'repository', 'stateDir'];
// 1.x test tooling predating the constant (temp-dir prefixes, the CI required-tools switch). Shrink only:
// lower it when a 1.x suite is replaced; never raise it.
const LEGACY_MAX = 38;
// Paths added for v2: no codename literal at all, not even within the legacy budget.
const V2_SURFACE = /^(plugins\/|\.claude-plugin\/|scripts\/gen-|tests\/e2e\/|tests\/(name|architecture|cli-contract|context-cost|method[\w-]*)\.test\.mjs$)/;

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const gen = (args) => run(process.execPath, [GEN, ...args]);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const git = (cwd, args) => {
  const r = run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
// CI sets <envPrefix>REQUIRE_TOOLS=1: a missing tool is a failure there, not a silent skip.
const missingTool = (t, names, why) => {
  if (process.env[`${names.envPrefix}REQUIRE_TOOLS`]) assert.fail(`${why} (${names.envPrefix}REQUIRE_TOOLS)`);
  t.skip(why);
};

// The plugin directory is found through name.json itself, so this test holds no plugin path.
function locate(dir) {
  const plugins = join(dir, 'plugins');
  const hits = existsSync(plugins)
    ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')))
    : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json in ${dir}, found ${hits.length}`);
  const pluginRel = `plugins/${hits[0]}`;
  return { pluginRel, nameRel: `${pluginRel}/lib/name.json`, names: readJson(join(dir, pluginRel, 'lib', 'name.json')) };
}

// Plugin components rendered by gen-names: skills/<name>/SKILL.md and agents/<name>.md.
function generatedComponents(dir, pluginRel) {
  const at = (rel) => join(dir, pluginRel, rel);
  const skills = existsSync(at('skills')) ? readdirSync(at('skills')).filter((d) => existsSync(at(`skills/${d}/SKILL.md`))).map((d) => `${pluginRel}/skills/${d}/SKILL.md`) : [];
  const agents = existsSync(at('agents')) ? readdirSync(at('agents')).filter((f) => f.endsWith('.md')).map((f) => `${pluginRel}/agents/${f}`) : [];
  return [...skills, ...agents];
}

// A codename occurrence is the literal, in any case, not glued to another letter or digit
// ("macaw" is not one; "NAME_X" and "name-y" are).
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (text, codename) => (text.match(new RegExp(`(?<![A-Za-z0-9])${escape(codename)}(?![A-Za-z0-9])`, 'gi')) ?? []).length;

function trackedFiles(dir) {
  const r = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter((p) => p && existsSync(join(dir, p)) && statSync(join(dir, p)).isFile());
}

test('name.json holds exactly the published names and names the plugin directory (SD-30)', () => {
  const { pluginRel, names } = locate(root);
  assert.deepEqual(Object.keys(names).sort(), KEYS);
  for (const k of KEYS) assert.ok(typeof names[k] === 'string' && names[k].length > 0, `${k}: non-empty string`);
  assert.equal(pluginRel, `plugins/${names.plugin}`, 'the plugin directory is named after name.json "plugin"');
});

// `repository` is the npx source of the plugin CLI from other harnesses and CI (SD-21, SD-39): a GitHub spec
// whose owner is the marketplace owner the generator writes.
test('name.json repository is github:<owner>/<repo> with the marketplace owner', () => {
  const { names } = locate(root);
  const m = /^github:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(names.repository);
  assert.ok(m, `repository: ${names.repository}`);
  assert.equal(m[1], readJson(join(root, '.claude-plugin', 'marketplace.json')).owner.name, 'the owner of the marketplace');
});

test('generated files match name.json (gen-names --check exits 0)', () => {
  const r = gen(['--check']);
  assert.equal(r.status, 0, out(r));
});

test('generated manifests parse and carry the names from name.json (REV-56)', () => {
  const { pluginRel, names } = locate(root);
  const pkg = readJson(join(root, 'package.json'));
  const market = readJson(join(root, '.claude-plugin', 'marketplace.json'));
  assert.equal(market.name, names.marketplace);
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[names.plugin, `./${pluginRel}`]]);
  const manifest = readJson(join(root, pluginRel, '.claude-plugin', 'plugin.json'));
  assert.equal(manifest.name, names.plugin);
  assert.equal(manifest.version, pkg.version, 'plugin version comes from package.json (one source)');
  assert.equal(manifest.license, pkg.license);
  assert.equal(typeof readJson(join(root, pluginRel, 'settings.json')), 'object');
  // npx channel: the launcher is the only package bin.
  const launcher = `${pluginRel}/bin/${names.bin}`;
  assert.deepEqual(pkg.bin, { [names.bin]: launcher });
  assert.ok(statSync(join(root, launcher)).mode & 0o111, `${launcher} is executable`);
  assert.match(readFileSync(join(root, launcher), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('npm pack ships the plugin launcher and the files it reads', (t) => {
  const { pluginRel, names } = locate(root);
  if (run('npm', ['--version']).status !== 0) return missingTool(t, names, 'npm not on PATH');
  const r = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, timeout: 120000 });
  assert.equal(r.status, 0, out(r));
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const f of [`${pluginRel}/bin/${names.bin}`, `${pluginRel}/.claude-plugin/plugin.json`, `${pluginRel}/lib/name.json`]) {
    assert.ok(files.includes(f), `${f} missing from the npm package`);
  }
});

// Final rename (I27) = edit name.json + run the generator. Both generator write modes: tracked files
// (git mv keeps history) and a plain directory (filesystem rename).
for (const mode of ['git', 'plain']) {
  test(`regenerating after a codename change rewrites every generated file and moves the plugin (${mode})`, () => {
    const { pluginRel, names: old } = locate(root);
    const fixture = mkdtempSync(join(tmpdir(), 'names-'));
    for (const p of ['package.json', '.claude-plugin', pluginRel]) cpSync(join(root, p), join(fixture, p), { recursive: true });
    const pkgBefore = readJson(join(fixture, 'package.json'));
    if (mode === 'git') { git(fixture, ['init', '-q']); git(fixture, ['add', '-A']); git(fixture, ['commit', '-qm', 'base']); }
    const fresh = { codename: 'zzq', displayName: 'Zzq', plugin: 'zzq', marketplace: 'zzq-plugins', bin: 'zzq', stateDir: '.zzq', envPrefix: 'ZZQ_', claimRefPrefix: 'zzq/claim/', repository: old.repository };
    writeFileSync(join(fixture, pluginRel, 'lib', 'name.json'), JSON.stringify(fresh, null, 2) + '\n');

    const stale = gen(['--check', '--root', fixture]);
    assert.equal(stale.status, 1, `--check must fail on a stale tree\n${out(stale)}`);
    const write = gen(['--root', fixture]);
    assert.equal(write.status, 0, out(write));
    const again = gen(['--check', '--root', fixture]);
    assert.equal(again.status, 0, `--check after regeneration\n${out(again)}`);

    const now = locate(fixture);
    assert.equal(now.pluginRel, 'plugins/zzq');
    assert.ok(!existsSync(join(fixture, pluginRel)), `${pluginRel} moved away`);
    assert.deepEqual(readdirSync(join(fixture, 'plugins/zzq/bin')), ['zzq']);
    const market = readJson(join(fixture, '.claude-plugin', 'marketplace.json'));
    assert.equal(market.name, 'zzq-plugins');
    assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['zzq', './plugins/zzq']]);
    assert.equal(readJson(join(fixture, 'plugins/zzq/.claude-plugin/plugin.json')).name, 'zzq');
    const pkg = readJson(join(fixture, 'package.json'));
    assert.deepEqual(pkg.bin, { zzq: 'plugins/zzq/bin/zzq' });
    assert.deepEqual({ ...pkg, bin: null }, { ...pkgBefore, bin: null }, 'only the bin entry of package.json is generated');
    if (mode === 'git') {
      const moves = git(fixture, ['diff', '--cached', '--name-status', '-M']);
      assert.match(moves, new RegExp(`^R100\\t${escape(`${pluginRel}/bin/${old.bin}`)}\\tplugins/zzq/bin/zzq$`, 'm'), moves);
    }
    // Every skill and agent names the CLI, now by the new name.
    const components = generatedComponents(fixture, 'plugins/zzq');
    assert.ok(components.length > 0, 'the fixture has generated skills and agents');
    for (const f of components) assert.ok(occurrences(readFileSync(join(fixture, f), 'utf8'), 'zzq') > 0, `${f} names the CLI with the new name`);
    // Nothing published still carries the old codename.
    const plainFiles = ['package.json', '.claude-plugin/marketplace.json', 'plugins/zzq/.claude-plugin/plugin.json', 'plugins/zzq/settings.json', 'plugins/zzq/bin/zzq', 'plugins/zzq/hooks/hooks.json', ...components];
    for (const f of (mode === 'git' ? trackedFiles(fixture) : plainFiles)) {
      assert.equal(occurrences(readFileSync(join(fixture, f), 'utf8'), old.codename), 0, `${f} still holds the old codename`);
      assert.equal(occurrences(f, old.codename), 0, `path ${f} still holds the old codename`);
    }
  });
}

test('settings.json is generated: the agent panel rows run through the launcher', () => {
  const { pluginRel, names } = locate(root);
  assert.deepEqual(readJson(join(root, pluginRel, 'settings.json')), { subagentStatusLine: { type: 'command', command: `\${CLAUDE_PLUGIN_ROOT}/bin/${names.bin} ui rows` } });
});

test('gen-names: invalid name.json and unknown flags exit 2', () => {
  const { pluginRel } = locate(root);
  const fixture = mkdtempSync(join(tmpdir(), 'names-bad-'));
  for (const p of ['package.json', '.claude-plugin', pluginRel]) cpSync(join(root, p), join(fixture, p), { recursive: true });
  const nameFile = join(fixture, pluginRel, 'lib', 'name.json');
  const good = readJson(nameFile);
  for (const bad of [{ ...good, bin: 'Bad Name' }, { ...good, extra: 'x' }, (({ stateDir, ...rest }) => rest)(good), { ...good, repository: 'https://github.com/a/b' }, (({ repository, ...rest }) => rest)(good)]) {
    writeFileSync(nameFile, JSON.stringify(bad));
    const r = gen(['--root', fixture]);
    assert.equal(r.status, 2, out(r));
  }
  assert.equal(gen(['--frobnicate']).status, 2);
});

test('occurrence counter: the literal in any case, never inside another word', () => {
  assert.equal(occurrences('macazzq zzq ZZQ_X zzq-y xzzq zzqx "zzq/claim/"', 'zzq'), 4);
});

const USER_DOCS = /^(README|CHANGELOG|CLAUDE)\.md$|^docs\/known-limitations\.md$/;

test('the codename literal appears only in name.json and generated files (SD-30)', () => {
  const { pluginRel, nameRel, names } = locate(root);
  // Skills and agents are rendered from templates/{skills,agents} (gen-names --check above proves each is exactly
  // the generator's output, and a file there without a source is an error).
  const whollyGenerated = new Set([nameRel, '.claude-plugin/marketplace.json', `${pluginRel}/.claude-plugin/plugin.json`, `${pluginRel}/hooks/hooks.json`, `${pluginRel}/settings.json`, 'docs/cli.md',
    ...generatedComponents(root, pluginRel)]);
  const found = [];
  let legacy = 0;
  for (const f of trackedFiles(root)) {
    const buf = readFileSync(join(root, f));
    // User documentation names the CLI on purpose; the final rename rewrites it with the rest of the prose.
    if (buf.includes(0) || whollyGenerated.has(f) || USER_DOCS.test(f)) continue;
    let text = buf.toString('utf8');
    if (f === 'package.json') { const pkg = JSON.parse(text); delete pkg.bin[names.bin]; text = JSON.stringify(pkg); }
    const n = occurrences(text, names.codename);
    const inPath = f.startsWith(`${pluginRel}/`) ? 0 : occurrences(f, names.codename);
    if (n + inPath === 0) continue;
    if (V2_SURFACE.test(f) || inPath) found.push(`${f}: ${n} in content, ${inPath} in path`);
    else legacy += n;
  }
  assert.deepEqual(found, [], 'codename literal outside name.json and generated files');
  assert.ok(legacy <= LEGACY_MAX, `legacy 1.x occurrences grew: ${legacy} > ${LEGACY_MAX}`);
});
