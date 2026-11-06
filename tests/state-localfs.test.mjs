// lib/state local/ file helpers (T-MG-143): a temporary directory and a file removal under <state>/local/, with the
// foreign-local/ handling of the other local/ writers; and the cause of rethrown errors (COD-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const pluginDir = join(plugins, readdirSync(plugins).find((d) => existsSync(join(plugins, d, 'lib', 'name.json'))));
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const { StateError } = state;

const scratch = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-localfs-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return join(base, names.stateDir);
};

test('localTempDir makes <state>/local/<prefix>XXXX and creates local/ when absent', (t) => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  const made = state.localTempDir(dir, names, 'base-');
  assert.equal(dirname(made), join(dir, 'local'));
  assert.match(made.slice(join(dir, 'local').length + 1), /^base-.+/);
  assert.equal(existsSync(made), true);
});

test('localTempDir moves a foreign local/ aside first, like the other local/ writers', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'local'), { recursive: true });
  writeFileSync(join(dir, 'local', '.machine'), 'another-machine\n');
  writeFileSync(join(dir, 'local', 'keep.txt'), 'x');
  const made = state.localTempDir(dir, names, 'base-');
  assert.equal(existsSync(join(dir, 'local', 'keep.txt')), false, 'the foreign content is not in the fresh local/');
  assert.ok(readdirSync(dir).some((n) => n.startsWith('local.foreign-')), 'moved aside');
  assert.equal(existsSync(made), true);
});

test('removeLocalFile removes a file under local/, ignores a missing one, refuses paths outside local/', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'local', 'runs'), { recursive: true });
  const f = join(dir, 'local', 'runs', 'a.json');
  writeFileSync(f, '{}');
  assert.equal(state.removeLocalFile(dir, names, 'local/runs/a.json'), true);
  assert.equal(existsSync(f), false);
  assert.equal(state.removeLocalFile(dir, names, 'local/runs/a.json'), false);
  writeFileSync(join(dir, 'state.json'), '{}');
  for (const bad of ['state.json', 'local/../state.json', '../x', 'local']) assert.throws(() => state.removeLocalFile(dir, names, bad), TypeError, bad);
  assert.equal(existsSync(join(dir, 'state.json')), true);
});

test('COD-22: a rethrown error keeps the caught one as cause (StateError option, fsFailure, scheduler lock)', async () => {
  const cause = new Error('boom');
  assert.equal(new StateError('x', 'FAIL', 'm', { cause }).cause, cause);
  const { fsFailure } = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'errors.mjs')).href);
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  assert.equal(fsFailure(denied).cause, denied);
  const { locked } = await import(pathToFileURL(join(pluginDir, 'lib', 'sched', 'files.mjs')).href);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cause-')));
  try {
    mkdirSync(join(base, 'leases', 'lock'), { recursive: true });
    writeFileSync(join(base, 'leases', 'lock', 'owner.json'), JSON.stringify({ pid: 999999, token: '1.0123456789abcdef', host: hostname(), startedAt: '2020-01-01T00:00:00.000Z' })); // SYNTH
    let got;
    try { locked(base, () => {}, { names }); } catch (e) { got = e; }
    assert.equal(got?.code, 'scheduler-busy');
    assert.equal(got.cause?.code, 'ESTALE');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
