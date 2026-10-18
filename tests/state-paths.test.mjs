// Path fuzz (review round 1, item 1 and the generator-level addition): a symbolic link, or a name that differs
// only in case, at every position of the store's paths, against every state operation. Invariants:
//   1. nothing outside the store and no differently-cased entry is ever written, moved or removed;
//   2. an operation whose path passes through a symbolic link refuses with state-invalid (never follows it);
//   3. on a case-insensitive volume, an operation whose path passes through a differently-cased entry refuses
//      too (on a case-sensitive volume that entry is simply another name and is left alone).
// The store root's own spelling comes from resolution (git top level, real path) and is not fuzzed for case.
// Keys that differ only in case are invalid keys (the key patterns are case-sensitive).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const { KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const task = (id, extra = {}) => ({ schema: KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null, ...extra });
const FILES = {
  'state.json': { schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT },
  'team/AB.json': { schema: KINDS.team.version, handle: 'AB', emailSha256: state.emailHash('ab@example.com'), addedAt: AT },
  'tasks/T-AB-1/task.json': task('T-AB-1'),
  'tombstones/T-AB-9.json': { schema: KINDS.tombstone.version, id: 'T-AB-9', retiredAt: AT, by: 'AB', reason: 'x' },
  'decisions/D-AB-1.md': '# D-AB-1\n',
  'local/ids/.keep': '',
};
// Every position an operation can pass through ('' is the store root).
// local/lock is the store lock (findings-r2): absent between writes, so the fuzz plants it.
const POSITIONS = ['', 'state.json', 'team', 'team/AB.json', 'tasks', 'tasks/T-AB-1', 'tasks/T-AB-1/task.json', 'tombstones', 'decisions', 'local', 'local/lock', 'local/ids'];
const STORE_WRITE = ['', 'state.json', 'local', 'local/lock'];
const TASKS = ['tasks', 'tasks/T-AB-1', 'tasks/T-AB-1/task.json'];
// Operation → the positions its paths pass through.
const OPS = [
  ['read task', (s) => s.read('task', 'T-AB-1'), ['', ...TASKS]],
  ['list tasks', (s) => s.list('task'), ['', ...TASKS]],
  ['read state', (s) => s.read('state'), ['', 'state.json']],
  ['write task', (s) => s.write('task', 'T-AB-1', task('T-AB-1', { title: 'w' })), [...STORE_WRITE, ...TASKS]],
  ['update task', (s) => s.update('task', 'T-AB-1', (d) => ({ ...d, round: 1 })), [...STORE_WRITE, ...TASKS]],
  ['create task', (s) => s.create('task', 'T-AB-7', task('T-AB-7')), [...STORE_WRITE, ...TASKS]],
  ['allocate task', (s) => state.allocateId(s, { prefix: 'T', handle: 'AB', build: (id) => task(id) }), [...STORE_WRITE, 'team', 'team/AB.json', ...TASKS, 'tombstones', 'local/ids']],
  ['allocate decision', (s) => state.allocateId(s, { prefix: 'D', handle: 'AB', build: (id) => `# ${id}\n` }), [...STORE_WRITE, 'team', 'team/AB.json', 'decisions', 'tombstones', 'local/ids']],
  ['retire', (s) => state.retireId(s, 'T-AB-1', { by: 'AB', reason: 'r', at: AT }), [...STORE_WRITE, 'tombstones']],
  ['register', (s) => state.registerHandle(s, { name: 'Zed Zee', email: 'zz@example.com', at: AT }), [...STORE_WRITE, 'team', 'team/AB.json']],
  // A migration holds the lock and walks the store (local/ is never walked): any link refuses; a case alias
  // refuses where it names a state file (decisions/*.md are not state kinds of this unit).
  ['migrate', (s) => state.migrate(s), POSITIONS.filter((p) => p !== 'local/ids'), POSITIONS.filter((p) => p !== 'local/ids' && p !== 'decisions')],
];

function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(`L ${r}`);
      else if (st.isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}
function build(base) {
  const dir = join(base, 'repo', names.stateDir);
  for (const [rel, v] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof v === 'string' ? v : json(v));
  }
  return dir;
}
const swapCase = (name) => name.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

test('symbolic link at every position × every operation: refused, never followed, nothing outside touched', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-paths-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  let refusals = 0;
  for (const pos of POSITIONS) {
    for (const [label, op, touches] of OPS) {
      const caseDir = join(base, `${POSITIONS.indexOf(pos)}-${label.replace(/\W+/g, '-')}`);
      const dir = build(caseDir);
      const outside = join(caseDir, 'outside');
      const real = join(dir, pos);
      const moved = join(outside, pos || 'root');
      mkdirSync(dirname(moved), { recursive: true });
      if (existsSync(real)) {
        cpSync(real, moved, { recursive: true });
        rmSync(real, { recursive: true });
      } else mkdirSync(moved, { recursive: true });
      symlinkSync(moved, real);
      const before = snapshot(outside);
      let error = null;
      try { op(state.open(dir, { names })); } catch (e) { error = e; }
      assert.deepEqual(snapshot(outside), before, `link at /${pos}, ${label}: nothing outside touched`);
      if (touches.includes(pos)) {
        assert.ok(error instanceof state.StateError && error.code === 'state-invalid' && /symbolic link/.test(error.message), `link at /${pos}, ${label}: refused (${error?.code} ${error?.message})`);
        refusals++;
      }
      assert.ok(lstatSync(real).isSymbolicLink(), `link at /${pos}, ${label}: the link itself stays`);
    }
  }
  assert.ok(refusals > 60, `refusals exercised (${refusals})`);
});

test('a name differing only in case at every position × every operation', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-paths-case-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, 'probe'), '');
  const foldsCase = existsSync(join(base, 'PROBE')) && statSync(join(base, 'PROBE')).ino === statSync(join(base, 'probe')).ino;
  let refusals = 0;
  for (const pos of POSITIONS.filter(Boolean)) {
    for (const [label, op, linkTouches, caseTouches] of OPS) {
      const touches = caseTouches ?? linkTouches;
      const caseDir = join(base, `${POSITIONS.indexOf(pos)}-${label.replace(/\W+/g, '-')}`);
      const dir = build(caseDir);
      const parts = pos.split('/');
      const variant = [...parts.slice(0, -1), swapCase(parts.at(-1))].join('/');
      if (!existsSync(join(dir, pos))) mkdirSync(join(dir, pos));
      renameSync(join(dir, pos), join(dir, `${variant}.tmp-move`));
      renameSync(join(dir, `${variant}.tmp-move`), join(dir, variant));
      const beforeBytes = lstatSync(join(dir, variant)).isFile() ? readFileSync(join(dir, variant)) : null;
      const before = beforeBytes ? null : snapshot(join(dir, variant));
      let error = null;
      try { op(state.open(dir, { names })); } catch (e) { error = e; }
      assert.ok(readdirSync(join(dir, dirname(variant))).includes(variant.split('/').at(-1)), `case variant /${variant}, ${label}: the entry keeps its name`);
      if (beforeBytes) assert.ok(readFileSync(join(dir, variant)).equals(beforeBytes), `case variant /${variant}, ${label}: untouched`);
      else assert.deepEqual(snapshot(join(dir, variant)), before, `case variant /${variant}, ${label}: untouched`);
      if (foldsCase && touches.includes(pos)) {
        assert.ok(error instanceof state.StateError && error.code === 'state-invalid' && /case/.test(error.message), `case variant /${variant}, ${label}: refused (${error?.code} ${error?.message})`);
        refusals++;
      }
    }
  }
  if (foldsCase) assert.ok(refusals > 50, `refusals exercised (${refusals})`);
});

test('keys that differ only in case are invalid keys', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-paths-keys-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const s = state.open(build(base), { names });
  for (const [kind, key] of [['task', 't-AB-1'], ['task', 'T-ab-1'], ['team', 'Ab'], ['tombstone', 't-AB-9']]) {
    assert.throws(() => s.read(kind, key), (e) => e.code === 'invalid-key' && e.exit === 'USAGE', `${kind} ${key}`);
  }
});

// ---- Review round 2, item B (rereview-r1): lock bookkeeping paths are store paths too ----
// A static symbolic link where the store keeps its lock (round 1: local/locks/store.lock.readers; round 2:
// local/lock) must not make a write or a migration create or remove anything outside the store.
test('a symbolic link at a lock path: nothing outside the store is written or removed (rereview item B)', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-paths-lock-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = build(base);
  mkdirSync(join(dir, 'local', 'locks'), { recursive: true });
  const outside = join(base, 'outside');
  mkdirSync(join(outside, 'readers'), { recursive: true });
  mkdirSync(join(outside, 'lock'), { recursive: true });
  writeFileSync(join(outside, 'readers', '999.abcdef.reader'), '{}');
  symlinkSync(join(outside, 'readers'), join(dir, 'local', 'locks', 'store.lock.readers'));
  symlinkSync(join(outside, 'lock'), join(dir, 'local', 'lock'));
  const before = snapshot(outside);
  // A traced write: every mutating file system call is recorded.
  const STATE = pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const state = await import(${JSON.stringify(STATE)});
const touched = [];
for (const fn of ['openSync', 'writeFileSync', 'mkdirSync', 'renameSync', 'linkSync', 'rmSync', 'unlinkSync', 'rmdirSync']) {
  const real = fs[fn];
  fs[fn] = (...a) => { if (fn !== 'openSync' || /[wax+]/.test(String(a[1]))) touched.push(fn + ' ' + String(a[0])); return real(...a); };
}
syncBuiltinESMExports();
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)}, lockTimeoutMs: 2000 });
let out = 'ok';
try { s.write('task', 'T-AB-1', ${JSON.stringify(task('T-AB-1', { title: 'via link' }))}); } catch (e) { out = e.code; }
try { state.migrate(s); } catch (e) { out += ' ' + e.code; }
process.stdout.write(JSON.stringify({ out, touched }));`], { encoding: 'utf8', env: { ...ISO.env, PATH: process.env.PATH, HOME: base } });
  assert.equal(r.status, 0, r.stderr);
  const { touched, out } = JSON.parse(r.stdout);
  assert.equal(out, 'state-invalid state-invalid', 'both refuse because of the link (not a lock timeout)');
  const real = realpathSync(outside);
  assert.deepEqual(touched.filter((p) => p.includes(outside) || p.includes(real) || p.includes('store.lock.readers') || /local\/lock(\/|$)/.test(p)), [], 'no call through the links');
  assert.deepEqual(snapshot(outside), before, 'the outside directories are untouched (the dead marker there stays)');
});

// S3 (harness: "unlock refused (state-invalid)"): realpath names where an entry is now. On macOS it opens the
// entry and asks the system for its path, so a lock released (renamed to lock.released-<token>) between the
// lstat and the realpath comes back under its new name. That is not a case alias: the operation goes on as if
// the lock had already gone. Deterministic: realpath itself performs the release at that moment.
test('an entry renamed while its path is checked is not a case alias (S3)', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-paths-race-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const realNative = realpathSync.native;
  t.after(() => { realpathSync.native = realNative; });
  const plant = (dir) => {
    mkdirSync(join(dir, 'local', 'lock'), { recursive: true });
    writeFileSync(join(dir, 'local', 'lock', 'owner.json'), JSON.stringify({ pid: 999999, token: '999999.0123456789abcdef', host: 'h', startedAt: AT })); // SYNTH lock token
  };
  // The holder releases while realpath looks at the lock: realpath reports the released name.
  const releaseDuringRealpath = () => {
    let fired = 0;
    realpathSync.native = (p, ...a) => {
      if (!fired && String(p).endsWith('/local/lock')) {
        fired++;
        const gone = `${p}.released-999999.0123456789abcdef`;
        renameSync(p, gone);
        return realNative(gone, ...a);
      }
      return realNative(p, ...a);
    };
    return () => fired;
  };
  const results = {};
  for (const [label, op] of [
    ['write', (s) => { s.write('task', 'T-AB-1', task('T-AB-1', { title: 'raced' })); return s.read('task', 'T-AB-1').title; }],
    ['unlock', (s) => state.unlockStale(s).removed],
  ]) {
    const dir = build(join(base, label));
    plant(dir);
    const fired = releaseDuringRealpath();
    const s = state.open(dir, { names, lockTimeoutMs: 2000 });
    try { results[label] = op(s); } catch (e) { results[label] = `${e.code}: ${e.message}`; }
    realpathSync.native = realNative;
    assert.equal(fired(), 1, `${label}: the release happened during the path check`);
  }
  assert.deepEqual(results, { write: 'raced', unlock: false }, 'the write goes on, the unlock finds nothing to remove');
  // A real case alias is still refused (the case fuzz above covers every position).
  writeFileSync(join(base, 'probe'), '');
  if (existsSync(join(base, 'PROBE'))) {
    const dir = build(join(base, 'alias'));
    renameSync(join(dir, 'local'), join(dir, 'Local'));
    assert.throws(() => state.open(dir, { names, lockTimeoutMs: 2000 }).write('task', 'T-AB-1', task('T-AB-1')), (e) => e.code === 'state-invalid' && /differs in case/.test(e.message));
  }
});
