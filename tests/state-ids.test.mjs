// Per-developer IDs and the handle registry (spec §5.1, §7.2, SD-9, REV-58, SC10): task IDs T-<H>-<n> and
// decision IDs D-<H>-<n>, one series per prefix and handle, allocated by exclusive creation of the object's
// file: N processes allocating on one handle get distinct, gap-free numbers; a number is never reused while
// its file or tombstone exists; content is complete or absent. Handles are 2-4 letters from git user.name
// initials, the next letter on a collision with another developer's email hash; the team file holds only the
// hash. Context (git identity) comes from the target repository.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const { EXIT } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);
const { KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';
const is = (code, exit) => (e) => e instanceof state.StateError && e.code === code && e.exit === exit && EXIT[e.exit] !== undefined;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-ids-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, dir: join(base, 'repo', names.stateDir) };
}
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}
const put = (dir, rel, value) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const stateDoc = (extra = {}) => ({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT, ...extra });
const taskFor = (id, title = `Task ${id}`) => ({ id, kind: 'task', title, lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null });
const sha = (email) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
function store(dir, handles = ['AB']) {
  put(dir, 'state.json', stateDoc());
  for (const h of handles) put(dir, `team/${h}.json`, { schema: KINDS.team.version, handle: h, emailSha256: sha(`${h}@example.com`), addedAt: AT });
  return state.open(dir, { names });
}
const allocT = (s, handle = 'AB', title) => state.allocateId(s, { prefix: 'T', handle, build: (id) => taskFor(id, title) });

test('allocation: one series per prefix and handle, starting at 1; the object file is created with the content', (t) => {
  const { dir } = scratch(t);
  const s = store(dir, ['AB', 'CD']);
  assert.deepEqual([allocT(s), allocT(s), allocT(s, 'CD'), allocT(s)], ['T-AB-1', 'T-AB-2', 'T-CD-1', 'T-AB-3']);
  assert.deepEqual(s.read('task', 'T-AB-2'), { schema: KINDS.task.version, ...taskFor('T-AB-2') });
  const d = state.allocateId(s, { prefix: 'D', handle: 'AB', build: (id) => `---\nid: ${id}\n---\n# Decision\n` });
  assert.equal(d, 'D-AB-1');
  assert.equal(readFileSync(join(dir, 'decisions', 'D-AB-1.md'), 'utf8'), '---\nid: D-AB-1\n---\n# Decision\n');
});

test('never reused: the next number is above every existing object and tombstone; an empty claim directory is free', (t) => {
  const { dir } = scratch(t);
  const s = store(dir);
  for (let i = 0; i < 4; i++) allocT(s);
  assert.equal(state.retireId(s, 'T-AB-4', { by: 'AB', reason: 'created by mistake', at: AT }), true);
  assert.equal(state.retireId(s, 'T-AB-4', { by: 'AB', reason: 'again', at: AT }), false, 'a tombstone is created once');
  rmSync(join(dir, 'tasks', 'T-AB-4'), { recursive: true });
  rmSync(join(dir, 'tasks', 'T-AB-2'), { recursive: true });
  assert.equal(allocT(s), 'T-AB-5', 'the tombstone keeps 4; a hole below the top stays a hole');
  state.retireId(s, 'T-AB-9', { by: 'AB', reason: 'reserved by a teammate', at: AT });
  assert.equal(allocT(s), 'T-AB-10');
  mkdirSync(join(dir, 'tasks', 'T-AB-11'));
  assert.equal(allocT(s), 'T-AB-11', 'a directory without its task file holds no number');
  state.retireId(s, 'D-AB-3', { by: 'AB', reason: 'x', at: AT });
  assert.equal(state.allocateId(s, { prefix: 'D', handle: 'AB', build: () => '# D\n' }), 'D-AB-4');
  assert.deepEqual(s.read('tombstone', 'T-AB-4'), { schema: KINDS.tombstone.version, id: 'T-AB-4', retiredAt: AT, by: 'AB', reason: 'created by mistake' });
});

test('refusals before any byte: unknown handle, bad prefix or handle, invalid content, exhausted series', (t) => {
  const { base, dir } = scratch(t);
  const s = store(dir);
  let before = snapshot(base);
  assert.throws(() => allocT(s, 'ZZ'), is('handle-unknown', 'USAGE'));
  assert.throws(() => state.allocateId(s, { prefix: 'X', handle: 'AB', build: () => '' }), is('invalid-value', 'USAGE'));
  assert.throws(() => allocT(s, 'ab'), is('invalid-value', 'USAGE'));
  assert.throws(() => state.allocateId(s, { prefix: 'T', handle: 'AB', build: (id) => taskFor(id, 't'.repeat(121)) }), is('limit-exceeded', 'USAGE'));
  assert.throws(() => state.allocateId(s, { prefix: 'T', handle: 'AB', build: () => taskFor('T-AB-77') }), is('invalid-value', 'USAGE'), 'the content names another ID');
  assert.throws(() => state.allocateId(s, { prefix: 'D', handle: 'AB', build: () => '' }), is('invalid-value', 'USAGE'));
  assert.throws(() => state.allocateId(s, { prefix: 'D', handle: 'AB', build: () => 'x'.repeat(state.LIMITS.decisionBytes + 1) }), is('limit-exceeded', 'USAGE'));
  assert.throws(() => state.retireId(s, 'T-AB-0', { by: 'AB', reason: 'x', at: AT }), is('invalid-key', 'USAGE'));
  assert.deepEqual(snapshot(base), before);
  state.retireId(s, 'T-AB-999999', { by: 'AB', reason: 'top', at: AT });
  before = snapshot(base);
  assert.throws(() => allocT(s), is('id-space-exhausted', 'USAGE'));
  assert.deepEqual(snapshot(base), before);
});

test('SC10: a newer store refuses allocation, retirement and registration with exit 7; 0 bytes written', (t) => {
  const { base, dir } = scratch(t);
  const s = store(dir);
  put(dir, 'state.json', stateDoc({ schema: KINDS.state.version + 1 }));
  const before = snapshot(base);
  for (const [label, write] of [
    ['allocate', () => allocT(s)],
    ['retire', () => state.retireId(s, 'T-AB-1', { by: 'AB', reason: 'x', at: AT })],
    ['register', () => state.registerHandle(s, { name: 'Zed Zee', email: 'zz@example.com', at: AT })],
    ['register again', () => state.registerHandle(s, { name: 'A B', email: 'AB@example.com', at: AT })],
  ]) {
    assert.throws(write, (e) => is('schema-newer', 'REFUSED')(e) && EXIT[e.exit] === 7, label);
    assert.deepEqual(snapshot(base), before, `${label}: 0 bytes`);
  }
});

// N processes allocate K IDs each on one handle at the same moment.
test('concurrent allocation by N processes: no duplicate, no gap, every file complete and its own', { timeout: 120000 }, async (t) => {
  const { base, dir } = scratch(t);
  store(dir);
  const go = join(base, 'go');
  const n = 8;
  const k = 10;
  const code = (p) => `const state = await import(${JSON.stringify(STATE)});
const { existsSync } = await import('node:fs');
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 1);
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)} });
const ids = [];
for (let i = 0; i < ${k}; i++) ids.push(state.allocateId(s, { prefix: 'T', handle: 'AB', build: (id) => ({ id, kind: 'task', title: 'p${p} #' + i, lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null }) }));
process.stdout.write(JSON.stringify(ids));`;
  const runs = Array.from({ length: n }, (_, p) => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code(p)]);
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => res({ status, out, err, p }));
  }));
  writeFileSync(go, '');
  const results = await Promise.all(runs);
  const all = [];
  for (const r of results) {
    assert.equal(r.status, 0, r.err);
    const ids = JSON.parse(r.out);
    all.push(...ids);
    ids.forEach((id, i) => assert.equal(JSON.parse(readFileSync(join(dir, 'tasks', id, 'task.json'), 'utf8')).title, `p${r.p} #${i}`, `${id} holds the content of the process that got it`));
  }
  assert.equal(new Set(all).size, n * k, 'no duplicate');
  assert.deepEqual(all.map((id) => Number(id.split('-')[2])).sort((a, b) => a - b), Array.from({ length: n * k }, (_, i) => i + 1), 'no gap');
  assert.deepEqual(readdirSync(join(dir, 'tasks')).filter((f) => f.startsWith('.')), [], 'no temporary files');
});

test('handle candidates: initials of git user.name, then the next letters, then the last letter varied', () => {
  const c = state.handleCandidates;
  assert.deepEqual(c('Michal Golebiowski').slice(0, 5), ['MG', 'MGO', 'MGOL', 'MGA', 'MGB']);
  assert.deepEqual(c('Micha\u0142 Go\u0142\u0119biowski').slice(0, 3), ['MG', 'MGO', 'MGOL'], 'diacritics fold to ASCII');
  assert.deepEqual(c('\u00d8laf \u00c6r\u00f8').slice(0, 2), ['OA', 'OAE']);
  assert.deepEqual(c('Stra\u00dfe').slice(0, 3), ['ST', 'STR', 'STRA']);
  assert.deepEqual(c('Anna Maria de la Cruz')[0], 'AMDC', 'more than four words: three initials and the last');
  assert.deepEqual(c('ada').slice(0, 2), ['AD', 'ADA']);
  assert.deepEqual(c('', 'jan.kowalski@example.com')[0], 'JK', 'no name: the email local part');
  assert.deepEqual(c('X')[0], 'XA');
  assert.deepEqual(c('\u674e\u96f7', '12345@example.com'), [], 'nothing derivable');
  for (const name of ['Michal Golebiowski', 'X', 'Anna Maria de la Cruz', 'o', 'Jean-Luc Picard']) {
    const all = c(name);
    assert.ok(all.length >= 26 && all.every((h) => /^[A-Z]{2,4}$/.test(h)) && new Set(all).size === all.length, name);
  }
});

test('registerHandle: idempotent per email, next letter on a collision, explicit handles checked, only the hash stored', (t) => {
  const { dir } = scratch(t);
  const s = store(dir, []);
  const mg = state.registerHandle(s, { name: 'Michal Golebiowski', email: 'Michal@Example.com ', at: AT });
  assert.deepEqual(mg, { handle: 'MG', created: true });
  const file = join(dir, 'team', 'MG.json');
  const bytes = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(bytes), { schema: KINDS.team.version, handle: 'MG', emailSha256: sha('michal@example.com'), addedAt: AT });
  assert.ok(!/example/i.test(bytes), 'no plain email in the team file');
  assert.equal(state.emailHash(' MICHAL@example.com'), sha('michal@example.com'));
  assert.deepEqual(state.registerHandle(s, { name: 'Other Name', email: 'michal@example.com', at: AT }), { handle: 'MG', created: false });
  assert.equal(readFileSync(file, 'utf8'), bytes, 'unchanged');
  assert.deepEqual(state.registerHandle(s, { name: 'Marta Gorska', email: 'marta@example.com', at: AT }), { handle: 'MGO', created: true });
  assert.deepEqual(state.registerHandle(s, { name: 'Zed', email: 'zed@example.com', handle: 'ZZ', at: AT }), { handle: 'ZZ', created: true });
  assert.throws(() => state.registerHandle(s, { name: 'Max G', email: 'max@example.com', handle: 'MG', at: AT }), is('handle-taken', 'USAGE'));
  assert.throws(() => state.registerHandle(s, { name: 'x', email: 'michal@example.com', handle: 'MX', at: AT }), is('handle-mismatch', 'USAGE'));
  assert.throws(() => state.registerHandle(s, { name: 'x', email: 'new@example.com', handle: 'mx', at: AT }), is('invalid-key', 'USAGE'));
  assert.throws(() => state.registerHandle(s, { name: 'x', email: ' ', at: AT }), is('email-required', 'USAGE'));
  assert.throws(() => state.registerHandle(s, { name: '\u674e', email: '1@example.com', at: AT }), is('handle-required', 'USAGE'));
  assert.deepEqual(s.list('team'), ['MG', 'MGO', 'ZZ']);
});

test('concurrent registration: distinct emails get distinct handles; one email gets one handle', { timeout: 120000 }, async (t) => {
  const { base, dir } = scratch(t);
  store(dir, []);
  const go = join(base, 'go');
  const run = (email) => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', `const state = await import(${JSON.stringify(STATE)});
const { existsSync } = await import('node:fs');
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 1);
process.stdout.write(state.registerHandle(state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)} }), { name: 'Michal Golebiowski', email: ${JSON.stringify(email)}, at: ${JSON.stringify(AT)} }).handle);`]);
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => res({ status, out, err, email }));
  });
  const emails = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com', 'f@example.com'];
  const runs = [...emails.map(run), run('a@example.com'), run('a@example.com')];
  writeFileSync(go, '');
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.status, 0, r.err);
  const byEmail = new Map();
  for (const r of results) { if (byEmail.has(r.email)) assert.equal(r.out, byEmail.get(r.email), 'one email, one handle'); byEmail.set(r.email, r.out); }
  assert.equal(new Set(byEmail.values()).size, emails.length, 'distinct handles');
  const s = state.open(dir, { names });
  assert.equal(s.list('team').length, emails.length);
  for (const [email, h] of byEmail) assert.equal(s.read('team', h).emailSha256, sha(email));
});

test('gitIdentity reads user.name and user.email of the target repository, not of the process cwd (REV-58)', (t) => {
  const { base } = scratch(t);
  const repo = join(base, 'target');
  const env = { ...ISO.env, PATH: process.env.PATH, HOME: join(base, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args) => assert.equal(spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }).status, 0);
  mkdirSync(repo);
  git(['init', '-q']);
  assert.deepEqual(state.gitIdentity(repo, { env }), { name: null, email: null });
  git(['config', 'user.name', 'Target Person']);
  git(['config', 'user.email', 'target@example.com']);
  assert.deepEqual(state.gitIdentity(repo, { env }), { name: 'Target Person', email: 'target@example.com' });
  assert.throws(() => state.gitIdentity(repo), /env/);
});

// ---- Review round 1, items 2 and 11 ----
const waitFile = async (p) => { for (const end = performance.now() + 60000; performance.now() < end && !existsSync(p);) await new Promise((r) => setTimeout(r, 5)); assert.ok(existsSync(p), p); };
const exitOf = (c) => new Promise((r) => { let out = ''; c.stdout.on('data', (d) => { out += d; }); c.once('exit', () => r(out)); });

// Item 2: allocator A is paused inside build('T-AB-1'); B allocates, retires that ID and removes its task; A
// resumes. The two must not both get T-AB-1, and a tombstoned number is never returned.
// build() runs once, under the store lock.
for (const pauseAt of [1]) test(`an allocation paused in build (call ${pauseAt}) cannot be overtaken into reusing a tombstoned ID (review item 2)`, { timeout: 60000 }, async (t) => {
  const { base, dir } = scratch(t);
  store(dir);
  const f = (n) => join(base, n);
  const child = (body) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
const state = await import(${JSON.stringify(STATE)});
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)}, lockTimeoutMs: 30000 });
const sleep = new Int32Array(new SharedArrayBuffer(4));
const task = (id, title) => ({ id, kind: 'task', title, lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null });
${body}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const a = child(`let calls = 0;
process.stdout.write(state.allocateId(s, { prefix: 'T', handle: 'AB', build: (id) => {
  if (++calls === ${pauseAt}) { fs.writeFileSync(${JSON.stringify(f('paused'))}, id); while (!fs.existsSync(${JSON.stringify(f('go'))})) Atomics.wait(sleep, 0, 0, 2); }
  return task(id, 'A');
} }));`);
  const aOut = exitOf(a);
  t.after(() => a.kill('SIGKILL'));
  await waitFile(f('paused'));
  const b = child(`const id = state.allocateId(s, { prefix: 'T', handle: 'AB', build: (i) => task(i, 'B') });
state.retireId(s, id, { by: 'AB', reason: 'retired by B', at: '${AT}' });
fs.rmSync(${JSON.stringify(join(dir, 'tasks'))} + '/' + id, { recursive: true });
process.stdout.write(id);`);
  const bOut = exitOf(b);
  t.after(() => b.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(f('go'), '');
  const [ida, idb] = await Promise.all([aOut, bOut]);
  assert.notEqual(ida, idb, `both got ${ida}`);
  assert.equal(existsSync(join(dir, 'tombstones', `${ida}.json`)), false, `${ida} is tombstoned but was returned`);
  assert.equal(state.open(dir, { names }).read('task', ida).title, 'A');
});

// Decision for item 2: a per-handle high-water mark (local/ids/<P>-<H>.json) keeps a number whose object was
// deleted without a tombstone from being returned again on this machine.
test('the high-water mark keeps numbers increasing even when the top object is deleted without a tombstone', (t) => {
  const { dir } = scratch(t);
  const s = store(dir);
  assert.deepEqual([allocT(s), allocT(s), allocT(s)], ['T-AB-1', 'T-AB-2', 'T-AB-3']);
  rmSync(join(dir, 'tasks', 'T-AB-3'), { recursive: true });
  assert.equal(allocT(s), 'T-AB-4');
  assert.deepEqual(s.read('counter', 'T-AB'), { schema: KINDS.counter.version, high: 4 });
  state.allocateId(s, { prefix: 'D', handle: 'AB', build: () => '# D\n' });
  assert.deepEqual(s.read('counter', 'D-AB'), { schema: KINDS.counter.version, high: 1 });
});

// Item 11: two registrations of one email with different names, both past the "is this email registered?"
// check before either creates its handle: one handle, not two.
// Scans 1 and 2 are the read-only checks; scan 3 runs under the email lock.
for (const pauseAt of [1, 2, 3]) test(`concurrent registrations of one email with different names give one handle, paused at team scan ${pauseAt} (review item 11)`, { timeout: 60000 }, async (t) => {
  const { base, dir } = scratch(t);
  store(dir, []);
  const f = (n) => join(base, n);
  const reg = (name, tag) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const state = await import(${JSON.stringify(STATE)});
const real = fs.readdirSync;
const sleep = new Int32Array(new SharedArrayBuffer(4));
let scans = 0;
fs.readdirSync = (p, ...a) => {
  const out = real(p, ...a);
  if (String(p) === ${JSON.stringify(join(dir, 'team'))} && ++scans === ${pauseAt}) { fs.writeFileSync(${JSON.stringify(f('scanned-'))} + ${JSON.stringify(tag)}, ''); while (!fs.existsSync(${JSON.stringify(f('go'))})) Atomics.wait(sleep, 0, 0, 2); }
  return out;
};
syncBuiltinESMExports();
const s = state.open(${JSON.stringify(dir)}, { names: ${JSON.stringify(names)}, lockTimeoutMs: 30000 });
process.stdout.write(state.registerHandle(s, { name: ${JSON.stringify(name)}, email: 'same@example.com', at: '${AT}' }).handle);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  mkdirSync(join(dir, 'team'), { recursive: true });
  const a = reg('Alice Brown', 'a');
  const aOut = exitOf(a);
  t.after(() => a.kill('SIGKILL'));
  await waitFile(f('scanned-a'));
  const b = reg('Zed Zebra', 'b');
  const bOut = exitOf(b);
  t.after(() => b.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(f('go'), '');
  const [ha, hb] = await Promise.all([aOut, bOut]);
  assert.equal(ha, hb, 'one email, one handle');
  const s = state.open(dir, { names });
  assert.equal(s.list('team').filter((h) => s.read('team', h).emailSha256 === sha('same@example.com')).length, 1);
});
