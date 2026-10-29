// local/ is machine-local (T-MG-77 slice A, audit C-3, C-4, F2-2, F2-3): the state directory's local/ belongs to the
// machine whose id its marker local/.machine holds. A local/ shipped in a repository (tracked by git, or marked by
// another machine) is foreign: store readers see it as empty and the first state write moves it aside to
// local.foreign-<stamp>/ and starts a fresh local/ with this machine's marker. An untracked local/ without a marker
// is adopted (existing users) and keeps its files. Decision records are read through the store's path checks.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
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

// ---- slice A2: one machine id per user and machine, tracked means foreign, every reader, hooks never move ----
const { main } = await import(lib('cli/main.mjs'));
const { loopStatus } = await import(lib('hooks/loop-state.mjs'));
const LAUNCHER = join(pluginDir, 'bin', names.bin);
async function cli(cwd, args, env = ISO.env) {
  const io = { stdout: '', stderr: '', stdinIsTTY: false, env, cwd, stdin: null };
  io.out = (s) => { io.stdout += s; };
  io.err = (s) => { io.stderr += s; };
  const code = await main(args, { io });
  return { code, stdout: io.stdout, stderr: io.stderr, json: args.includes('--json') && io.stdout ? JSON.parse(io.stdout.trim().split('\n').pop()) : null };
}
const commit = (cwd) => git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'ship state');
const RUN = 'codex-T-AB-1-implementer-1';
const identify = (d) => { git(d, 'config', 'user.name', 'Test User'); git(d, 'config', 'user.email', 'test@example.com'); };
// A repository activated on this machine whose local/ (this machine's marker, a loop, a running run) was committed,
// then cloned: the clone's local/ is tracked, and its marker equals this machine's id.
async function shippedClone(t, { decision = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-local-owner-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin');
  mkdirSync(origin);
  git(origin, '-c', 'init.defaultBranch=main', 'init', '-q');
  identify(origin);
  writeFileSync(join(origin, 'README.md'), 'x\n');
  const init = await cli(origin, ['init', '--yes', '--handle', 'AB', '--json']);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  if (decision) {
    const r = await cli(origin, ['decide', '--title', 'Sources stay small', '--why', 'Because small. More detail.', '--cost', 'low, easy to change', '--scope', 'src/**', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  }
  const local = join(origin, names.stateDir, 'local');
  assert.match(readFileSync(join(local, '.machine'), 'utf8'), /^[0-9a-f]{32}\n$/, 'this machine marked it');
  writeFileSync(join(local, 'loop.json'), JSON.stringify({ schema: 1, id: 'L-20991231000000-abcdef', startedAt: AT, ticks: 0, exit: 'DONE' }));
  mkdirSync(join(local, 'runs'), { recursive: true });
  writeFileSync(join(local, 'runs', `${RUN}.json`), JSON.stringify({ schema: 1, runId: RUN, status: 'running', startedAt: AT }));
  git(origin, 'add', '-f', '.');
  commit(origin);
  const dir = join(base, 'clone');
  git(base, 'clone', '-q', origin, dir);
  identify(dir);
  const store = join(dir, names.stateDir);
  assert.ok(existsSync(join(store, 'local', 'loop.json')), 'the clone ships local/');
  return { base, dir, store };
}

test('A2-1: two plugin data and config dirs of one user on one machine both own a marked local/; nothing moves aside', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-local-owner-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const envOf = (n) => ({ ...ISO.env, CLAUDE_CONFIG_DIR: join(base, `config-${n}`), CLAUDE_PLUGIN_DATA: join(base, `data-${n}`) });
  const mk = (name) => { const d = join(base, name); mkdirSync(d); git(d, '-c', 'init.defaultBranch=main', 'init', '-q'); identify(d); return d; };
  const repoA = mk('a');
  const other = mk('other');
  assert.equal((await cli(repoA, ['init', '--yes', '--handle', 'AB'], envOf(1))).code, 0);
  assert.equal((await cli(other, ['init', '--yes', '--handle', 'AB'], envOf(2))).code, 0); // the second config dir has written state before
  const r = await cli(repoA, ['init', '--yes', '--handle', 'AB'], envOf(2));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(foreignDirs(join(repoA, names.stateDir)), [], 'a fresh install through another CLAUDE_CONFIG_DIR moves nothing aside');
});

test('A2-2: a tracked local/ whose marker equals this machine\'s id is foreign; once moved aside, a new process keeps the fresh local/', async (t) => {
  const { base, dir, store } = await shippedClone(t);
  assert.equal(showLoop({ cwd: dir, env: ISO.env, names }).loop, null, 'the shipped loop is not this machine\'s');
  const s = state.open(store, { names });
  s.write('config', null, config);
  assert.equal(foreignDirs(store).length, 1, 'moved aside although its marker names this machine');
  const script = join(base, 'write.mjs');
  writeFileSync(script, `const s = await import(${JSON.stringify(lib('state/index.mjs'))});\nconst names = ${JSON.stringify(names)};\ns.open(${JSON.stringify(store)}, { names }).write('config', null, ${JSON.stringify(config)});\n`);
  const r = spawnSync(process.execPath, [script], { env: ISO.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(foreignDirs(store).length, 1, 'the fresh local/ (git still lists the shipped paths) is not moved again');
});

test('A2-3, A2-5: the stop guard, status --json and runs list --json see a shipped local/ as empty; the move-aside is gitignored', async (t) => {
  const { dir, store } = await shippedClone(t);
  const env = { ...ISO.env, CLAUDE_PROJECT_DIR: dir };
  assert.equal(loopStatus({ cwd: dir }, env).kind, 'none', 'the stop guard sees no loop');
  const status = await cli(dir, ['status', '--json']);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.ok(!JSON.stringify(status.json.data).includes(RUN), `no shipped run in status: ${status.stdout}`);
  const runs = await cli(dir, ['runs', 'list', '--json']);
  assert.equal(runs.code, 0, runs.stdout + runs.stderr);
  assert.deepEqual(runs.json.data.runs, []);
  assert.deepEqual(foreignDirs(store), [], 'reads move nothing');
  const again = await cli(dir, ['init', '--yes', '--handle', 'AB']); // a command's write: the activation write
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(foreignDirs(store).length, 1);
  assert.ok(readFileSync(join(store, '.gitignore'), 'utf8').split('\n').includes('local.foreign-*/'), 'an existing .gitignore gains the line');
  const porcelain = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, env: ISO.env, encoding: 'utf8' }).stdout;
  assert.ok(!porcelain.includes('local.foreign-'), porcelain);
});

test('A2-4: a hook run in a repository with a shipped local/ moves nothing aside and writes nothing there', async (t) => {
  const { dir, store } = await shippedClone(t, { decision: true });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'x\n');
  const before = readdirSync(join(store, 'local')).sort();
  const input = { session_id: 's1', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.js') } };
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'decisions-context'], { cwd: dir, env: ISO.env, input: JSON.stringify(input), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(foreignDirs(store), [], 'a hook never moves local/ aside');
  assert.deepEqual(readdirSync(join(store, 'local')).sort(), before, 'and writes nothing into it');
});

// ---- fix round 1: F1 (a replacement local/ is never adopted), F2 (a marker that is not a file), F3 (git errors),
// F4 (the move-aside is serialized), F5 (the backup exclusion before any move) ----
const dataDirOf = () => state.machineDataDir(names, process.env);
const GATES = [{ name: 'test', cmd: 'touch shipped', timeoutS: 60, kind: 'test' }];

test('F1: a shipped local/ moved aside in a linked repository: the fresh local/ is not adopted, the shipped gates stay untrusted', async (t) => {
  const { dir, store } = await shippedClone(t);
  writeFileSync(join(store, 'profile.json'), `${JSON.stringify({ schema: 1, gates: GATES }, null, 2)}\n`);
  state.updateProject({ repo: dir, dataDir: dataDirOf(), names, patch: { stateDir: store } });
  t.after(() => state.updateProject({ repo: dir, dataDir: dataDirOf(), names, patch: { stateDir: null } }));
  state.open(store, { names }).write('config', null, config);
  assert.equal(foreignDirs(store).length, 1);
  const trusted = state.isTrusted({ dir: store, dataDir: dataDirOf(), names, kind: 'gates', sha: state.gatesShaOf(GATES) });
  assert.equal(trusted.trusted, false, 'adopted from a replacement local/');
  assert.equal(state.readTrust(dataDirOf(), names).repos[trusted.key]?.adoptedAt, undefined);
});

test('F2: a marker that is a symbolic link or a directory makes local/ foreign', (t) => {
  const { base, store } = repo(t);
  const target = join(base, 'id');
  writeFileSync(target, `${state.machineId()}\n`);
  symlinkSync(target, join(store, 'local', '.machine'));
  assert.equal(state.localForeign(store).foreign, true);
  rmSync(join(store, 'local', '.machine'));
  mkdirSync(join(store, 'local', '.machine'));
  assert.equal(state.localForeign(store).foreign, true);
});

test('F3: a git error makes ownership unknown (not ours, not cached); outside a repository local/ stays ours', (t) => {
  const { base, store } = repo(t);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "fatal: broken" >&2\nexit 2\n', { mode: 0o755 });
  const failed = state.localForeign(store, { env: { ...ISO.env, PATH: bin } });
  assert.equal(failed.foreign, true, JSON.stringify(failed));
  assert.equal(failed.unknown, true);
  assert.equal(state.localForeign(store, { env: { ...ISO.env, PATH: join(base, 'none') } }).foreign, true, 'git missing: unknown too');
  assert.equal(state.localForeign(store).why, 'unmarked', 'checked again once git answers');
  const outside = join(base, 'linked-state');
  mkdirSync(join(outside, 'local'), { recursive: true });
  assert.equal(state.localForeign(outside).foreign, false, 'not a repository: nothing is tracked');
});

test('F4: two writers moving one shipped local/ aside are serialized: one move, both writes succeed, the lock is not moved', async (t) => {
  const { base, store } = await shippedClone(t);
  const signals = join(base, 'signals');
  mkdirSync(signals);
  const script = (cfg) => `const s = await import(${JSON.stringify(lib('state/index.mjs'))});\nconst names = ${JSON.stringify(names)};\ns.open(${JSON.stringify(store)}, { names }).write('config', null, ${JSON.stringify(cfg)});\n`;
  writeFileSync(join(base, 'b.mjs'), script(config));
  writeFileSync(join(base, 'a.mjs'), script({ flags: { lanes: 'on' } }));
  const run = (file, env) => new Promise((done) => {
    const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ code, err }));
  });
  const b = run(join(base, 'b.mjs'), { ...ISO.env, [`${names.envPrefix}TEST_MOVE_PAUSE`]: signals });
  for (let i = 0; i < 200 && !existsSync(join(signals, 'paused')); i++) await sleep(25);
  assert.ok(existsSync(join(signals, 'paused')), 'writer B paused inside the move-aside');
  const a = run(join(base, 'a.mjs'), ISO.env);
  await sleep(400);
  writeFileSync(join(signals, 'go'), '');
  const [rb, ra] = await Promise.all([b, a]);
  assert.deepEqual([rb.code, ra.code], [0, 0], rb.err + ra.err);
  assert.equal(foreignDirs(store).length, 1, 'moved aside once');
  assert.equal(existsSync(join(store, 'local', 'lock')), false);
  assert.equal(readFileSync(join(store, 'local', '.machine'), 'utf8').trim(), state.machineId());
  assert.ok(existsSync(join(store, 'config.json')));
});

test('F5: a write that moves local/ aside first adds local.foreign-*/ to an older .gitignore', async (t) => {
  const { store } = await shippedClone(t);
  writeFileSync(join(store, '.gitignore'), 'local/\n.*.tmp\n');
  state.open(store, { names }).write('config', null, config);
  assert.equal(foreignDirs(store).length, 1);
  assert.ok(readFileSync(join(store, '.gitignore'), 'utf8').split('\n').includes('local.foreign-*/'));
});

// ---- fix round 2: F1 (the non-adoption entry is written before the rename; a failed trust write aborts the move) ----

test('F1 r2: a trust.json write failure on the move path aborts the move with an error naming trust.json; a retry of isTrusted does not adopt', async (t) => {
  const { dir, store } = await shippedClone(t);
  writeFileSync(join(store, 'profile.json'), `${JSON.stringify({ schema: 1, gates: GATES }, null, 2)}\n`);
  state.updateProject({ repo: dir, dataDir: dataDirOf(), names, patch: { stateDir: store } });
  t.after(() => state.updateProject({ repo: dir, dataDir: dataDirOf(), names, patch: { stateDir: null } }));
  const file = join(dataDirOf(), 'trust.json');
  const saved = existsSync(file) ? readFileSync(file, 'utf8') : null;
  rmSync(file, { force: true });
  mkdirSync(file); // the injected failure: trust.json cannot be read or replaced
  t.after(() => { rmSync(file, { recursive: true, force: true }); if (saved !== null) writeFileSync(file, saved); });
  assert.throws(() => state.open(store, { names }).write('config', null, { flags: { engine: 'on' } }), (err) => /trust\.json/.test(err.message), 'the write refuses, naming trust.json');
  assert.equal(foreignDirs(store).length, 0, 'nothing was moved aside');
  assert.ok(existsSync(join(store, 'local', 'loop.json')), 'the shipped local/ is still in place');
  assert.equal(existsSync(join(store, 'config.json')), false, 'nothing was written');
  rmSync(file, { recursive: true, force: true });
  const retry = state.isTrusted({ dir: store, dataDir: dataDirOf(), names, kind: 'gates', sha: state.gatesShaOf(GATES) });
  assert.deepEqual([retry.trusted, retry.adopted], [false, false], 'adopted after a failed trust write');
});

test('F1 r2: while a move-aside is paused before its rename, the non-adoption entry already exists; isTrusted during and after the move never adopts', async (t) => {
  const { base, dir, store } = await shippedClone(t);
  writeFileSync(join(store, 'profile.json'), `${JSON.stringify({ schema: 1, gates: GATES }, null, 2)}\n`);
  state.updateProject({ repo: dir, dataDir: dataDirOf(), names, patch: { stateDir: store } });
  t.after(() => state.updateProject({ repo: dir, dataDir: dataDirOf(), names, patch: { stateDir: null } }));
  const signals = join(base, 'signals');
  mkdirSync(signals);
  writeFileSync(join(base, 'w.mjs'), `const s = await import(${JSON.stringify(lib('state/index.mjs'))});\nconst names = ${JSON.stringify(names)};\ns.open(${JSON.stringify(store)}, { names }).write('config', null, ${JSON.stringify(config)});\n`);
  const w = new Promise((done) => {
    const p = spawn(process.execPath, [join(base, 'w.mjs')], { env: { ...ISO.env, [`${names.envPrefix}TEST_MOVE_PAUSE`]: signals }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ code, err }));
  });
  for (let i = 0; i < 200 && !existsSync(join(signals, 'paused')); i++) await sleep(25);
  assert.ok(existsSync(join(signals, 'paused')), 'the writer paused inside the move-aside');
  const sha = state.gatesShaOf(GATES);
  const key = state.repoKey(store);
  const entry = state.readTrust(dataDirOf(), names).repos[key];
  const during = state.isTrusted({ dir: store, dataDir: dataDirOf(), names, kind: 'gates', sha });
  writeFileSync(join(signals, 'go'), '');
  const res = await w;
  assert.equal(res.code, 0, res.err);
  assert.ok(entry, 'the non-adoption entry is written before the rename');
  assert.equal(entry.adoptedAt, undefined);
  assert.deepEqual([during.trusted, during.adopted], [false, false]);
  assert.equal(foreignDirs(store).length, 1);
  const after = state.isTrusted({ dir: store, dataDir: dataDirOf(), names, kind: 'gates', sha });
  assert.deepEqual([after.trusted, after.adopted], [false, false]);
  assert.equal(state.readTrust(dataDirOf(), names).repos[key]?.adoptedAt, undefined);
});

test('F1 r2: the move lock (.local-move.lock) is gitignored: in a new .gitignore and added to an older one', async (t) => {
  const { store } = await shippedClone(t);
  assert.ok(readFileSync(join(store, '.gitignore'), 'utf8').split('\n').includes('.local-move.lock'), 'init writes it');
  writeFileSync(join(store, '.gitignore'), 'local/\n.*.tmp\n');
  state.open(store, { names }).write('config', null, config);
  assert.ok(readFileSync(join(store, '.gitignore'), 'utf8').split('\n').includes('.local-move.lock'), 'an older .gitignore gains it');
});
