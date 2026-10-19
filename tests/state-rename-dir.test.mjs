// Layout migration 002-rename-state-dir (D-MG-1, GC9): a project that still has the pre-rename state directory
// `.caw/` gets it moved to name.json "stateDir" (git mv when tracked, else a rename; .gitignore rewritten); both
// directories present is a typed refusal with nothing moved; the machine data directory `caw-caw-plugins` moves once
// to the current one. `<bin> migrate` runs the step before the document chain and reports the moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = readdirSync(join(root, 'plugins')).filter((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json'))).map((d) => join(root, 'plugins', d))[0];
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const step = (await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'migrations', '002-rename-state-dir.mjs')).href)).default;
const { migrate } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'migrate.mjs')).href);
const OLD = step.previous;
const STATE_DOC = JSON.stringify({ schema: 2, codename: names.codename, createdWith: '2.0.0', activatedAt: '2026-10-15T05:42:00.000Z' }) + '\n';

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rename-dir-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const config = join(base, 'config');
  mkdirSync(config, { recursive: true });
  const env = { ...ISO.env, HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: config };
  mkdirSync(env.HOME, { recursive: true });
  return { base, env, config };
}
const git = (cwd, env, args) => {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
function repoWithOldState(base, env, { commit }) {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, OLD.stateDir), { recursive: true });
  git(repo, env, ['init', '-q']);
  writeFileSync(join(repo, OLD.stateDir, 'state.json'), STATE_DOC);
  writeFileSync(join(repo, '.gitignore'), `node_modules/\n${OLD.stateDir}/local/\n`);
  if (commit) { git(repo, env, ['add', '-A']); git(repo, env, ['commit', '-qm', 'base']); }
  return repo;
}
const isRefusal = (e) => e instanceof state.StateError && e.code === 'state-dir-conflict' && e.exit === 'REFUSED';

test('tracked state directory: git mv keeps history and .gitignore names the new directory', (t) => {
  const { base, env } = scratch(t);
  const repo = repoWithOldState(base, env, { commit: true });
  const r = step.run({ repo, env, names });
  assert.deepEqual(r.moves.map((m) => [m.what, m.how]), [['state', 'git mv']]);
  assert.equal(r.gitignore, true);
  assert.ok(!existsSync(join(repo, OLD.stateDir)));
  assert.equal(readFileSync(join(repo, names.stateDir, 'state.json'), 'utf8'), STATE_DOC);
  assert.match(git(repo, env, ['diff', '--cached', '--name-status', '-M']), new RegExp(`^R100\\t${OLD.stateDir.replace('.', '\\.')}/state.json\\t${names.stateDir.replace('.', '\\.')}/state.json$`, 'm'));
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), `node_modules/\n${names.stateDir}/local/\n`);
  assert.deepEqual(step.plan({ repo, env, names }), { moves: [], conflict: null }, 'a second run has nothing to move');
});

test('untracked state directory: a plain rename, nothing staged', (t) => {
  const { base, env } = scratch(t);
  const repo = repoWithOldState(base, env, { commit: false });
  const r = step.run({ repo, env, names });
  assert.deepEqual(r.moves.map((m) => [m.what, m.how]), [['state', 'rename']]);
  assert.ok(existsSync(join(repo, names.stateDir, 'state.json')));
  assert.ok(!existsSync(join(repo, OLD.stateDir)));
  assert.equal(git(repo, env, ['diff', '--cached', '--name-only']).trim(), '');
});

test('both directories present: typed refusal, nothing moved (not even the machine data)', (t) => {
  const { base, env, config } = scratch(t);
  const repo = repoWithOldState(base, env, { commit: true });
  mkdirSync(join(repo, names.stateDir));
  writeFileSync(join(repo, names.stateDir, 'state.json'), '{"schema":2,"new":true}\n');
  const oldData = join(config, 'plugins', 'data', OLD.dataDir);
  mkdirSync(oldData, { recursive: true });
  assert.throws(() => step.run({ repo, env, names }), isRefusal);
  assert.ok(existsSync(join(repo, OLD.stateDir, 'state.json')), 'old directory untouched');
  assert.equal(readFileSync(join(repo, names.stateDir, 'state.json'), 'utf8'), '{"schema":2,"new":true}\n');
  assert.ok(existsSync(oldData), 'machine data untouched');
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), `node_modules/\n${OLD.stateDir}/local/\n`);
});

test('machine data directory moves once, projects.json unchanged; not when the current one exists', (t) => {
  const { env, config } = scratch(t);
  const oldData = join(config, 'plugins', 'data', OLD.dataDir);
  const newData = state.machineDataDir(names, env);
  mkdirSync(oldData, { recursive: true });
  writeFileSync(join(oldData, 'projects.json'), '{"schema":1,"projects":{"/x/repo":{}}}\n');
  const r = step.run({ repo: null, env, names });
  assert.deepEqual(r.moves.map((m) => [m.what, m.from, m.to]), [['data', oldData, newData]]);
  assert.equal(readFileSync(join(newData, 'projects.json'), 'utf8'), '{"schema":1,"projects":{"/x/repo":{}}}\n');
  assert.ok(!existsSync(oldData));
  mkdirSync(oldData, { recursive: true });
  assert.deepEqual(step.run({ repo: null, env, names }).moves, [], 'the current directory exists: the old one stays');
  assert.ok(existsSync(oldData));
});

test('migrate runs the layout step first and reports the moves; a dry run only lists them', (t) => {
  const { base, env } = scratch(t);
  const repo = repoWithOldState(base, env, { commit: true });
  const io = { cwd: repo, env };
  const dry = migrate({ flags: { dryRun: true }, io, names });
  assert.equal(dry.data.layout.moves.length, 1);
  assert.ok(existsSync(join(repo, OLD.stateDir)), 'dry run moves nothing');
  const r = migrate({ flags: {}, io, names });
  assert.equal(r.data.layout.moves.length, 1);
  assert.ok(r.text.includes(`moved ${join(repo, OLD.stateDir)}/ -> ${join(repo, names.stateDir)}/`), r.text);
  assert.ok(existsSync(join(repo, names.stateDir, 'state.json')));
  assert.ok(!existsSync(join(repo, OLD.stateDir)));
});
