// local/ is machine-local (T-MG-77 slice A, audit C-3, C-4, F2-2, F2-3): the state directory's local/ belongs to the
// machine whose id its marker local/.machine holds. A local/ shipped in a repository (tracked by git, or marked by
// another machine) is foreign: store readers see it as empty and the first state write moves it aside to
// local.foreign-<stamp>/ and starts a fresh local/ with this machine's marker. An untracked local/ without a marker
// is adopted (existing users) and keeps its files. Decision records are read through the store's path checks.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (p) => pathToFileURL(join(pluginDir, 'lib', p)).href;
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(lib('state/index.mjs'));
const { showLoop } = await import(lib('loop/index.mjs'));
const { readRuns } = await import(lib('receipts/runs.mjs'));
const { readRecords } = await import(lib('decisions/records.mjs'));
const { KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd, env: ISO.env }).status, 0, `git ${args.join(' ')}`);

function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-local-owner-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  git(base, '-c', 'init.defaultBranch=main', 'init', '-q', dir);
  const store = join(dir, names.stateDir);
  mkdirSync(join(store, 'local'), { recursive: true });
  writeFileSync(join(store, 'state.json'), `${JSON.stringify({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT }, null, 2)}\n`);
  return { base, dir, store };
}

// What a cloned repository ships in local/: a loop started in the future, a running run, a dead process's lock.
function shipLocal(store) {
  const local = join(store, 'local');
  writeFileSync(join(local, 'loop.json'), JSON.stringify({ schema: 1, id: 'L-20991231000000-abcdef', startedAt: '2099-12-31T00:00:00.000Z', ticks: 0, exit: null }));
  mkdirSync(join(local, 'runs'));
  writeFileSync(join(local, 'runs', 'codex-T-AB-1-implementer-1.json'), JSON.stringify({ schema: 1, runId: 'codex-T-AB-1-implementer-1', status: 'running', startedAt: AT }));
  mkdirSync(join(local, 'lock'));
  const pid = deadPid();
  writeFileSync(join(local, 'lock', 'owner.json'), JSON.stringify({ pid, token: `${pid}.0123456789abcdef`, host: hostname(), startedAt: new Date(Date.now() - 365 * 864e5).toISOString() }));
}
const foreignDirs = (store) => readdirSync(store).filter((n) => /^local\.foreign-\d{8}T\d{6}/.test(n));
const config = { flags: { lanes: 'off' } };

test('a committed local/ (loop, running run, dead lock) is foreign: not read, moved aside at the first write, which succeeds', (t) => {
  const { dir, store } = repo(t);
  shipLocal(store);
  git(dir, 'add', '-f', '.');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'ship state');
  assert.equal(showLoop({ cwd: dir, env: ISO.env, names }).loop, null, 'a shipped loop.json is not this machine\'s loop');
  const s = state.open(store, { names });
  s.write('config', null, config); // today: stale-lock (the shipped lock of a dead pid)
  assert.equal(foreignDirs(store).length, 1, 'the shipped local/ was moved aside');
  assert.ok(existsSync(join(store, foreignDirs(store)[0], 'loop.json')), 'nothing shipped is lost');
  assert.equal(readRuns(join(store, 'local', 'runs')).runs.length, 0, 'the shipped running run does not count');
  assert.equal(showLoop({ cwd: dir, env: ISO.env, names }).loop, null);
  assert.ok(existsSync(join(store, 'local', '.machine')), 'the fresh local/ carries this machine\'s marker');
  s.write('config', null, config);
  assert.equal(foreignDirs(store).length, 1, 'a local/ of this machine is never moved');
});

test('an untracked local/ without a marker is adopted and keeps its files', (t) => {
  const { store } = repo(t);
  writeFileSync(join(store, 'local', 'keep.txt'), 'mine');
  const s = state.open(store, { names });
  s.write('config', null, config);
  assert.deepEqual(foreignDirs(store), []);
  assert.equal(readFileSync(join(store, 'local', 'keep.txt'), 'utf8'), 'mine');
  const marker = readFileSync(join(store, 'local', '.machine'), 'utf8').trim();
  assert.match(marker, /^[0-9a-f]{32}$/);
  s.write('config', null, config);
  assert.equal(readFileSync(join(store, 'local', '.machine'), 'utf8').trim(), marker, 'the machine id is stable');
});

test('a marker of another machine id makes local/ foreign', (t) => {
  const { dir, store } = repo(t);
  const s = state.open(store, { names });
  s.write('config', null, config); // this machine's marker and id
  writeFileSync(join(store, 'local', '.machine'), `${'0'.repeat(32)}\n`);
  writeFileSync(join(store, 'local', 'loop.json'), JSON.stringify({ schema: 1, id: 'L-20991231000000-abcdef' }));
  assert.equal(showLoop({ cwd: dir, env: ISO.env, names }).loop, null);
  s.write('config', null, config);
  assert.equal(foreignDirs(store).length, 1);
  assert.equal(existsSync(join(store, 'local', 'loop.json')), false);
});

test('a symlinked state directory: decision records are refused as for writes', (t) => {
  const { base, store } = repo(t);
  mkdirSync(join(store, 'decisions'));
  writeFileSync(join(store, 'decisions', 'D-AB-1.md'), '---\nid: D-AB-1\n---\n');
  const link = join(base, 'linked-state');
  symlinkSync(store, link);
  assert.throws(() => readRecords(link), (err) => err.code === 'state-invalid');
});
