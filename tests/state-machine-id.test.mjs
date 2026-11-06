// machine id (T-MG-210): stable across host-name changes (macOS DHCP names), legacy markers adopted, fallback to the host name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const pluginDir = join(plugins, readdirSync(plugins).find((d) => existsSync(join(plugins, d, 'lib', 'name.json'))));
const lib = (p) => pathToFileURL(join(pluginDir, 'lib', p)).href;
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(lib('state/index.mjs'));
const machine = await import(lib('state/machine.mjs'));
const UUID = '8B5C1E2A-1111-4222-8333-444455556666';
const MID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('a host-name change keeps the id when the platform identity is the same', () => {
  const a = machine.idFor({ hostname: 'term1.local', identity: UUID });
  const b = machine.idFor({ hostname: 'term7.local', identity: UUID });
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, b);
  assert.notEqual(a, machine.idFor({ hostname: 'term1.local', identity: MID }), 'another identity is another machine');
});

test('without an identity the id is the host-name formula, as before', () => {
  const h = machine.idFor({ hostname: 'term1.local', identity: null });
  assert.notEqual(h, machine.idFor({ hostname: 'term2.local', identity: null }));
  assert.equal(h, machine.idFor({ hostname: 'term1.local', identity: undefined }));
  assert.equal(machine.legacyId(), machine.idFor({ hostname: hostname(), identity: null }));
});

test('a malformed identity is ignored', () => {
  const fallback = machine.idFor({ hostname: 'h', identity: null });
  for (const bad of ['', 'not-a-uuid', `${UUID}x`, 'zz'.repeat(16), MID.slice(1), `${MID}\n${MID}`, 42, {}]) {
    assert.equal(machine.idFor({ hostname: 'h', identity: bad }), fallback, JSON.stringify(bad));
  }
});

test('the identity readers parse strictly and fall back to null', () => {
  const ok = `+-o Root\n    "IOPlatformUUID" = "${UUID}"\n`;
  assert.equal(machine.macIdentity(() => ({ status: 0, stdout: ok })), UUID);
  assert.equal(machine.macIdentity(() => ({ status: 0, stdout: '"IOPlatformUUID" = "nope"' })), null);
  assert.equal(machine.macIdentity(() => ({ status: null, error: new Error('timeout'), stdout: ok })), null);
  assert.equal(machine.macIdentity(() => ({ status: 1, stdout: ok })), null);
  assert.equal(machine.macIdentity(() => { throw new Error('x'); }), null);
  const files = { '/etc/machine-id': 'garbage\n', '/var/lib/dbus/machine-id': `${MID}\n` };
  const read = (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };
  assert.equal(machine.linuxIdentity(read), MID, 'the first well-formed one');
  assert.equal(machine.linuxIdentity(() => { throw new Error('ENOENT'); }), null);
});

function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-machine-id-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  assert.equal(spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { env: ISO.env }).status, 0);
  const store = join(dir, names.stateDir);
  mkdirSync(join(store, 'local'), { recursive: true });
  writeFileSync(join(store, 'state.json'), `${JSON.stringify({ schema: state.KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: '2026-10-15T05:42:00.000Z' }, null, 2)}\n`);
  return store;
}

test('a legacy marker is ours, nothing moves aside, the next write rewrites it', (t) => {
  const store = repo(t);
  writeFileSync(join(store, 'local', '.machine'), `${machine.legacyId()}\n`);
  assert.deepEqual(machine.localForeign(store), { foreign: false, why: 'ours' });
  state.open(store, { names }).write('config', null, { flags: { lanes: 'off' } });
  assert.equal(readFileSync(join(store, 'local', '.machine'), 'utf8').trim(), state.machineId());
  assert.deepEqual(readdirSync(store).filter((n) => n.startsWith('local.foreign-')), []);
});

test('any other marker stays foreign', (t) => {
  const store = repo(t);
  writeFileSync(join(store, 'local', '.machine'), `${'0'.repeat(32)}\n`);
  assert.deepEqual(machine.localForeign(store), { foreign: true, why: 'marked by another machine' });
});

const ID = { value: UUID, expected: true };
const GONE = { value: null, expected: true };

test('identity written, then unavailable: ownership unknown, nothing moves aside, recovers', (t) => {
  t.after(() => machine.setIdentityProbe(null));
  const store = repo(t);
  machine.setIdentityProbe(() => ID);
  state.open(store, { names }).write('config', null, { flags: { lanes: 'off' } });
  const marker = readFileSync(join(store, 'local', '.machine'), 'utf8').trim();
  assert.equal(marker, machine.machineId());
  machine.setIdentityProbe(() => GONE);
  assert.deepEqual(machine.localForeign(store), { foreign: true, unknown: true, why: 'ownership unknown (machine identity unavailable)' });
  assert.throws(() => state.open(store, { names }).write('config', null, { flags: { lanes: 'on' } }));
  assert.deepEqual(readdirSync(store).filter((n) => n.startsWith('local.foreign-')), []);
  assert.equal(readFileSync(join(store, 'local', '.machine'), 'utf8').trim(), marker);
  machine.setIdentityProbe(() => ID);
  assert.deepEqual(machine.localForeign(store), { foreign: false, why: 'ours' });
});

test('a failed lookup is retried and a found identity is cached', (t) => {
  t.after(() => machine.setIdentityProbe(null));
  let calls = 0;
  let out = GONE;
  machine.setIdentityProbe(() => { calls++; return out; });
  const host = machine.machineId();
  machine.machineId();
  assert.equal(calls, 2);
  out = ID;
  assert.notEqual(machine.machineId(), host);
  machine.machineId();
  assert.equal(calls, 3);
});

test('a legacy marker is adopted while the identity is available; unavailable it is the current id', (t) => {
  t.after(() => machine.setIdentityProbe(null));
  const store = repo(t);
  writeFileSync(join(store, 'local', '.machine'), `${machine.legacyId()}\n`);
  machine.setIdentityProbe(() => ID);
  assert.deepEqual(machine.localForeign(store), { foreign: false, why: 'ours' });
  machine.setIdentityProbe(() => GONE);
  assert.deepEqual(machine.localForeign(store), { foreign: false, why: 'ours' });
  machine.setIdentityProbe(() => ({ value: null, expected: false }));
  writeFileSync(join(store, 'local', '.machine'), `${'0'.repeat(32)}\n`);
  assert.deepEqual(machine.localForeign(store), { foreign: true, why: 'marked by another machine' });
});

test('ioreg is spawned with a minimal environment', () => {
  const src = readFileSync(join(pluginDir, 'lib', 'state', 'machine.mjs'), 'utf8');
  assert.match(src, /ioreg[^\n]*env: \{ LC_ALL: 'C' \}/);
});
