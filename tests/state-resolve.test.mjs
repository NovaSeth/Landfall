// State directory resolution (spec §5.3, §5.4, §7.2, SD-7, SD-36, REV-58, GC2): the state directory of a
// repository is <repo>/<stateDir from name.json>, or an external directory linked in machine data
// (projects.json, keyed by the repository's real path). Context comes from the target (its git top level and
// the env passed in), never from the process cwd. Resolution alone creates nothing: no file in the repository,
// no machine data directory. projects.json updates are atomic, locked and keep other entries.
// Every test runs in a throwaway HOME; the real HOME and ~/.claude are never read.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const STATE = pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href;
const state = await import(STATE);
const EXIT = (await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href)).EXIT;
const DATA_ID = `${names.plugin}-${names.marketplace}`;
const AT = '2026-10-15T05:42:00.000Z';

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-resolve-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: base, LANG: 'C' };
  return { base, home, env };
}
function repo(base, name = 'repo') {
  const dir = join(base, name);
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { encoding: 'utf8', env: { ...ISO.env, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(dir, 'src', 'a.txt'), 'a\n');
  return dir;
}
// Every directory and file under dir (path, type, content hash): any write shows up as a difference.
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}
const refused = (code, exit) => (e) => e instanceof state.StateError && e.code === code && e.exit === exit && EXIT[e.exit] !== undefined;

test('machine data directory: CLAUDE_PLUGIN_DATA, then the plugin cache dir, then the config dir, then HOME (spec §5.3)', () => {
  const md = (env) => state.machineDataDir(names, env);
  assert.equal(md({ CLAUDE_PLUGIN_DATA: '/d/data', CLAUDE_CODE_PLUGIN_CACHE_DIR: '/c', CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' }), '/d/data');
  assert.equal(md({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/c', CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' }), `/c/data/${DATA_ID}`);
  assert.equal(md({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' }), `/cfg/plugins/data/${DATA_ID}`);
  assert.equal(md({ HOME: '/h' }), `/h/.claude/plugins/data/${DATA_ID}`);
  assert.equal(md({ CLAUDE_PLUGIN_DATA: 'relative', HOME: '/h' }), `/h/.claude/plugins/data/${DATA_ID}`, 'a relative value is ignored');
  assert.equal(md({}), null);
  assert.throws(() => state.machineDataDir(names), /env/, 'env is explicit (REV-58)');
});

test('resolve: the repository of the target, its in-repo state directory, inactive; context from the target', (t) => {
  const { base, env } = scratch(t);
  const r = repo(base);
  // The test process runs in another repository: resolution must not use it.
  const got = state.resolve({ cwd: join(r, 'src', 'deep'), env, names });
  assert.deepEqual(got, {
    repo: r, worktree: r, copy: null, dir: join(r, names.stateDir), local: join(r, names.stateDir, 'local'), linked: false, declined: false, active: false,
    dataDir: join(env.HOME, '.claude', 'plugins', 'data', DATA_ID),
  });
  // Through a symlink: the same real path.
  symlinkSync(r, join(base, 'link'));
  assert.equal(state.resolve({ cwd: join(base, 'link', 'src'), env, names }).repo, r);
  assert.throws(() => state.resolve({ cwd: r, names }), /env/);
  assert.throws(() => state.resolve({ cwd: r, env }), /names/);
});

test('resolve: a git that does not answer within timeoutMs → git-failed (ENV), not "not a repository"', (t) => {
  const { base, env } = scratch(t);
  const r = repo(base);
  const bin = join(base, 'slow-bin'); mkdirSync(bin);
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 3\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const slow = { ...env, PATH: `${bin}:${env.PATH}` };
  const started = Date.now();
  assert.throws(() => state.resolve({ cwd: r, env: slow, names, timeoutMs: 200 }), refused('git-failed', 'ENV'));
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  assert.equal(state.resolve({ cwd: r, env, names, timeoutMs: 5000 }).repo, realpathSync(r), 'a git that answers in time');
});

// B2-r2 (findings-r2): "not a repository" only from git's own answer for it (exit 128, "not a git repository") with no
// .git entry in the directory or above; dubious ownership, a permission error, a crash, or that answer where a .git
// exists is git-failed (ENV), never not-a-repo.
test('B2-r2: resolve: a git failure other than "not a git repository" → git-failed (ENV), also with a .git present', (t) => {
  const { base, env } = scratch(t);
  const r = repo(base);
  const outside = join(base, 'plain'); mkdirSync(outside);
  const fake = (name, body) => { const bin = join(base, `${name}-bin`); mkdirSync(bin); writeFileSync(join(bin, 'git'), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return { ...env, PATH: bin }; };
  const dubious = fake('dubious', 'printf "fatal: detected dubious ownership in repository at \'%s\'\\n" "$PWD" >&2\nexit 128');
  const crash = fake('crash', 'kill -SEGV $$');
  const denied = fake('denied', 'printf "fatal: Unable to read current working directory: Permission denied\\n" >&2\nexit 128');
  const notRepo = fake('not-repo', 'printf "fatal: not a git repository (or any of the parent directories): .git\\n" >&2\nexit 128');
  for (const [name, e] of Object.entries({ dubious, crash, denied, notRepo })) {
    assert.throws(() => state.resolve({ cwd: r, env: e, names }), refused('git-failed', 'ENV'), `${name} in a repository`);
    assert.throws(() => state.resolve({ cwd: join(r, 'src', 'deep'), env: e, names }), refused('git-failed', 'ENV'), `${name} in a subdirectory`);
  }
  assert.throws(() => state.resolve({ cwd: outside, env: notRepo, names }), refused('not-a-repo', 'ENV'), 'git says so and no .git above');
  assert.throws(() => state.resolve({ cwd: outside, env: dubious, names }), refused('git-failed', 'ENV'), 'any other answer is not "no repository"');
  assert.throws(() => state.resolve({ cwd: outside, env, names }), refused('not-a-repo', 'ENV'), 'the real git outside a repository');
});

test('resolve: outside a git repository → not-a-repo (ENV); git missing → ENV', (t) => {
  const { base, env } = scratch(t);
  const outside = join(base, 'plain');
  mkdirSync(outside);
  assert.throws(() => state.resolve({ cwd: outside, env, names }), refused('not-a-repo', 'ENV'));
  assert.throws(() => state.resolve({ cwd: outside, env: { ...env, PATH: join(base, 'empty-path') }, names }), refused('git-missing', 'ENV'));
});

test('zero footprint: resolving creates nothing in the repository, in machine data or in HOME (GC2)', (t) => {
  const { base, home, env } = scratch(t);
  const r = repo(base);
  const before = { repo: snapshot(r), home: snapshot(home) };
  for (let i = 0; i < 3; i++) state.resolve({ cwd: join(r, 'src'), env, names });
  assert.deepEqual({ repo: snapshot(r), home: snapshot(home) }, before);
  const st = spawnSync('git', ['status', '--porcelain', '--ignored'], { cwd: r, encoding: 'utf8', env });
  assert.equal(st.stdout, '?? src/\n', 'only the fixture file is untracked');
});

// Two roots (T-MG-1): `repo` is the project — the main checkout, whose state every linked worktree shares — and
// `worktree` the git top level of the target, where the code is; `copy` is a worktree's checked-out copy of the in-repo
// state directory, which is no state. Without a main checkout (a bare repository with worktrees, a submodule) and in a
// main checkout whose git directory lives elsewhere, the project is the top level itself, as before.
const gitIn = (cwd, env, ...args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
function committed(base, env, name = 'repo') {
  const dir = repo(base, name);
  gitIn(dir, env, 'add', '-A');
  gitIn(dir, env, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  return dir;
}

test('resolve in a linked worktree: the project is the main checkout, the worktree the top level of the target', (t) => {
  const { base, env } = scratch(t);
  const r = committed(base, env);
  const wt = join(base, 'wt');
  gitIn(r, env, 'worktree', 'add', '-q', wt, '-b', 'feature');
  const nested = join(r, '.claude', 'worktrees', 'n');
  gitIn(r, env, 'worktree', 'add', '-q', nested, '-b', 'nested');
  for (const [cwd, top] of [[wt, wt], [join(wt, 'src'), wt], [nested, nested], [join(nested, 'src'), nested]]) {
    const got = state.resolve({ cwd, env, names });
    assert.deepEqual([got.repo, got.worktree, got.dir, got.local, got.copy, got.linked, got.active], [r, top, join(r, names.stateDir), join(r, names.stateDir, 'local'), join(top, names.stateDir), false, false], cwd);
  }
  const main = state.resolve({ cwd: join(r, 'src', 'deep'), env, names });
  assert.deepEqual([main.repo, main.worktree, main.copy], [r, r, null], 'the main checkout itself');
  // git's relative answers are relative to its physical directory, also through a link into the checkout
  symlinkSync(join(r, 'src'), join(base, 'into-src'));
  const into = state.resolve({ cwd: join(base, 'into-src', 'deep'), env, names });
  assert.deepEqual([into.repo, into.worktree, into.copy], [r, r, null], 'through a link into a subdirectory');
  mkdirSync(join(r, names.stateDir));
  writeFileSync(join(r, names.stateDir, 'state.json'), '{}');
  assert.equal(state.resolve({ cwd: wt, env, names }).active, true, 'active from the state of the main checkout');
  const via = join(base, 'wt-link');
  symlinkSync(wt, via);
  const linkedPath = state.resolve({ cwd: join(via, 'src'), env, names });
  assert.deepEqual([linkedPath.repo, linkedPath.worktree], [r, wt], 'real paths through a link');
  // linked state: keyed by the main checkout's real path; a worktree has no copy of an external directory
  const external = join(base, 'control', 'state');
  state.updateProject({ repo: r, dataDir: state.machineDataDir(names, env), names, patch: { stateDir: external } });
  const linked = state.resolve({ cwd: wt, env, names });
  assert.deepEqual([linked.repo, linked.worktree, linked.dir, linked.linked, linked.copy], [r, wt, external, true, null]);
});

test('resolve without a main checkout: a bare repository with worktrees, a submodule, a separate git directory keep the top level as the project', (t) => {
  const { base, env } = scratch(t);
  const r = committed(base, env);
  const bare = join(base, 'bare.git');
  gitIn(base, env, 'clone', '-q', '--bare', r, bare);
  const bw = join(base, 'bare-wt');
  gitIn(bare, env, 'worktree', 'add', '-q', bw, 'main');
  // a bare repository stored as <dir>/.git (review-r1 F2): its common directory is named .git, yet <dir> is no checkout
  mkdirSync(join(base, 'held'));
  gitIn(base, env, 'clone', '-q', '--bare', r, join(base, 'held', '.git'));
  const hw = join(base, 'held-wt');
  gitIn(join(base, 'held', '.git'), env, 'worktree', 'add', '-q', hw, 'main');
  const sup = committed(base, env, 'super');
  gitIn(sup, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', r, 'sm');
  const sm = join(sup, 'sm');
  // a main checkout whose git directory is named .git but lives elsewhere: still its own project
  mkdirSync(join(base, 'sep'));
  const sp = join(base, 'sp');
  gitIn(base, env, 'init', '-q', `--separate-git-dir=${join(base, 'sep', '.git')}`, sp);
  for (const [cwd, top] of [[bw, bw], [join(bw, 'src'), bw], [hw, hw], [join(hw, 'src'), hw], [sm, sm], [join(sm, 'src'), sm], [sp, sp]]) {
    const got = state.resolve({ cwd, env, names });
    assert.deepEqual([got.repo, got.worktree, got.dir, got.copy], [top, top, join(top, names.stateDir), null], cwd);
  }
});

test('linked state directory: recorded in projects.json by real path; resolution follows it; the repository stays clean', (t) => {
  const { base, env } = scratch(t);
  const r = repo(base);
  const external = join(base, 'control', 'state');
  const before = snapshot(r);
  const dataDir = state.machineDataDir(names, env);
  const entry = state.updateProject({ repo: r, dataDir, names, patch: { stateDir: external } });
  assert.deepEqual(entry, { stateDir: external });
  const got = state.resolve({ cwd: join(r, 'src'), env, names });
  assert.deepEqual([got.dir, got.local, got.linked, got.active], [external, join(external, 'local'), true, false]);
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, 'state.json'), '{}');
  assert.equal(state.resolve({ cwd: r, env, names }).active, true, 'active once state.json exists in the linked directory');
  assert.deepEqual(snapshot(r), before, 'nothing written into the repository');
  const text = readFileSync(join(dataDir, 'projects.json'), 'utf8');
  assert.equal(text, `${JSON.stringify({ schema: state.MACHINE_KINDS.projects.version, projects: { [r]: { stateDir: external } } }, null, 2)}\n`);
  assert.deepEqual(readdirSync(dataDir), ['projects.json'], 'no lock or temporary file left');
});

test('updateProject merges into the entry, null removes a field, an empty entry disappears, other repositories stay', (t) => {
  const { base, env } = scratch(t);
  const dataDir = state.machineDataDir(names, env);
  const a = repo(base, 'a');
  const b = repo(base, 'b');
  state.updateProject({ repo: a, dataDir, names, patch: { stateDir: '/x/state' } });
  state.updateProject({ repo: b, dataDir, names, patch: { declinedAt: AT } });
  assert.deepEqual(state.updateProject({ repo: a, dataDir, names, patch: { handle: 'MG' } }), { stateDir: '/x/state', handle: 'MG' });
  assert.equal(state.updateProject({ repo: b, dataDir, names, patch: { declinedAt: null } }), null);
  assert.deepEqual(state.readProjects(dataDir, names).projects, { [a]: { stateDir: '/x/state', handle: 'MG' } });
  assert.equal(state.resolve({ cwd: b, env, names }).declined, false);
  state.updateProject({ repo: b, dataDir, names, patch: { declinedAt: AT } });
  assert.equal(state.resolve({ cwd: b, env, names }).declined, true);
});

test('updateProject refuses invalid values and unknown fields before writing anything', (t) => {
  const { base, env } = scratch(t);
  const dataDir = state.machineDataDir(names, env);
  const r = repo(base);
  for (const patch of [{ stateDir: 'relative/dir' }, { stateDir: '/a/../b' }, { handle: 'toolong' }, { declinedAt: 'now' }, { other: 1 }]) {
    assert.throws(() => state.updateProject({ repo: r, dataDir, names, patch }), (e) => e instanceof state.StateError && e.exit === 'USAGE', JSON.stringify(patch));
  }
  assert.throws(() => state.updateProject({ repo: 'relative', dataDir, names, patch: { handle: 'MG' } }), (e) => e.exit === 'USAGE');
  assert.throws(() => state.updateProject({ repo: r, dataDir: null, names, patch: { handle: 'MG' } }), refused('no-machine-data', 'ENV'));
  assert.equal(existsSync(dataDir), false, 'no machine data directory created');
});

test('projects.json with a newer schema: resolution and updates refuse (exit 7) and write nothing (SC10)', (t) => {
  const { base, env } = scratch(t);
  const dataDir = state.machineDataDir(names, env);
  const r = repo(base);
  mkdirSync(dataDir, { recursive: true });
  const newer = `${JSON.stringify({ schema: state.MACHINE_KINDS.projects.version + 1, projects: {}, future: true })}\n`;
  writeFileSync(join(dataDir, 'projects.json'), newer);
  const before = snapshot(base);
  assert.throws(() => state.resolve({ cwd: r, env, names }), (e) => refused('schema-newer', 'REFUSED')(e) && EXIT[e.exit] === 7 && e.hint.includes(`${names.plugin}@${names.marketplace}`));
  assert.throws(() => state.updateProject({ repo: r, dataDir, names, patch: { handle: 'MG' } }), refused('schema-newer', 'REFUSED'));
  assert.deepEqual(snapshot(base), before);
  writeFileSync(join(dataDir, 'projects.json'), 'not json');
  assert.throws(() => state.resolve({ cwd: r, env, names }), refused('state-invalid', 'FAIL'));
  assert.throws(() => state.updateProject({ repo: r, dataDir, names, patch: { handle: 'MG' } }), refused('state-invalid', 'FAIL'));
  assert.equal(readFileSync(join(dataDir, 'projects.json'), 'utf8'), 'not json');
});

test('concurrent updateProject from N processes keeps every entry (locked read-modify-write)', { timeout: 120000 }, async (t) => {
  const { base, env } = scratch(t);
  const dataDir = state.machineDataDir(names, env);
  const go = join(base, 'go');
  const n = 8;
  const code = (k) => `const state = await import(${JSON.stringify(STATE)});
const { existsSync } = await import('node:fs');
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 1);
for (let i = 0; i < 5; i++) state.updateProject({ repo: ${JSON.stringify(join(base, 'r'))} + ${k} + '-' + i, dataDir: ${JSON.stringify(dataDir)}, names: ${JSON.stringify(names)}, patch: { handle: 'AB' } });`;
  const runs = Array.from({ length: n }, (_, k) => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code(k)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => res({ status, err }));
  }));
  writeFileSync(go, '');
  for (const r of await Promise.all(runs)) assert.equal(r.status, 0, r.err);
  assert.equal(Object.keys(state.readProjects(dataDir, names).projects).length, n * 5);
  assert.deepEqual(readdirSync(dataDir), ['projects.json']);
});
