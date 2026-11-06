// Forward migrations (spec §5.4, SD-10, GC9, SC10, REV-57): every file of a known kind whose schema is older
// than its kind is upgraded through the chain 1 → version; files of other kinds or at the current schema are
// never touched; the original bytes go to local/backup/<stamp>/ first; a dry run writes nothing; a second run
// writes nothing; a run killed at any write and re-run gives the same store as an uninterrupted run; a newer
// file or store refuses before any byte. The registry (lib/state/migrations/index.mjs) matches its directory
// and every kind's chain. Property tests use generated kinds and chains (seeded; the seed is in the message).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
const ISO = isolateProcessEnv();

const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = fs;
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
const { KINDS, LAYOUTS, MACHINE_KINDS, MIGRATIONS } = state;
const AT = '2026-10-15T05:42:00.000Z';
const is = (code, exit) => (e) => e instanceof state.StateError && e.code === code && e.exit === exit;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-migrate-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function snapshot(dir, { skip = () => false } = {}) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}
const put = (dir, rel, value) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const stateDoc = (extra = {}) => ({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT, ...extra });
const task = (id) => ({ schema: KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null });
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A generated chain for kind `item`: version 1 has { id, n, label }; each step adds a field, renames one, or
// rewrites a number. Returns the kind (schema `version`), the steps and the field set per version.
function chain(rand, version) {
  let fields = { id: 'str', n: 'int', label: 'str' };
  const steps = [];
  for (let from = 1; from < version; from++) {
    const roll = rand();
    const names0 = Object.keys(fields).filter((f) => f !== 'id');
    let up;
    if (roll < 0.4 || names0.length === 0) {
      const f = `f${from}`;
      fields = { ...fields, [f]: 'str' };
      up = (d) => ({ ...d, [f]: `${d.id}:${from}` });
    } else if (roll < 0.7) {
      const old = names0[Math.floor(rand() * names0.length)];
      const neu = `r${from}`;
      const { [old]: type, ...rest } = fields;
      fields = { ...rest, [neu]: type };
      up = (d) => { const { [old]: v, ...others } = d; return { ...others, [neu]: v }; };
    } else {
      const ints = names0.filter((f) => fields[f] === 'int');
      const f = ints.length ? ints[0] : null;
      up = f ? (d) => ({ ...d, [f]: (d[f] * 2 + from) % 1000000 }) : (d) => ({ ...d });
    }
    steps.push({ id: `${String(from).padStart(3, '0')}-item-step${from}`, kind: 'item', from, to: from + 1, up, fields });
  }
  const spec = (f) => Object.fromEntries(Object.entries(f).map(([k, t]) => [k, t === 'int' ? { t: 'int', min: 0, max: 1000000 } : { t: 'str', max: 200 }]));
  const item = state.defineKind('item', version, { dir: 'items', keyPattern: /^i\d{1,4}$/, file: (k) => `items/${k}.json`, match: /^items\/(i\d{1,4})\.json$/, key: 'id', fields: spec(fields) });
  return { item, steps };
}
// Independent oracle: the steps applied in order, outside the engine.
function expected(steps, doc) {
  let d = structuredClone(doc);
  while (d.schema < steps.length + 1) { const s = steps[d.schema - 1]; d = { ...s.up(structuredClone(d)), schema: s.to }; }
  return d;
}
// An item document at schema v: a version-1 document taken through the first v - 1 steps.
const itemAt = (steps, id, n, v) => {
  let d = { schema: 1, id, n, label: `label ${id}` };
  while (d.schema < v) { const s = steps[d.schema - 1]; d = { ...s.up(structuredClone(d)), schema: s.to }; }
  return d;
};
// Files no migration may touch: other kinds, non-state files, local data.
function untouchable(dir) {
  put(dir, 'state.json', stateDoc());
  put(dir, 'team/AB.json', { schema: KINDS.team.version, handle: 'AB', emailSha256: 'b'.repeat(64), addedAt: AT });
  put(dir, 'tasks/T-AB-1/task.json', task('T-AB-1'));
  put(dir, 'tasks/T-AB-1/brief.md', '# brief\nuser text\n');
  put(dir, 'guard-extra.txt', 'rm\tno\n');
  put(dir, 'local/loop.json', '{"schema":1,"ticks":3}\n');
}

test('property: a generated chain migrates mixed-version stores exactly, losslessly and once (seeded)', (t) => {
  const base = scratch(t);
  const seed = 0xC0FFEE;
  const rand = rng(seed);
  let migrated = 0;
  for (let iter = 0; iter < 150; iter++) {
    const version = 1 + Math.floor(rand() * 6);
    const { item, steps } = chain(rand, version);
    const kinds = { ...KINDS, item };
    const dir = join(base, `s${iter}`);
    untouchable(dir);
    const docs = {};
    for (let k = 0, count = Math.floor(rand() * 10); k < count; k++) {
      const id = `i${k}`;
      docs[id] = itemAt(steps, id, Math.floor(rand() * 1000), 1 + Math.floor(rand() * version));
      put(dir, `items/${id}.json`, docs[id]);
    }
    const label = `seed ${seed} iteration ${iter} (version ${version})`;
    const before = snapshot(dir);
    const s = state.open(dir, { names, kinds, migrations: steps });
    const older = Object.keys(docs).filter((id) => docs[id].schema < version).map((id) => `items/${id}.json`).sort();

    const dry = state.migrate(s, { dryRun: true });
    assert.deepEqual(dry.steps.map((x) => x.rel), older, `${label}: dry-run plan`);
    assert.equal(dry.backup, null);
    assert.deepEqual(snapshot(dir), before, `${label}: dry run writes nothing`);

    const run = state.migrate(s, { at: new Date(AT) });
    assert.deepEqual(run.steps.map((x) => x.rel), older, label);
    for (const st of run.steps) assert.deepEqual(st.ids, steps.slice(st.from - 1).map((x) => x.id), `${label}: ${st.rel} ids`);
    for (const [id, doc] of Object.entries(docs)) {
      const rel = `items/${id}.json`;
      const now = readFileSync(join(dir, rel), 'utf8');
      if (doc.schema === version) assert.equal(now, `${JSON.stringify(doc, null, 2)}\n`, `${label}: ${rel} at the current schema is untouched`);
      else {
        assert.equal(now, state.serialize(item, expected(steps, doc)), `${label}: ${rel} migrated`);
        assert.equal(readFileSync(join(dir, run.backup, rel), 'utf8'), `${JSON.stringify(doc, null, 2)}\n`, `${label}: ${rel} original in the backup`);
        migrated++;
      }
      assert.deepEqual(s.read('item', id), expected(steps, doc), `${label}: read ${id}`);
    }
    const outside = (r) => r.startsWith('items') || r.startsWith('local/backup') || r.startsWith('local/locks') || r === 'local/.machine'; // T-MG-77 (intended): the owner marker
    assert.deepEqual(snapshot(dir, { skip: outside }), before.filter((l) => !outside(l.slice(2).split(' ')[0])), `${label}: nothing else touched`);
    if (older.length) assert.deepEqual(snapshot(join(dir, run.backup)).filter((l) => l.startsWith('F')).length, older.length, `${label}: backup holds exactly the migrated files`);
    else assert.equal(run.backup, null, `${label}: no backup when nothing migrates`);

    const after = snapshot(dir);
    const again = state.migrate(s);
    assert.deepEqual([again.steps, again.backup], [[], null], `${label}: second run`);
    assert.deepEqual(snapshot(dir), after, `${label}: second run writes nothing`);
  }
  assert.ok(migrated > 100, `the property exercised migrations (${migrated})`);
});

test('refusals before any byte: newer store, one newer file among older ones, corrupt file, invalid result (SC10)', (t) => {
  const base = scratch(t);
  const { item, steps } = chain(rng(7), 3);
  const kinds = { ...KINDS, item };
  const cases = [
    ['newer store', (d) => put(d, 'state.json', stateDoc({ schema: KINDS.state.version + 1 })), is('schema-newer', 'REFUSED'), steps],
    ['newer file', (d) => put(d, 'items/i9.json', { schema: 4, id: 'i9' }), is('schema-newer', 'REFUSED'), steps],
    ['corrupt file', (d) => put(d, 'items/i9.json', '{"schema":'), is('state-invalid', 'FAIL'), steps],
    ['unknown field kept by the user', (d) => put(d, 'items/i9.json', { ...itemAt(steps, 'i9', 1, 1), mine: 'x' }), is('state-invalid', 'FAIL'), steps],
    ['a step that breaks the schema', () => {}, is('state-invalid', 'FAIL'), [steps[0], { ...steps[1], up: (d) => ({ ...d, n: -1 }) }]],
  ];
  for (const [label, plant, refusal, chainSteps] of cases) {
    const dir = join(base, label.replace(/\W+/g, '-'));
    untouchable(dir);
    for (let k = 0; k < 4; k++) put(dir, `items/i${k}.json`, itemAt(steps, `i${k}`, k, 1));
    plant(dir);
    const before = snapshot(dir);
    const s = state.open(dir, { names, kinds, migrations: chainSteps });
    for (const opts of [{ dryRun: true }, {}]) {
      assert.throws(() => state.migrate(s, opts), (e) => refusal(e) && EXIT[e.exit] !== undefined, `${label} ${JSON.stringify(opts)}`);
      assert.deepEqual(snapshot(dir), before, `${label}: 0 bytes written`);
    }
  }
});

// The engine killed at each of its renames (backup and target writes), then run again after the explicit
// recovery (state unlock --stale): the store ends exactly as after an uninterrupted run.
test('crash at any write, then a re-run: the same store as an uninterrupted migration', { timeout: 180000 }, (t) => {
  const base = scratch(t);
  const fixture = join(base, 'fixture.mjs');
  writeFileSync(fixture, `const state = await import(${JSON.stringify(STATE)});
export const item = state.defineKind('item', 3, { dir: 'items', keyPattern: /^i\\d{1,4}$/, file: (k) => 'items/' + k + '.json', match: /^items\\/(i\\d{1,4})\\.json$/, key: 'id',
  fields: { id: { t: 'str', max: 20 }, n: { t: 'int', min: 0, max: 100000 }, label: { t: 'str', max: 99 }, extra: { t: 'str', max: 99 } } });
export const migrations = [
  { id: '001-item-extra', kind: 'item', from: 1, to: 2, up: (d) => ({ ...d, extra: d.id + '!' }) },
  { id: '002-item-double', kind: 'item', from: 2, to: 3, up: (d) => ({ ...d, n: d.n * 2 }) },
];
export const open = (dir) => state.open(dir, { names: ${JSON.stringify(names)}, kinds: { ...state.KINDS, item }, migrations });
`);
  const seedStore = (dir) => {
    untouchable(dir);
    for (let k = 0; k < 4; k++) put(dir, `items/i${k}.json`, { schema: 1 + (k % 2), id: `i${k}`, n: k, label: `l${k}`, ...(k % 2 ? { extra: `i${k}!` } : {}) });
    put(dir, 'items/i9.json', { schema: 3, id: 'i9', n: 9, label: 'current', extra: 'x' });
  };
  const final = (dir) => snapshot(dir, { skip: (r) => r.startsWith('local/backup') || r.startsWith('local/lock') });
  const ref = join(base, 'ref');
  seedStore(ref);
  const childEnv = { ...ISO.env, PATH: process.env.PATH, HOME: base, LANG: 'C' };
  const runChild = (dir, killAt) => spawnSync(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.renameSync;
let n = 0;
fs.renameSync = (...a) => { if (++n === ${killAt}) process.kill(process.pid, 'SIGKILL'); return real(...a); };
syncBuiltinESMExports();
const { open } = await import(${JSON.stringify(pathToFileURL(fixture).href)});
const state = await import(${JSON.stringify(STATE)});
// After a crash the lock may be left behind: removing it is the explicit recovery (findings-r3).
if (${killAt} === 0) state.unlockStale(open(${JSON.stringify(dir)}));
state.migrate(open(${JSON.stringify(dir)}));`], { encoding: 'utf8', env: childEnv, timeout: 60000 });
  const clean = runChild(ref, 0);
  assert.equal(clean.status, 0, clean.stderr);
  const want = final(ref);
  let killed = 0;
  for (let k = 1; k <= 8; k++) {
    const dir = join(base, `k${k}`);
    seedStore(dir);
    const r = runChild(dir, k);
    if (r.signal === 'SIGKILL') killed++;
    else assert.equal(r.status, 0, r.stderr);
    const again = runChild(dir, 0);
    assert.equal(again.status, 0, `re-run after a kill at rename ${k}: ${again.stderr}`);
    assert.deepEqual(final(dir), want, `kill at rename ${k}`);
    // Lossless: the original bytes of every migrated file are in a backup, whatever the kill point.
    const backups = readdirSync(join(dir, 'local', 'backup')).flatMap((b) => { const d = join(dir, 'local', 'backup', b, 'items'); return existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith('.')).map((f) => readFileSync(join(d, f), 'utf8')) : []; });
    for (const f of readdirSync(join(ref, 'local', 'backup')).flatMap((b) => readdirSync(join(ref, 'local', 'backup', b, 'items')).map((x) => readFileSync(join(ref, 'local', 'backup', b, 'items', x), 'utf8')))) {
      assert.ok(backups.includes(f), `kill at rename ${k}: an original is missing from the backups`);
    }
    assert.deepEqual(readdirSync(join(dir, 'local')).filter((n) => /^lock($|\.(new|released)-)/.test(n)), [], `kill at rename ${k}: no lock left after the re-run`);
  }
  assert.ok(killed >= 4, `the kills landed inside the migration (${killed})`);
});

test('the migration registry matches its directory; every kind has a complete chain', async () => {
  const dir = join(pluginDir, 'lib', 'state', 'migrations');
  const files = readdirSync(dir).filter((f) => f !== 'index.mjs').sort();
  for (const f of files) assert.match(f, /^\d{3}-[a-z][a-z0-9]*-[a-z0-9-]+\.mjs$/, f);
  // Document steps (MIGRATIONS, in order) and layout steps (LAYOUTS: directory moves) together name every module.
  const listed = [...MIGRATIONS, ...LAYOUTS].map((m) => `${m.id}.mjs`);
  assert.deepEqual([...listed].sort(), files, 'index.mjs lists every step module');
  assert.deepEqual(MIGRATIONS.map((m) => `${m.id}.mjs`), files.filter((f) => !LAYOUTS.some((l) => `${l.id}.mjs` === f)), 'document steps in order');
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    assert.equal([...MIGRATIONS, ...LAYOUTS].find((m) => `${m.id}.mjs` === f), mod.default, `${f}: the listed step is the module's default export`);
  }
  for (const l of LAYOUTS) assert.deepEqual([typeof l.plan, typeof l.run], ['function', 'function'], `${l.id}: a layout step plans and runs`);
  // Every kind `migrate` handles (the state kinds, the machine kinds and the other units' committed kinds) has a chain.
  const { MIGRATE_KINDS } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'migrate.mjs')).href);
  assert.deepEqual(state.checkChain({ ...MIGRATE_KINDS, ...MACHINE_KINDS }, MIGRATIONS), []);
  assert.ok(MIGRATIONS.some((m) => m.kind === 'profile' && m.to === 2), 'the profile step (retro 2026-10: said risk globs and review focus) is registered');
});

test('checkChain finds every planted chain defect (REV-45)', () => {
  const { item, steps } = chain(rng(3), 4);
  // The generated kind alone: the plugin's own kinds have their own chain (checked against MIGRATIONS above).
  const kinds = { item };
  const plain = steps.map(({ fields, ...s }) => s);
  assert.deepEqual(state.checkChain(kinds, plain), []);
  const defects = [
    ['gap', plain.filter((s) => s.from !== 2)],
    ['duplicate step', [...plain, { ...plain[1], id: '009-item-again' }]],
    ['skips a version', plain.map((s) => (s.from === 3 ? { ...s, to: 5 } : s))],
    ['unknown kind', [...plain, { id: '004-ghost-x', kind: 'ghost', from: 1, to: 2, up: (d) => d }]],
    ['id kind differs from kind', plain.map((s) => (s.from === 1 ? { ...s, id: '001-task-x' } : s))],
    ['ids out of order', [plain[1], plain[0], plain[2]]],
    ['bad id', plain.map((s) => (s.from === 1 ? { ...s, id: 'one' } : s))],
    ['beyond the kind version', [...plain, { id: '004-item-late', kind: 'item', from: 4, to: 5, up: (d) => d }]],
    ['no up function', plain.map((s) => (s.from === 1 ? { ...s, up: null } : s))],
    ['carry to an unknown kind', plain.map((s) => (s.from === 1 ? { ...s, carry: { kind: 'ghost', into: () => undefined } } : s))],
    ['carry from or to a keyed kind', plain.map((s) => (s.from === 1 ? { ...s, carry: { kind: 'item', into: () => undefined } } : s))],
    ['carry without into', plain.map((s) => (s.from === 1 ? { ...s, carry: { kind: 'item' } } : s))],
  ];
  for (const [label, migrations] of defects) assert.ok(state.checkChain(kinds, migrations).length >= 1, label);
});

test('migrate on an absent or empty store writes nothing', (t) => {
  const base = scratch(t);
  const dir = join(base, 'repo', names.stateDir);
  assert.deepEqual(state.migrate(state.open(dir, { names })), { steps: [], backup: null });
  assert.equal(existsSync(join(base, 'repo')), false);
});

// ---- Review round 1, item 8: writers and migrations are serialized by the store lock ----
// After the migration replaced its first file, a newer plugin's writer tries to write the second one. It must
// wait for the migration (store lock) instead of writing in between; the migration finishes consistently.
test('a writer cannot interleave with a running migration (review item 8)', { timeout: 120000 }, (t) => {
  const base = scratch(t);
  const dir = join(base, 'repo', names.stateDir);
  untouchable(dir);
  for (const id of ['i0', 'i1']) put(dir, `items/${id}.json`, { schema: 1, id, n: 1 });
  const fixture = join(base, 'kinds.mjs');
  writeFileSync(fixture, `const state = await import(${JSON.stringify(STATE)});
const item = (v) => state.defineKind('item', v, { dir: 'items', keyPattern: /^i\\d$/, file: (k) => 'items/' + k + '.json', match: /^items\\/(i\\d)\\.json$/, key: 'id',
  fields: { id: { t: 'str', max: 9 }, n: { t: 'int', min: 0, max: 99 }, ...(v >= 2 ? { m: { t: 'int', min: 0, max: 99 } } : {}), ...(v >= 3 ? { z: { t: 'int', min: 0, max: 99 } } : {}) } });
const steps = [
  { id: '001-item-m', kind: 'item', from: 1, to: 2, up: (d) => ({ ...d, m: 0 }) },
  { id: '002-item-z', kind: 'item', from: 2, to: 3, up: (d) => ({ ...d, z: 0 }) },
];
export const open = (dir, v, opts = {}) => state.open(dir, { names: ${JSON.stringify(names)}, kinds: { ...state.KINDS, item: item(v) }, migrations: steps.slice(0, v - 1), ...opts });
`);
  const writer = `const { open } = await import(${JSON.stringify(pathToFileURL(fixture).href)});
try { open(${JSON.stringify(dir)}, 3, { lockTimeoutMs: 500 }).write('item', 'i1', { id: 'i1', n: 7, m: 7, z: 7 }); process.stdout.write('written'); }
catch (e) { process.stdout.write(e.code); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const { open } = await import(${JSON.stringify(pathToFileURL(fixture).href)});
const state = await import(${JSON.stringify(STATE)});
const real = fs.renameSync;
let n = 0;
let writerSaid = null;
fs.renameSync = (...a) => {
  const out = real(...a);
  if (String(a[1]).endsWith('items/i0.json') && writerSaid === null) writerSaid = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(writer)}], { encoding: 'utf8' }).stdout;
  return out;
};
syncBuiltinESMExports();
let migrated;
try { migrated = state.migrate(open(${JSON.stringify(dir)}, 2)).steps.map((s) => s.rel); } catch (e) { migrated = e.code; }
fs.renameSync = real;
process.stdout.write(JSON.stringify({ writerSaid, migrated }));`], { encoding: 'utf8', timeout: 60000, env: { ...ISO.env, PATH: process.env.PATH, HOME: base } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.writerSaid, 'locked', 'the newer writer waited for the migration and gave up');
  assert.deepEqual(out.migrated, ['items/i0.json', 'items/i1.json'], 'the migration completed');
  for (const id of ['i0', 'i1']) assert.deepEqual(JSON.parse(readFileSync(join(dir, 'items', `${id}.json`), 'utf8')), { schema: 2, id, n: 1, m: 0 });
});

// T-MG-116 (plan M1.1, RF2): task 2 → 3 (006, outcome and regressionOf) and finding 1 → 2 (007, regressionOf) are
// no-op steps: a migrated file differs from its original only in the schema line, and a v1 task goes through 004 and 006.
test('006-task-outcome and 007-finding-regression: migrate changes only the schema of a v2 task and a v1 finding', (t) => {
  const steps = MIGRATIONS.filter((m) => m.id === '006-task-outcome' || m.id === '007-finding-regression');
  assert.deepEqual(steps.map(({ id, kind, from, to }) => ({ id, kind, from, to })), [
    { id: '006-task-outcome', kind: 'task', from: 2, to: 3 },
    { id: '007-finding-regression', kind: 'finding', from: 1, to: 2 },
  ]);
  assert.deepEqual([KINDS.task.version, KINDS.finding.version], [3, 2]);
  const dir = scratch(t);
  untouchable(dir);
  const files = {
    'tasks/T-AB-2/task.json': { ...task('T-AB-2'), schema: 2, status: 'cancelled', events: [{ at: AT, by: 'AB', event: 'cancelled', data: { reason: 'delivered in T-AB-1' } }], mergedAt: AT },
    'tasks/T-AB-3/task.json': { ...task('T-AB-3'), schema: 1, title: 'Old é task' },
    'findings/B-AB-1.json': {
      schema: 1, id: 'B-AB-1', status: 'open', task: 'T-AB-1', round: 1, reviewer: { kind: 'external', id: 'codex' }, finding: 'B1',
      severity: 'blocking', path: 'src/x.mjs', line: 3, rule: 'REV-3', text: 'A lost event.', filedAt: AT, filedBy: 'AB',
      takenBy: null, closedAt: null, closedBy: null, reason: null,
    },
  };
  for (const [rel, doc] of Object.entries(files)) put(dir, rel, doc);
  const before = Object.fromEntries(Object.keys(files).map((rel) => [rel, readFileSync(join(dir, rel), 'utf8')]));
  const untouched = snapshot(dir, { skip: (r) => r in files });
  const s = state.open(dir, { names });
  const out = state.migrate(s, { at: new Date(AT) });
  assert.deepEqual(out.steps.map(({ rel, from, to, ids }) => ({ rel, from, to, ids })).sort((a, b) => a.rel.localeCompare(b.rel)), [
    { rel: 'findings/B-AB-1.json', from: 1, to: 2, ids: ['007-finding-regression'] },
    { rel: 'tasks/T-AB-2/task.json', from: 2, to: 3, ids: ['006-task-outcome'] },
    { rel: 'tasks/T-AB-3/task.json', from: 1, to: 3, ids: ['004-task-merged-at', '006-task-outcome'] },
  ]);
  const to = { 'tasks/T-AB-2/task.json': 3, 'tasks/T-AB-3/task.json': 3, 'findings/B-AB-1.json': 2 };
  for (const rel of Object.keys(files)) {
    const want = before[rel].replace(/^ {2}"schema": \d+,$/m, `  "schema": ${to[rel]},`);
    assert.notEqual(want, before[rel], `${rel}: the schema line was found`);
    assert.equal(readFileSync(join(dir, rel), 'utf8'), want, `${rel}: only the schema changed, byte for byte`);
    assert.equal(readFileSync(join(dir, out.backup, rel), 'utf8'), before[rel], `${rel}: the original is backed up`);
  }
  assert.deepEqual(snapshot(dir, { skip: (r) => r in files || r.startsWith('local/backup') || r === 'local/.machine' }), untouched, 'nothing else changed');
  assert.deepEqual(state.migrate(state.open(dir, { names })).steps, [], 'a second run writes nothing');
});

// T-MG-117 (plan M1.2, RF2): verify 1 → 2 (008, machine, cache, heavyWaitMs, gatesMs) and review 1 → 2 (009, focus) are
// no-op steps: a migrated file differs from its original only in the schema line.
test('008-verify-machine and 009-review-focus: migrate changes only the schema of a v1 verify and a v1 review', async (t) => {
  const { VERIFY_KINDS } = await import(pathToFileURL(join(pluginDir, 'lib', 'verify', 'kinds.mjs')).href);
  const steps = MIGRATIONS.filter((m) => m.id === '008-verify-machine' || m.id === '009-review-focus');
  assert.deepEqual(steps.map(({ id, kind, from, to }) => ({ id, kind, from, to })), [
    { id: '008-verify-machine', kind: 'verify', from: 1, to: 2 },
    { id: '009-review-focus', kind: 'review', from: 1, to: 2 },
  ]);
  const at = (id) => MIGRATIONS.findIndex((m) => m.id === id);
  assert.ok(at('007-finding-regression') < at('008-verify-machine') && at('008-verify-machine') < at('009-review-focus') && at('009-review-focus') < at('010-profile-fast-guards') && at('011-verify-mode') < at('012-verify-train'), 'listed in NNN order after 007, before 010');
  assert.equal(MIGRATIONS.at(-1).id, '013-state-role-tokens');
  assert.deepEqual([VERIFY_KINDS.verify.version, VERIFY_KINDS.review.version], [4, 2]);
  const dir = scratch(t);
  untouchable(dir);
  const files = {
    'tasks/T-AB-1/verify.json': {
      schema: 1, task: 'T-AB-1', head: 'a'.repeat(40), gatesSha: 'b'.repeat(64), baselineSha: null, class: 'standard', startedAt: AT, durationMs: 7,
      gates: [{ name: 'test', cmd: 'npm test', exit: 0, durationMs: 5, result: 'pass' }],
      inventory: { collector: 'none', total: 0, added: [], removed: [], newlySkipped: [], allowedBy: [], weak: false },
      failures: { preexisting: [], new: [] }, route: { declared: 'standard', actual: 'standard', escalated: false, missingSteps: [] },
      artifacts: { report: true, review: 'approved' }, result: 'pass',
    },
    'tasks/T-AB-1/review-r1.json': {
      schema: 1, verdict: 'needs-fixes', reviewer: { kind: 'claude', id: 'claude:reviewer' },
      findings: [{ id: 'B1', severity: 'blocking', path: 'src/é.mjs', line: 3, rule: 'REV-3', text: 'A lost event.' }],
    },
  };
  for (const [rel, doc] of Object.entries(files)) put(dir, rel, doc);
  const before = Object.fromEntries(Object.keys(files).map((rel) => [rel, readFileSync(join(dir, rel), 'utf8')]));
  const untouched = snapshot(dir, { skip: (r) => r in files });
  const kinds = { ...KINDS, ...VERIFY_KINDS };
  const out = state.migrate(state.open(dir, { names, kinds }), { at: new Date(AT) });
  assert.deepEqual(out.steps.map(({ rel, from, to, ids }) => ({ rel, from, to, ids })).sort((a, b) => a.rel.localeCompare(b.rel)), [
    { rel: 'tasks/T-AB-1/review-r1.json', from: 1, to: 2, ids: ['009-review-focus'] },
    { rel: 'tasks/T-AB-1/verify.json', from: 1, to: 4, ids: ['008-verify-machine', '011-verify-mode', '012-verify-train'] },
  ]);
  for (const rel of Object.keys(files)) {
    const want = before[rel].replace(/^ {2}"schema": 1,$/m, `  "schema": ${rel.endsWith('verify.json') ? 4 : 2},`);
    assert.notEqual(want, before[rel], `${rel}: the schema line was found`);
    assert.equal(readFileSync(join(dir, rel), 'utf8'), want, `${rel}: only the schema changed, byte for byte`);
    assert.equal(readFileSync(join(dir, out.backup, rel), 'utf8'), before[rel], `${rel}: the original is backed up`);
  }
  assert.deepEqual(snapshot(dir, { skip: (r) => r in files || r.startsWith('local/backup') || r === 'local/.machine' }), untouched, 'nothing else changed');
  assert.deepEqual(state.migrate(state.open(dir, { names, kinds })).steps, [], 'a second run writes nothing');
});

// T-MG-152: profile 2 -> 3 (010, the fact fastGuards) is a no-op step: only the schema line changes (GC9).
test('010-profile-fast-guards: migrate changes only the schema of a v2 profile', async (t) => {
  const { PROFILE_KINDS } = await import(pathToFileURL(join(pluginDir, 'lib', 'profile', 'index.mjs')).href);
  const step = MIGRATIONS.find((m) => m.id === '010-profile-fast-guards');
  assert.deepEqual(step && { kind: step.kind, from: step.from, to: step.to }, { kind: 'profile', from: 2, to: 3 });
  assert.equal(PROFILE_KINDS.profile.version, 3);
  const dir = scratch(t);
  put(dir, 'profile.json', { schema: 2, facts: {}, gates: [], riskPaths: [], lastScan: null });
  const before = readFileSync(join(dir, 'profile.json'), 'utf8');
  const s = state.open(dir, { names, kinds: { ...KINDS, ...PROFILE_KINDS } });
  const out = state.migrate(s, { at: new Date(AT) });
  assert.deepEqual(out.steps.filter((x) => x.rel === 'profile.json').map(({ from, to, ids }) => ({ from, to, ids })), [{ from: 2, to: 3, ids: ['010-profile-fast-guards'] }]);
  assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), before.replace(/^ {2}"schema": 2,$/m, '  "schema": 3,'));
});

// T-MG-194 (D-MG-75, A12): store schema 2 -> 3 (013, the machine-local role token kind) is a no-op step: only the schema
// line of state.json changes; a reader at the previous schema (the 2.7.2 plugin) then refuses every write (SC10).
test('013-state-role-tokens: migrate changes only the schema of state.json; a reader at schema 2 refuses to write', (t) => {
  const step = MIGRATIONS.find((m) => m.id === '013-state-role-tokens');
  assert.deepEqual(step && { kind: step.kind, from: step.from, to: step.to }, { kind: 'state', from: 2, to: 3 });
  assert.equal(KINDS.state.version, 3);
  const dir = scratch(t);
  put(dir, 'state.json', stateDoc({ schema: 2 }));
  const before = readFileSync(join(dir, 'state.json'), 'utf8');
  const out = state.migrate(state.open(dir, { names }), { at: new Date(AT) });
  assert.deepEqual(out.steps.map(({ rel, from, to, ids }) => ({ rel, from, to, ids })), [{ rel: 'state.json', from: 2, to: 3, ids: ['013-state-role-tokens'] }]);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before.replace(/^ {2}"schema": 2,$/m, '  "schema": 3,'), 'only the schema line changed');
  assert.deepEqual(state.migrate(state.open(dir, { names })).steps, [], 'a second run writes nothing');
  const { schema: _, ...fields } = KINDS.state.spec.f;
  const previous = state.defineKind('state', 2, { dir: '', file: () => 'state.json', match: /^state\.json$/, fields });
  const old = state.open(dir, { names, kinds: { ...KINDS, state: previous } });
  const kept = snapshot(dir);
  assert.throws(() => old.update('config', null, () => ({ flags: {} })), is('schema-newer', 'REFUSED'));
  assert.throws(() => old.write('state', null, stateDoc({ schema: 2 })), is('schema-newer', 'REFUSED'));
  assert.deepEqual(snapshot(dir), kept, 'the refused writes changed nothing');
});

test('B-MG-31: the files of lib/state (migrations included) have no import cycle', () => {
  const base = join(pluginDir, 'lib', 'state');
  const edges = new Map();
  const scan = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { scan(p); continue; }
      if (!f.name.endsWith('.mjs')) continue;
      const src = readFileSync(p, 'utf8');
      const targets = [...src.matchAll(/\bfrom\s+'(\.[^']*\.mjs)'/g)].map((m) => join(dir, m[1]));
      edges.set(p, targets.filter((t) => t.startsWith(base)));
    }
  };
  scan(base);
  const visiting = [];
  const done = new Set();
  const walk = (f) => {
    if (done.has(f)) return;
    const at = visiting.indexOf(f);
    assert.equal(at, -1, `import cycle: ${[...visiting.slice(at), f].map((x) => x.slice(base.length + 1)).join(' -> ')}`);
    visiting.push(f);
    for (const g of edges.get(f) ?? []) walk(g);
    visiting.pop();
    done.add(f);
  };
  for (const f of edges.keys()) walk(f);
});
