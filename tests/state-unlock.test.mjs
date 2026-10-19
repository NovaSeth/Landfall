// `<bin> state unlock --stale` (findings-r3): a lock left by a process that is gone is never taken over by a
// write; writes refuse with stale-lock (exit 7) and a hint naming this command, the only way to remove it. The
// command changes files, so it needs a terminal or --yes (REV-58); it refuses a lock whose owner runs (exit 1).
// Runs through the real command table (lib/cli/main.mjs) in a throwaway repository and HOME.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);
const { EXIT } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);
const { KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-unlock-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  assert.equal(spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { env: ISO.env }).status, 0);
  const store = join(dir, names.stateDir);
  mkdirSync(join(store, 'local'), { recursive: true });
  writeFileSync(join(store, 'state.json'), `${JSON.stringify({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT }, null, 2)}\n`);
  const env = { ...ISO.env, HOME: join(base, 'home') };
  return { base, dir, store, env };
}
// A lock taken `ago` ms before now (a dead owner's lock is planted as a year old, so a process that reuses its
// pid meanwhile started later and is not taken for the owner).
const plantLock = (store, pid, ago = 0) => {
  mkdirSync(join(store, 'local', 'lock'));
  writeFileSync(join(store, 'local', 'lock', 'owner.json'), JSON.stringify({ pid, token: `${pid}.0123456789abcdef`, host: hostname(), startedAt: new Date(Date.now() - ago).toISOString() }));
};
async function cli(args, { dir, env, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd: dir };
  const code = await main([...args, '--json'], { io });
  return { code, env: JSON.parse(out.join('')) };
}

test('a lock of a dead process: writes refuse with stale-lock (exit 7) naming the command; unlock removes it; writes work again', async (t) => {
  const { dir, store, env } = repo(t);
  plantLock(store, deadPid(), 365 * 86400000);
  const s = state.open(store, { names });
  const doc = { id: 'T-AB-1', kind: 'task', title: 'x', lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null };
  assert.throws(() => s.write('task', 'T-AB-1', doc), (e) => e.code === 'stale-lock' && EXIT[e.exit] === 7 && e.hint.includes(`${names.bin} state unlock --stale`));
  assert.ok(existsSync(join(store, 'local', 'lock', 'owner.json')), 'not taken over by the write');
  // Consent: no terminal and no --yes → refused, nothing removed.
  const refused = await cli(['state', 'unlock', '--stale'], { dir, env });
  assert.deepEqual([refused.code, refused.env.exit, refused.env.errors[0].code], [7, 'REFUSED', 'consent-required']);
  assert.ok(existsSync(join(store, 'local', 'lock')));
  // --stale is required.
  assert.equal((await cli(['state', 'unlock', '--yes'], { dir, env })).code, 2);
  const done = await cli(['state', 'unlock', '--stale', '--yes'], { dir, env });
  assert.equal(done.code, 0, JSON.stringify(done.env));
  assert.equal(done.env.data.store.removed, true);
  assert.ok(!existsSync(join(store, 'local', 'lock')));
  s.write('task', 'T-AB-1', doc);
  assert.equal(s.read('task', 'T-AB-1').title, 'x');
  const again = await cli(['state', 'unlock', '--stale', '--yes'], { dir, env });
  assert.deepEqual([again.code, again.env.data.store.removed], [0, false], 'nothing to remove');
});

// S3: the command is for a store nobody is using; a lock in use refuses with exit 7 (store-busy), untouched.
test('state unlock refuses a lock whose owner is running (exit 7, store-busy) and leaves it in place', async (t) => {
  const { dir, store, env } = repo(t);
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => live.kill('SIGKILL'));
  plantLock(store, live.pid);
  const bytes = readFileSync(join(store, 'local', 'lock', 'owner.json'), 'utf8');
  const r = await cli(['state', 'unlock', '--stale'], { dir, env, tty: true });
  assert.deepEqual([r.code, r.env.errors[0].code], [EXIT.REFUSED, 'store-busy']);
  assert.equal(readFileSync(join(store, 'local', 'lock', 'owner.json'), 'utf8'), bytes);
});

test('state unlock outside a git repository: exit 8', async (t) => {
  const { base, env } = repo(t);
  mkdirSync(join(base, 'plain'));
  const r = await cli(['state', 'unlock', '--stale', '--yes'], { dir: join(base, 'plain'), env: { ...env, GIT_CEILING_DIRECTORIES: base } });
  assert.deepEqual([r.code, r.env.errors[0].code], [8, 'not-a-repo']);
});
