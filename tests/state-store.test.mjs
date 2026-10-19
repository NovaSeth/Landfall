// State store (spec §4.3, §5, §5.4, §8.1, SD-10, SC10, GC2, GC9): typed reads and writes of state files.
// Opening and reading write nothing. A store or file with a newer schema refuses every write with exit 7
// (REFUSED) and an instruction, before any byte is written (tree hashed before and after). Reads of an older
// file are upgraded in memory and write nothing. Writes are validated (exit 2, never truncated), atomic, and
// updates are locked read-modify-write (N processes, no lost update).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
isolateProcessEnv();

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
const { EXIT } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);
const { KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-store-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, dir: join(base, 'repo', names.stateDir), env: { PATH: process.env.PATH, HOME: join(base, 'home'), LANG: 'C' } };
}
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}
const put = (dir, rel, value) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const stateDoc = (extra = {}) => ({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT, ...extra });
const team = (h) => ({ schema: KINDS.team.version, handle: h, emailSha256: 'b'.repeat(64), addedAt: AT });
const task = (id, extra = {}) => ({ schema: KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null, ...extra });
// An active store: state.json, one handle, two tasks.
function active(dir) {
  put(dir, 'state.json', stateDoc());
  put(dir, 'team/AB.json', team('AB'));
  put(dir, 'tasks/T-AB-1/task.json', task('T-AB-1'));
  put(dir, 'tasks/T-AB-2/task.json', task('T-AB-2'));
  return state.open(dir, { names });
}
const is = (code, exit) => (e) => e instanceof state.StateError && e.code === code && e.exit === exit;

test('open, read and list write nothing; an absent store is inactive and empty (zero footprint)', (t) => {
  const { base, dir } = scratch(t);
  const s = state.open(dir, { names });
  assert.equal(s.active, false);
  assert.equal(s.read('task', 'T-AB-1'), null);
  assert.equal(s.read('state'), null);
  assert.deepEqual(s.list('task'), []);
  assert.equal(existsSync(join(base, 'repo')), false, 'nothing created');
  assert.throws(() => state.open(dir), /names/);
  assert.throws(() => state.open('relative/dir', { names }), /absolute/);
});

test('write: validated, stamped with the kind schema, canonical bytes, round-trips through read', (t) => {
  const { dir } = scratch(t);
  const s = state.open(dir, { names });
  const { schema, ...noSchema } = task('T-AB-7', { title: 'x' });
  const written = s.write('task', 'T-AB-7', noSchema);
  assert.equal(written.schema, KINDS.task.version);
  assert.equal(readFileSync(join(dir, 'tasks/T-AB-7/task.json'), 'utf8'), state.serialize(KINDS.task, task('T-AB-7', { title: 'x' })));
  assert.deepEqual(s.read('task', 'T-AB-7'), task('T-AB-7', { title: 'x' }));
  assert.deepEqual(s.list('task'), ['T-AB-7']);
  s.write('state', null, stateDoc());
  assert.equal(s.active, true);
});

test('write refusals come before any byte: over a limit (exit 2), key mismatch, invalid key, wrong schema', (t) => {
  const { base, dir } = scratch(t);
  const s = state.open(dir, { names });
  const before = snapshot(base);
  assert.throws(() => s.write('task', 'T-AB-1', task('T-AB-1', { title: 't'.repeat(121) })), (e) => is('limit-exceeded', 'USAGE')(e) && EXIT[e.exit] === 2);
  assert.throws(() => s.write('task', 'T-AB-1', task('T-AB-2')), is('invalid-value', 'USAGE'));
  assert.throws(() => s.write('task', '../../escape', task('T-AB-1')), is('invalid-key', 'USAGE'));
  assert.throws(() => s.write('task', 'T-AB-1', task('T-AB-1', { schema: KINDS.task.version + 1 })), is('invalid-value', 'USAGE'));
  assert.throws(() => s.create('team', 'AB', { ...team('AB'), extra: 1 }), is('invalid-value', 'USAGE'));
  assert.throws(() => s.read('team', 'toolong'), is('invalid-key', 'USAGE'));
  assert.throws(() => s.write('nope', 'x', {}), /unknown kind/);
  assert.deepEqual(snapshot(base), before);
});

// SC10: every write API on a store whose state.json is newer than this plugin: exit 7, instruction, 0 bytes.
const WRITES = [
  ['write', (s) => s.write('task', 'T-AB-1', task('T-AB-1', { title: 'changed' }))],
  ['write new', (s) => s.write('task', 'T-AB-9', task('T-AB-9'))],
  ['update', (s) => s.update('task', 'T-AB-1', (d) => ({ ...d, round: 1 }))],
  ['create', (s) => s.create('team', 'CD', team('CD'))],
  ['write state', (s) => s.write('state', null, stateDoc())],
];

test('SC10: a newer store schema refuses every write with exit 7 and an instruction; 0 bytes written', (t) => {
  const { base, dir } = scratch(t);
  active(dir);
  put(dir, 'state.json', stateDoc({ schema: KINDS.state.version + 1, futureField: { x: 1 } }));
  const before = snapshot(base);
  for (const [label, write] of WRITES) {
    const s = state.open(dir, { names });
    assert.throws(() => write(s), (e) => is('schema-newer', 'REFUSED')(e) && EXIT[e.exit] === 7
      && e.message.includes(String(KINDS.state.version + 1)) && e.hint.includes(`claude plugin update ${names.plugin}@${names.marketplace}`), label);
    assert.deepEqual(snapshot(base), before, `${label}: no byte written (no lock, no temp, no directory)`);
  }
  // Read-only use keeps working for kinds whose files are still readable.
  assert.equal(state.open(dir, { names }).read('task', 'T-AB-1').id, 'T-AB-1');
});

test('SC10 end to end: the refusal is a CLI envelope with exit 7 REFUSED', async (t) => {
  const { dir } = scratch(t);
  active(dir);
  put(dir, 'state.json', stateDoc({ schema: KINDS.state.version + 1 }));
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: true, env: {}, cwd: dir };
  const probe = {
    name: 'probe', summary: 'test row', details: [], args: [], flags: [], exits: ['OK', 'REFUSED'],
    load: async () => () => {
      try { state.open(dir, { names }).write('task', 'T-AB-1', task('T-AB-1')); return {}; } catch (e) { if (e instanceof state.StateError) return { code: EXIT[e.exit], errors: [e] }; throw e; }
    },
  };
  const code = await main(['probe', '--json'], { commands: [probe], io });
  assert.equal(code, 7);
  const env = JSON.parse(out.join(''));
  assert.deepEqual([env.ok, env.code, env.exit, env.errors[0].code], [false, 7, 'REFUSED', 'schema-newer']);
  assert.match(env.errors[0].hint, /update the plugin/);
});

// Review round 1, item 6: a newer file of a kind refuses every write of that kind (the newer plugin may rely
// on all files of the kind); other kinds still write.
test('a newer file in a current store: writes of its kind refuse with 0 bytes; other kinds still write', (t) => {
  const { base, dir } = scratch(t);
  const s = active(dir);
  put(dir, 'tasks/T-AB-2/task.json', task('T-AB-2', { schema: KINDS.task.version + 1, future: true }));
  const before = snapshot(base);
  for (const write of [() => s.write('task', 'T-AB-2', task('T-AB-2')), () => s.update('task', 'T-AB-2', (d) => d), () => s.write('task', 'T-AB-1', task('T-AB-1', { title: 'sibling' })), () => s.create('task', 'T-AB-3', task('T-AB-3'))]) {
    assert.throws(write, is('schema-newer', 'REFUSED'));
    assert.deepEqual(snapshot(base), before);
  }
  assert.throws(() => s.read('task', 'T-AB-2'), is('schema-newer', 'REFUSED'), 'the task reader declares no forward compatibility');
  assert.equal(s.read('task', 'T-AB-1').title, 'Task T-AB-1', 'current siblings stay readable');
  assert.equal(s.create('team', 'CD', team('CD')), true, 'another kind still writes');
});

// A kind defined for the tests: schema 3, reached from 1 by two migrations; readable up to schema 4.
const note = state.defineKind('note', 3, {
  dir: 'notes', keyPattern: /^[a-z]{1,10}$/, file: (k) => `notes/${k}.json`, match: /^notes\/([a-z]{1,10})\.json$/, key: 'id', readUpTo: 4,
  fields: { id: { t: 'str', max: 10 }, text: { t: 'str', max: 50 }, size: { t: 'int', min: 0, max: 1000 } },
});
const NOTE_MIGRATIONS = [
  { id: '001-note-text', kind: 'note', from: 1, to: 2, up: (d) => { const { body, ...rest } = d; return { ...rest, text: body }; } },
  { id: '002-note-size', kind: 'note', from: 2, to: 3, up: (d) => ({ ...d, size: d.text.length }) },
];
const noteStore = (dir) => state.open(dir, { names, kinds: { ...KINDS, note }, migrations: NOTE_MIGRATIONS });

test('an older file is read upgraded in memory through the migration chain; nothing is written', (t) => {
  const { base, dir } = scratch(t);
  put(dir, 'state.json', stateDoc());
  put(dir, 'notes/a.json', { schema: 1, id: 'a', body: 'hello' });
  put(dir, 'notes/b.json', { schema: 2, id: 'b', text: 'hi' });
  const before = snapshot(base);
  const s = noteStore(dir);
  assert.deepEqual(s.read('note', 'a'), { schema: 3, id: 'a', text: 'hello', size: 5 });
  assert.deepEqual(s.read('note', 'b'), { schema: 3, id: 'b', text: 'hi', size: 2 });
  assert.deepEqual(snapshot(base), before);
  // An update of an older file writes the current schema.
  assert.deepEqual(s.update('note', 'a', (d) => ({ ...d, text: 'hello!' })), { schema: 3, id: 'a', text: 'hello!', size: 5 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'notes/a.json'), 'utf8')).schema, 3);
  // Schema 4 is readable (readUpTo) but never written over; while it exists, no note is written (item 6).
  put(dir, 'notes/c.json', { schema: 4, id: 'c', text: 'future', size: 1, more: true });
  assert.equal(s.read('note', 'c').more, true);
  assert.throws(() => s.write('note', 'c', { id: 'c', text: 'x', size: 1 }), is('schema-newer', 'REFUSED'));
  assert.throws(() => s.update('note', 'a', (d) => d), is('schema-newer', 'REFUSED'));
  rmSync(join(dir, 'notes/c.json'));
  // A missing step is a bug, reported as such.
  put(dir, 'notes/d.json', { schema: 1, id: 'd', body: 'old' });
  assert.throws(() => state.open(dir, { names, kinds: { ...KINDS, note }, migrations: NOTE_MIGRATIONS.slice(1) }).read('note', 'd'), is('migration-missing', 'INTERNAL'));
});

test('corrupt files: reads and updates fail with state-invalid (exit 1) and write nothing; a full write repairs', (t) => {
  const { base, dir } = scratch(t);
  const s = active(dir);
  for (const bad of ['{"schema":1,', '[]', '{"title":"no schema"}', JSON.stringify({ ...task('T-AB-1'), round: -1 }), JSON.stringify(task('T-AB-2'))]) {
    put(dir, 'tasks/T-AB-1/task.json', bad);
    const before = snapshot(base);
    assert.throws(() => s.read('task', 'T-AB-1'), (e) => is('state-invalid', 'FAIL')(e) && EXIT[e.exit] === 1, bad);
    assert.throws(() => s.update('task', 'T-AB-1', (d) => d), is('state-invalid', 'FAIL'), bad);
    assert.deepEqual(snapshot(base), before, `${bad}: nothing written, locks and temporary files included (review item 12)`);
  }
  s.write('task', 'T-AB-1', task('T-AB-1'));
  assert.equal(s.read('task', 'T-AB-1').id, 'T-AB-1');
  // A corrupt state.json blocks every write (its schema cannot be known).
  put(dir, 'state.json', 'garbage');
  assert.throws(() => s.write('task', 'T-AB-1', task('T-AB-1')), is('state-invalid', 'FAIL'));
});

test('create is exclusive; update passes a copy and writes nothing when fn returns undefined', (t) => {
  const { dir } = scratch(t);
  const s = active(dir);
  assert.equal(s.create('team', 'CD', team('CD')), true);
  assert.equal(s.create('team', 'CD', { ...team('CD'), emailSha256: 'c'.repeat(64) }), false);
  assert.equal(s.read('team', 'CD').emailSha256, 'b'.repeat(64));
  const file = join(dir, 'tasks/T-AB-1/task.json');
  const bytes = readFileSync(file, 'utf8');
  const seen = s.update('task', 'T-AB-1', (d) => { d.title = 'mutated copy'; return undefined; });
  assert.equal(seen.title, 'Task T-AB-1', 'the stored document is returned unchanged');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(s.update('task', 'T-AB-404', (d) => (d === null ? task('T-AB-404') : d)).id, 'T-AB-404', 'fn sees null for a missing file');
});

test('list: keys of existing files only, in natural order', (t) => {
  const { dir } = scratch(t);
  const s = active(dir);
  for (const id of ['T-AB-10', 'T-CD-3', 'T-AB-9']) s.write('task', id, task(id));
  mkdirSync(join(dir, 'tasks', 'T-AB-11'));
  put(dir, 'tasks/README.md', 'not a task');
  put(dir, 'team/notes.txt', 'x');
  assert.deepEqual(s.list('task'), ['T-AB-1', 'T-AB-2', 'T-AB-9', 'T-AB-10', 'T-CD-3']);
  assert.deepEqual(s.list('team'), ['AB']);
  assert.deepEqual(s.list('state'), [null]);
});

test('a writer killed before rename leaves a temporary file that the next write in that directory sweeps', (t) => {
  const { dir } = scratch(t);
  const s = active(dir);
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  const stale = join(dir, 'tasks/T-AB-1', `.task.json.${deadPid}.0123abcd.tmp`);
  writeFileSync(stale, 'partial');
  s.write('task', 'T-AB-1', task('T-AB-1', { round: 2 }));
  assert.deepEqual(readdirSync(join(dir, 'tasks/T-AB-1')), ['task.json']);
});

test('a lock held by a live process past the timeout: locked (ENV), nothing written', { timeout: 60000 }, async (t) => {
  const { dir } = scratch(t);
  active(dir);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `const state = await import(${JSON.stringify(STATE)});
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)} });
s.update('task', 'T-AB-1', (d) => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); return d; });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((res, rej) => { holder.stdout.once('data', res); holder.once('exit', () => rej(new Error('holder exited'))); });
  const s = state.open(dir, { names, lockTimeoutMs: 200 });
  const bytes = readFileSync(join(dir, 'tasks/T-AB-1/task.json'), 'utf8');
  assert.throws(() => s.update('task', 'T-AB-1', (d) => ({ ...d, round: 3 })), (e) => is('locked', 'ENV')(e) && /another process/.test(e.message));
  assert.equal(readFileSync(join(dir, 'tasks/T-AB-1/task.json'), 'utf8'), bytes);
});

// N processes append events to one task through update(): every event survives (no lost update).
test('concurrent updates of one file from N processes lose nothing', { timeout: 120000 }, async (t) => {
  const { base, dir } = scratch(t);
  active(dir);
  const go = join(base, 'go');
  const n = 6;
  const each = 15;
  const code = (k) => `const state = await import(${JSON.stringify(STATE)});
const { existsSync } = await import('node:fs');
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 1);
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)}, lockTimeoutMs: 60000 });
for (let i = 0; i < ${each}; i++) s.update('task', 'T-AB-1', (d) => ({ ...d, events: [...d.events, { at: ${JSON.stringify(AT)}, by: 'AB', event: 'tick', data: { p: ${k}, i } }] }));`;
  const runs = Array.from({ length: n }, (_, k) => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code(k)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => res({ status, err }));
  }));
  writeFileSync(go, '');
  for (const r of await Promise.all(runs)) assert.equal(r.status, 0, r.err);
  const events = state.open(dir, { names }).read('task', 'T-AB-1').events;
  assert.equal(events.length, n * each);
  assert.equal(new Set(events.map((e) => `${e.data.p}.${e.data.i}`)).size, n * each);
  assert.deepEqual(existsSync(join(dir, 'local')) ? readdirSync(join(dir, 'local')) : [], [], 'the lock is released and local/ is left empty-free');
});

// ---- Review round 1, items 1, 8, 9 ----

// Item 1: a directory inside the store that is a symbolic link is refused, never followed.
test('a symbolic link inside the store is refused, not followed (review item 1)', (t) => {
  const { base, dir } = scratch(t);
  const s = active(dir);
  const outside = join(base, 'outside');
  mkdirSync(outside);
  put(outside, 'task.json', task('T-AB-1', { title: 'outside' }));
  rmSync(join(dir, 'tasks', 'T-AB-1'), { recursive: true });
  symlinkSync(outside, join(dir, 'tasks', 'T-AB-1'));
  const bytes = readFileSync(join(outside, 'task.json'), 'utf8');
  for (const op of [() => s.write('task', 'T-AB-1', task('T-AB-1', { title: 'changed' })), () => s.update('task', 'T-AB-1', (d) => ({ ...d, round: 1 })), () => s.read('task', 'T-AB-1'), () => s.list('task')]) {
    assert.throws(op, (e) => is('state-invalid', 'FAIL')(e) && /symbolic link/.test(e.message));
  }
  assert.equal(readFileSync(join(outside, 'task.json'), 'utf8'), bytes, 'the file outside the store is untouched');
  assert.deepEqual(readdirSync(outside), ['task.json']);
});

// Item 9: update() reads a missing file and is paused; create() of the same file must not succeed and then be
// overwritten.
test('create and update of one file are serialized: a successful create is never lost (review item 9)', { timeout: 60000 }, async (t) => {
  const { base, dir } = scratch(t);
  active(dir);
  const f = (n) => join(base, n);
  const child = (body) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
const state = await import(${JSON.stringify(STATE)});
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)}, lockTimeoutMs: 30000 });
const sleep = new Int32Array(new SharedArrayBuffer(4));
const task = (title) => ({ id: 'T-AB-5', kind: 'task', title, lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null });
${body}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once('exit', r); });
  const a = child(`s.update('task', 'T-AB-5', (d) => {
  fs.writeFileSync(${JSON.stringify(f('paused'))}, String(d));
  while (!fs.existsSync(${JSON.stringify(f('go'))})) Atomics.wait(sleep, 0, 0, 2);
  return d ?? task('from update');
});`);
  t.after(() => a.kill('SIGKILL'));
  // Wait for the content too: the file exists a moment before its content is written.
  for (const end = performance.now() + 60000; performance.now() < end && !(existsSync(f('paused')) && readFileSync(f('paused'), 'utf8') !== '');) await new Promise((r) => setTimeout(r, 5));
  assert.equal(readFileSync(f('paused'), 'utf8'), 'null', 'update saw no file');
  const aDone = exited(a);
  const b = child(`fs.writeFileSync(${JSON.stringify(f('created'))}, String(s.create('task', 'T-AB-5', task('from create'))));`);
  const bDone = exited(b);
  t.after(() => b.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(f('go'), '');
  await Promise.all([aDone, bDone]);
  const created = readFileSync(f('created'), 'utf8') === 'true';
  const title = state.open(dir, { names }).read('task', 'T-AB-5').title;
  assert.equal(created, false, 'create waited for the update and found the file');
  assert.equal(title, 'from update');
});

// ---- Review round 2, item C (rereview-r1) ----
// A finished its sibling-schema check for create(T-AB-2) and is delayed; meanwhile a newer plugin migrates
// T-AB-1 to task schema 2. A must not then create a schema-1 task next to it (the check and the write belong
// under the same lock as the migration).
test('a migration cannot slip between the sibling-schema check and the write (rereview item C)', { timeout: 60000 }, async (t) => {
  const { base, dir } = scratch(t);
  active(dir);
  rmSync(join(dir, 'tasks', 'T-AB-2'), { recursive: true });
  const f = (n) => join(base, n);
  const fixture = join(base, 'newer.mjs');
  writeFileSync(fixture, `const state = await import(${JSON.stringify(STATE)});
const { schema, ...fields } = state.KINDS.task.spec.f;
const task = state.defineKind('task', state.KINDS.task.version + 1, { dir: 'tasks', keyPattern: state.PATTERNS.taskId, file: (id) => 'tasks/' + id + '/task.json', match: state.KINDS.task.match, key: 'id', fields });
const step = { id: '001-task-next', kind: 'task', from: state.KINDS.task.version, to: state.KINDS.task.version + 1, up: (d) => d };
export const newer = (dir, opts = {}) => state.open(dir, { names: ${JSON.stringify(names)}, kinds: { ...state.KINDS, task }, migrations: [step], ...opts });`);
  const spawnOf = (code) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'inherit'] }); const done = new Promise((r) => c.once('exit', r)); t.after(() => c.kill('SIGKILL')); return done; };
  const a = spawnOf(`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const state = await import(${JSON.stringify(STATE)});
const real = fs.readFileSync;
const sleep = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
// Pause right after A has read its sibling T-AB-1 (its schema check of the kind).
fs.readFileSync = (p, ...x) => {
  const out = real(p, ...x);
  if (!paused && String(p) === ${JSON.stringify(join(dir, 'tasks', 'T-AB-1', 'task.json'))}) { paused = true; fs.writeFileSync(${JSON.stringify(f('A-scanned'))}, ''); while (!fs.existsSync(${JSON.stringify(f('goA'))})) Atomics.wait(sleep, 0, 0, 2); }
  return out;
};
syncBuiltinESMExports();
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)}, lockTimeoutMs: 20000 });
let out;
try { out = String(s.create('task', 'T-AB-2', ${JSON.stringify((({ schema, ...x }) => x)(task('T-AB-2')))})); } catch (e) { out = e.code; }
fs.writeFileSync(${JSON.stringify(f('A-out'))}, out);`);
  for (const end = performance.now() + 60000; performance.now() < end && !existsSync(f('A-scanned'));) await new Promise((r) => setTimeout(r, 5));
  assert.ok(existsSync(f('A-scanned')), 'A checked the siblings');
  const b = spawnOf(`const { newer } = await import(${JSON.stringify(pathToFileURL(fixture).href)});
const state = await import(${JSON.stringify(STATE)});
state.migrate(newer(${JSON.stringify(dir)}, { lockTimeoutMs: 20000 }));`);
  await Promise.race([b, new Promise((r) => setTimeout(r, 1500))]);
  writeFileSync(f('goA'), '');
  await Promise.all([a, b]);
  const schemas = readdirSync(join(dir, 'tasks')).filter((d) => existsSync(join(dir, 'tasks', d, 'task.json'))).map((d) => [d, JSON.parse(readFileSync(join(dir, 'tasks', d, 'task.json'), 'utf8')).schema]);
  assert.equal(new Set(schemas.map(([, v]) => v)).size, 1, `A said ${readFileSync(f('A-out'), 'utf8')}; task schemas ${JSON.stringify(schemas)}`);
});

// The store becomes newer while the writer is taking the lock: the refusal leaves the tree as it was — no
// lock, no lock directory, no local/ (findings-r2 point 3).
test('a refusal under the lock leaves no trace: no lock, no local/ (rereview item C)', (t) => {
  const { dir } = scratch(t);
  active(dir);
  const newer = `${JSON.stringify(stateDoc({ schema: KINDS.state.version + 1 }), null, 2)}\n`;
  const before = snapshot(dir).filter((l) => !l.startsWith('F state.json'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const state = await import(${JSON.stringify(STATE)});
const real = { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync };
let bumped = false;
fs.mkdirSync = (p, ...x) => { if (!bumped && String(p).startsWith(${JSON.stringify(dir)})) { bumped = true; real.writeFileSync(${JSON.stringify(join(dir, 'state.json'))}, ${JSON.stringify(newer)}); } return real.mkdirSync(p, ...x); };
syncBuiltinESMExports();
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)} });
try { s.write('task', 'T-AB-1', { id: 'T-AB-1', kind: 'task', title: 'x', lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null }); process.stdout.write('written'); } catch (e) { process.stdout.write(e.code); }`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'schema-newer');
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), newer);
  assert.deepEqual(snapshot(dir).filter((l) => !l.startsWith('F state.json')), before, 'the tree is as before: no lock directory, no local/');
});

// ---- Review round 3 (closing), item 2 (rereview-r2) ----
// A migration started inside an update callback (the lock is held) must not run: round 2 let it re-enter the
// lock, migrate the task to schema 2, and then the update wrote schema 1 over it. Fail closed: the update throws,
// nothing changes.
test('a migration inside an update callback fails closed: no migration, no write (rereview-r2 item 2)', (t) => {
  const { dir } = scratch(t);
  active(dir);
  const { schema, ...fields } = KINDS.task.spec.f;
  const nextTask = state.defineKind('task', KINDS.task.version + 1, { dir: 'tasks', keyPattern: state.PATTERNS.taskId, file: (id) => `tasks/${id}/task.json`, match: KINDS.task.match, key: 'id', fields });
  const nextState = state.defineKind('state', KINDS.state.version + 1, { dir: '', file: () => 'state.json', match: /^state\.json$/, fields: (({ schema: _, ...f }) => f)(KINDS.state.spec.f) });
  const newerTask = state.open(dir, { names, kinds: { ...KINDS, task: nextTask }, migrations: [{ id: '001-task-next', kind: 'task', from: KINDS.task.version, to: KINDS.task.version + 1, up: (d) => d }] });
  const newerStore = state.open(dir, { names, kinds: { ...KINDS, state: nextState }, migrations: [{ id: '001-state-next', kind: 'state', from: KINDS.state.version, to: KINDS.state.version + 1, up: (d) => d }] });
  const s = state.open(dir, { names });
  for (const [label, newer] of [['task schema', newerTask], ['store schema', newerStore]]) {
    const before = snapshot(dir);
    assert.throws(() => s.update('task', 'T-AB-1', (d) => { state.migrate(newer); return { ...d, title: 'downgraded' }; }), (e) => e instanceof state.StateError && e.exit === 'INTERNAL', label);
    assert.deepEqual(snapshot(dir), before, `${label}: nothing migrated, nothing written`);
  }
});

// ---- store.append is a true append (T-MG-32) ----

// Process A is paused between opening the log and writing; a writer outside the store lock adds its line
// meanwhile. A true O_APPEND write puts A's line after it: both lines survive.
test('append: a line written by another appender while one is paused is not lost', { timeout: 60000 }, async (t) => {
  const { base, dir } = scratch(t);
  const s = active(dir);
  s.append('shadow', { at: AT, n: 0 });
  const sig = join(base, 'sig');
  mkdirSync(sig);
  const log = join(dir, 'local', 'shadow.jsonl');
  const code = `const state = await import(${JSON.stringify(STATE)});
state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)} }).append('shadow', { at: ${JSON.stringify(AT)}, n: 1 });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, [`${names.envPrefix}TEST_APPEND_PAUSE`]: sig } });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((res) => child.on('exit', res));
  const deadline = Date.now() + 10000;
  while (!existsSync(join(sig, 'paused'))) {
    assert.ok(Date.now() < deadline, `appender never reached the pause point: ${err}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  appendFileSync(log, `${JSON.stringify({ at: AT, n: 2 })}\n`);
  writeFileSync(join(sig, 'go'), '');
  assert.equal(await exited, 0, err);
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).n);
  assert.deepEqual([...lines].sort(), [0, 1, 2]);
});

test('append: a line over the limit is a typed error and the file is unchanged', (t) => {
  const { dir } = scratch(t);
  const s = active(dir);
  s.append('shadow', { at: AT, n: 0 });
  const log = join(dir, 'local', 'shadow.jsonl');
  const before = readFileSync(log, 'utf8');
  assert.throws(() => s.append('shadow', { at: AT, big: 'x'.repeat(5000) }), is('limit-exceeded', 'USAGE'));
  assert.equal(readFileSync(log, 'utf8'), before);
});
