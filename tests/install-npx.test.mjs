// `install` (spec SD-3, §7.1 steps 1–2, §8.2 "npx channel only"): `npx --yes <package> install` runs the SD-3 commands when
// `claude` is on PATH (the one-command install, else the two-command fallback) and checks `claude plugin list --json`
// for the plugin enabled; without `claude` it prints exactly those commands and exits 0. It never writes a settings file
// (Claude Code writes its own records). The npm package carries the plugin, README, CHANGELOG and LICENSE only, and
// one bin. Offline: the package has no dependencies; a fake `claude` records its argv.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRel = (() => {
  const hits = readdirSync(join(root, 'plugins')).filter((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return `plugins/${hits[0]}`;
})();
const names = JSON.parse(readFileSync(join(root, pluginRel, 'lib', 'name.json'), 'utf8'));
const { main } = await import(pathToFileURL(join(root, pluginRel, 'lib', 'cli', 'main.mjs')).href);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...opts });
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

const source = names.repository.replace(/^github:/, '');
const id = `${names.plugin}@${names.marketplace}`;
const SD3 = [
  ['plugin', 'install', names.plugin, '--marketplace', source],
  ['plugin', 'marketplace', 'add', source],
  ['plugin', 'install', id],
];
const PRINTED = [
  '`claude` is not on PATH. Install the plugin from a terminal where it is:',
  `  claude ${SD3[0].join(' ')}`,
  'If that exits non-zero, add the marketplace, then install from it:',
  `  claude ${SD3[1].join(' ')}`,
  `  claude ${SD3[2].join(' ')}`,
  'Then type /reload-plugins in Claude Code (or restart it); that is the only manual step.',
  '',
].join('\n');

// A PATH with node, npm and npx only (never a claude that lives next to node), plus the system tools.
function nodeOnlyPath(base) {
  const bin = join(base, 'node-bin');
  mkdirSync(bin);
  for (const tool of ['node', 'npm', 'npx']) {
    const real = join(dirname(process.execPath), tool);
    if (existsSync(real)) symlinkSync(real, join(bin, tool));
  }
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}
// A fake claude recording each call's argv (one JSON line) in $FAKE_CLAUDE_LOG: `--marketplace <source>` exits
// $FAKE_PRIMARY_EXIT (default 0), `plugin list --json` prints $FAKE_CLAUDE_LIST, everything else exits 0.
function fakeClaude(base) {
  const dir = join(base, 'fake-bin');
  mkdirSync(dir);
  const file = join(dir, 'claude');
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\\n');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG + '.cwd', fs.realpathSync(process.cwd()) + '\\n');
if (argv.join(' ') === 'plugin list --json') { process.stdout.write(fs.readFileSync(process.env.FAKE_CLAUDE_LIST, 'utf8')); process.exit(0); }
if (argv.includes('--marketplace')) process.exit(Number(process.env.FAKE_PRIMARY_EXIT || 0));
process.exit(0);
`);
  chmodSync(file, 0o755);
  return dir;
}
const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function setup(t) {
  const iso = isolatedEnv({ prefix: 'install-npx-' });
  t.after(iso.cleanup);
  const base = iso.base;
  const path = nodeOnlyPath(base);
  const env = { ...iso.env, PATH: path, npm_config_offline: 'true', FAKE_CLAUDE_LOG: join(base, 'claude.log'), FAKE_CLAUDE_LIST: join(base, 'list.json') };
  writeFileSync(env.FAKE_CLAUDE_LIST, JSON.stringify([{ id, enabled: true, version: '9.9.9' }]));
  return { base, env, fake: fakeClaude(base) };
}
function pack(t, s) {
  if (run('npm', ['--version'], { env: s.env }).status !== 0) {
    if (process.env[`${names.envPrefix}REQUIRE_TOOLS`]) assert.fail(`npm not on PATH (${names.envPrefix}REQUIRE_TOOLS)`);
    t.skip('npm not on PATH');
    return null;
  }
  const dest = join(s.base, 'pack');
  mkdirSync(dest);
  const r = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dest], { cwd: root, env: s.env });
  assert.equal(r.status, 0, out(r));
  const info = JSON.parse(r.stdout)[0];
  return { tarball: join(dest, info.filename), files: info.files.map((f) => f.path) };
}

test('npm pack ships the plugin, README, CHANGELOG and LICENSE only, with exactly one bin (acceptance 7)', (t) => {
  const s = setup(t);
  const p = pack(t, s);
  if (!p) return;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { [names.bin]: `${pluginRel}/bin/${names.bin}` });
  for (const f of p.files) assert.ok(f.startsWith(`${pluginRel}/`) || ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'].includes(f), `unexpected file in the package: ${f}`);
  // G4: no test file and no evals fixture reaches a user's tree, where a test runner could pick it up
  for (const f of p.files) assert.ok(!/\.test\.[cm]?[jt]sx?$/.test(f) && !f.startsWith(`${pluginRel}/evals/`), `a test or eval file in the package: ${f}`);
  for (const dir of ['docs/', 'scripts/', 'tests/', 'evals-hidden/', '.github/', '.claude-plugin/']) assert.ok(!p.files.some((f) => f.startsWith(dir)), `no ${dir} in the package`);
  for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE', `${pluginRel}/bin/${names.bin}`, `${pluginRel}/lib/cli/main.mjs`, `${pluginRel}/hooks/hooks.json`]) assert.ok(p.files.includes(f), `${f} in the package`);
});

test('npx <tarball> install without claude on PATH prints exactly the SD-3 commands and exits 0; with a fake claude it runs them (acceptance 6)', { timeout: 300000 }, (t) => {
  const s = setup(t);
  const p = pack(t, s);
  if (!p) return;
  const cwd = join(s.base, 'cwd');
  mkdirSync(cwd);
  assert.notEqual(run('sh', ['-c', 'command -v claude'], { env: s.env }).status, 0, 'precondition: no claude on this PATH');
  const npx = (env) => run('npx', ['--yes', '--package', p.tarball, names.bin, 'install'], { cwd, env, timeout: 240000 });
  const printed = npx(s.env);
  assert.equal(printed.status, 0, out(printed));
  assert.equal(printed.stdout, PRINTED);
  assert.deepEqual(calls(s.env.FAKE_CLAUDE_LOG), []);
  const ran = npx({ ...s.env, PATH: `${s.fake}${delimiter}${s.env.PATH}` });
  assert.equal(ran.status, 0, out(ran));
  assert.deepEqual(calls(s.env.FAKE_CLAUDE_LOG), [SD3[0], ['plugin', 'list', '--json']], 'the one-command install, then the check');
  assert.match(ran.stdout, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is installed and enabled`));
  assert.match(ran.stdout, /\/reload-plugins/);
  assert.deepEqual(readdirSync(cwd), [], 'nothing written where it ran');
});

async function inProcess(s, extraEnv, cwd = s.base) {
  const io = { out: (x) => io.o.push(x), err: (x) => io.e.push(x), o: [], e: [], stdinIsTTY: false, env: { ...s.env, PATH: `${s.fake}${delimiter}${s.env.PATH}`, ...extraEnv }, cwd, stdin: null };
  const code = await main(['install', '--json'], { io });
  return { code, env: JSON.parse(io.o.join('')) };
}

test('install: claude never runs in the repository: its cwd is the real temp directory (E3)', async (t) => {
  const s = setup(t);
  const repo = join(s.base, 'repo');
  mkdirSync(repo);
  await inProcess(s, { FAKE_PRIMARY_EXIT: '1' }, repo);
  const cwds = readFileSync(`${s.env.FAKE_CLAUDE_LOG}.cwd`, 'utf8').trim().split('\n');
  assert.equal(cwds.length, 4);
  for (const c of cwds) assert.equal(c, realpathSync(tmpdir()), 'a neutral directory');
  assert.ok(!cwds.includes(realpathSync(repo)));
});

test('install: a failing one-command install runs the two-command fallback; a plugin not enabled afterwards is exit 1', async (t) => {
  const s = setup(t);
  const fallback = await inProcess(s, { FAKE_PRIMARY_EXIT: '1' });
  assert.equal(fallback.code, 0, JSON.stringify(fallback.env));
  assert.deepEqual(calls(s.env.FAKE_CLAUDE_LOG), [SD3[0], SD3[1], SD3[2], ['plugin', 'list', '--json']]);
  assert.deepEqual(fallback.env.data.ran.map((r) => r.exit), [1, 0, 0]);
  writeFileSync(s.env.FAKE_CLAUDE_LIST, JSON.stringify([{ id, enabled: false }]));
  rmSync(s.env.FAKE_CLAUDE_LOG);
  const disabled = await inProcess(s, {});
  assert.equal(disabled.code, 1, JSON.stringify(disabled.env));
  assert.equal(disabled.env.errors[0].code, 'not-enabled');
  writeFileSync(s.env.FAKE_CLAUDE_LIST, 'not json');
  assert.equal((await inProcess(s, {})).env.errors[0].code, 'not-enabled');
});
