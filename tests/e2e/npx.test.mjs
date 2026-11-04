// npx channel (REV-55, GC10): the package built by `npm pack` runs its launcher the way npx exposes it, a
// symlink in node_modules/.bin, under the Node running this test. CI also runs this file on Node 22.12.0, the lowest
// release of the declared floor: an extensionless file under "type":"module" must not fail
// (ERR_UNKNOWN_FILE_EXTENSION), so the plugin ships its own package.json declaring CommonJS for bin/ while lib/ stays .mjs. Offline: the package has no dependencies.
// Run: node --test tests/e2e/npx.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from '../helpers/isolated-env.mjs';

// No child of this file sees the real HOME or the calling session (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...opts });
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

function locate() {
  const plugins = join(root, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json, found ${hits.length}`);
  const dir = join(plugins, hits[0]);
  return { dir, rel: `plugins/${hits[0]}`, names: readJson(join(dir, 'lib', 'name.json')), version: readJson(join(dir, '.claude-plugin', 'plugin.json')).version };
}
const { dir: pluginDir, rel: pluginRel, names, version } = locate();

// npm and the launcher see the Node running this test first on PATH, the helper's throwaway HOME and npm cache
// (none of the npm_* variables `npm test` exports), and npm stays offline.
function channelEnv(t) {
  const iso = isolatedEnv();
  t.after(iso.cleanup);
  return { ...iso.env, PATH: `${dirname(process.execPath)}${delimiter}${iso.env.PATH}`, npm_config_offline: 'true' };
}
function missingTool(t, tool) {
  if (process.env[`${names.envPrefix}REQUIRE_TOOLS`]) assert.fail(`${tool} not on PATH (${names.envPrefix}REQUIRE_TOOLS)`);
  t.skip(`${tool} not on PATH`);
  return true;
}

// `npm pack` into a throwaway directory, unpacked next to the tarball.
function pack(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'npx-channel-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = channelEnv(t);
  if (run('npm', ['--version'], { env }).status !== 0) return missingTool(t, 'npm') && null;
  if (run('tar', ['--version'], { env }).status !== 0) return missingTool(t, 'tar') && null;
  const r = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', base], { cwd: root, env });
  assert.equal(r.status, 0, out(r));
  const tarball = join(base, JSON.parse(r.stdout)[0].filename);
  const unpacked = join(base, 'unpacked');
  mkdirSync(unpacked);
  const x = run('tar', ['-xzf', tarball, '-C', unpacked], { env });
  assert.equal(x.status, 0, out(x));
  return { base, env, tarball, pkg: join(unpacked, 'package') };
}

test(`npm pack ships the plugin with its own CommonJS package.json as the launcher's nearest (node ${process.version})`, (t) => {
  const p = pack(t);
  if (!p) return;
  const plugin = join(p.pkg, pluginRel);
  for (const f of ['package.json', `bin/${names.bin}`, 'lib/name.json', 'lib/cli/main.mjs', 'lib/cli/commands.mjs', 'lib/hooks/registry.mjs', 'hooks/hooks.json', '.claude-plugin/plugin.json']) {
    assert.ok(existsSync(join(plugin, f)), `${pluginRel}/${f} missing from the npm package`);
  }
  let nearest = join(plugin, 'bin');
  while (!existsSync(join(nearest, 'package.json'))) nearest = dirname(nearest);
  assert.equal(relative(p.pkg, nearest).split('\\').join('/'), pluginRel, 'nearest package.json above bin/ is the plugin one');
  assert.deepEqual(readJson(join(nearest, 'package.json')), { type: 'commonjs' });
  assert.equal(readJson(join(p.pkg, 'package.json')).type, 'module', 'the repository package stays ESM');
});

test(`the packed launcher runs through npx (symlink in node_modules/.bin), offline (node ${process.version})`, { timeout: 300000 }, (t) => {
  const p = pack(t);
  if (!p) return;
  const cwd = join(p.base, 'cwd');
  mkdirSync(cwd);
  const npx = (args) => run('npx', ['--yes', '--package', p.tarball, names.bin, ...args], { cwd, env: p.env });
  const v = npx(['--version']);
  assert.equal(v.status, 0, out(v));
  assert.equal(v.stdout, `${names.bin} ${version}\n`);
  const help = npx(['--help']);
  assert.equal(help.status, 0, out(help));
  assert.match(help.stdout, /^ {2}doctor {2,}\S/m);
  const json = npx(['--version', '--json']);
  assert.equal(json.status, 0, out(json));
  assert.deepEqual(JSON.parse(json.stdout).data, { name: names.bin, version });
  // npx ran the launcher through the symlink npm created.
  const links = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const q = join(d, f); const st = lstatSync(q); if (st.isSymbolicLink()) { if (f === names.bin && d.endsWith(join('node_modules', '.bin'))) links.push(q); } else if (st.isDirectory()) walk(q); } };
  walk(p.env.npm_config_cache);
  assert.ok(links.length > 0, 'node_modules/.bin symlink to the launcher in the npx cache');
});

test('the launcher resolves its real location when run through a symlink, as npx exposes it', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-link-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const launcher = join(pluginDir, 'bin', names.bin);
  const binDir = join(base, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const absolute = join(binDir, names.bin);
  symlinkSync(launcher, absolute);
  const relLink = join(base, 'rel-link');
  symlinkSync(relative(base, launcher), relLink);
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
  for (const [cmd, args] of [[process.execPath, [absolute, '--version']], [process.execPath, [relLink, '--version']], [absolute, ['--version']]]) {
    const r = run(cmd, args, { cwd: base, env });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${out(r)}`);
    assert.equal(r.stdout, `${names.bin} ${version}\n`);
  }
  const help = run(process.execPath, [absolute, 'doctor', '--help'], { cwd: base, env });
  assert.equal(help.status, 0, out(help));
});

test('CI runs this file on the lowest Node 22 LTS release, and npm test on Node 22 and 24', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'tests.yml'), 'utf8');
  const jobs = ci.split(/\n(?= {2}[\w-]+:\n)/);
  const npxJob = jobs.find((j) => /tests\/e2e\/npx\.test\.mjs/.test(j));
  assert.ok(npxJob, 'a CI job runs tests/e2e/npx.test.mjs');
  const pinned = /node-version:\s*['"]?22\.(\d+)\.\d+/.exec(npxJob);
  assert.ok(pinned && Number(pinned[1]) >= 12, `the npx job pins Node 22.x with x >= 12\n${npxJob}`);
  assert.match(ci, /node:\s*\[22,\s*24\]/, 'npm test runs on Node 22 and 24');
  assert.match(ci, /run:.*\bnpm test\b/);
});
