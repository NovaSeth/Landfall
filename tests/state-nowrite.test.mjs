// "Writes nothing", proven at the system-call level (spec SC10, §5, GC2; review rounds 1-2): each scenario
// runs in a child whose node:fs mutating calls (open for writing, write, mkdir, rename, link, rm, …) are
// recorded with their paths (writes through a descriptor are attributed to its file). Refusals that need no
// file (fields, keys) and read-only use make no call at all. A refusal decided under the store lock
// (findings-r2 point 3) touches only the lock: the lock directory, its prepared and released copies, and
// local/ (or the machine data directory) when the lock created it; the tree is identical afterwards. A positive
// control proves the recorder sees the writes of a successful call. Throwaway directory and HOME everywhere.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const { KINDS, MACHINE_KINDS } = state;
const AT = '2026-10-15T05:42:00.000Z';

// Runs `body` (an async function body with `state`, `names`, `dir`, `repo`, `env` in scope) in a child that
// records every mutating node:fs call made while the body runs.
const RECORDED = ['openSync', 'writeFileSync', 'writeSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'linkSync', 'symlinkSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'truncateSync', 'ftruncateSync', 'utimesSync', 'futimesSync', 'chmodSync', 'fchmodSync', 'chownSync'];
function traced(base, body) {
  const code = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const state = await import(${JSON.stringify(STATE)});
const names = ${JSON.stringify(names)};
const dir = ${JSON.stringify(join(base, 'repo', names.stateDir))};
const repo = ${JSON.stringify(join(base, 'repo'))};
const env = { PATH: process.env.PATH, HOME: ${JSON.stringify(join(base, 'home'))}, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: ${JSON.stringify(base)} };
const writes = [];
let on = false;
const WRITE_FLAGS = /[wa+x]/;
const fdPath = new Map();
for (const fn of ${JSON.stringify(RECORDED)}) {
  const real = fs[fn];
  fs[fn] = function (...a) {
    const out = real.apply(this, a);
    if (on) {
      const write = fn !== 'openSync' || (typeof a[1] === 'string' ? WRITE_FLAGS.test(a[1]) : typeof a[1] === 'number' && (a[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0);
      if (fn === 'openSync' && write) fdPath.set(out, String(a[0]));
      const where = typeof a[0] === 'number' ? (fdPath.get(a[0]) ?? 'fd ' + a[0]) : String(a[0]);
      if (write && !(fn === 'writeSync' && (a[0] === 1 || a[0] === 2))) writes.push(fn + ' ' + where + (fn === 'renameSync' || fn === 'linkSync' ? ' -> ' + String(a[1]) : ''));
    }
    return out;
  };
}
syncBuiltinESMExports();
let result = null;
let error = null;
on = true;
try { result = await (async () => { ${body} })(); } catch (e) { error = { code: e.code, exit: e.exit, message: e.message }; }
on = false;
process.stdout.write(JSON.stringify({ result: result === undefined ? null : result, error, writes }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000, env: { ...ISO.env, PATH: process.env.PATH, HOME: join(base, 'home'), LANG: 'C' } });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const stateDoc = (extra = {}) => ({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT, ...extra });
const team = (h, email = `${h}@example.com`) => ({ schema: KINDS.team.version, handle: h, emailSha256: state.emailHash(email), addedAt: AT });
const task = (id, extra = {}) => ({ schema: KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: id.split('-')[1], class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null, ...extra });
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
function fixture(t, files = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-nowrite-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'home'));
  const dir = join(base, 'repo', names.stateDir);
  const all = { 'state.json': stateDoc(), 'team/AB.json': team('AB'), 'tasks/T-AB-1/task.json': task('T-AB-1'), 'tasks/T-AB-2/task.json': task('T-AB-2'), ...files };
  for (const [rel, v] of Object.entries(all)) {
    if (v === null) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof v === 'string' ? v : json(v));
  }
  const g = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', join(base, 'repo')], { env: { ...ISO.env, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(g.status, 0);
  return base;
}
const T = (id) => `{ id: '${id}', kind: 'task', title: 'x', lane: null, owner: '${id.split('-')[1]}', class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null }`;
const open = 'const s = state.open(dir, { names });';

// A snapshot of every directory and file under base (repository and HOME).
function snapshot(base) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${readFileSync(p, 'utf8').length}:${readFileSync(p, 'utf8')}`);
    }
  };
  walk(base, '');
  return out;
}
// The calls a refusal under a lock may make: the lock and its copies, and the parent the lock created.
const lockOnly = (base) => (w) => {
  const paths = w.replace(/^\S+ /, '').split(' -> ');
  const dir = join(base, 'repo', names.stateDir);
  const data = join(base, 'home');
  return paths.every((p) => p === join(dir, 'local') || p.startsWith(join(dir, 'local', 'lock')) || /projects\.lock/.test(p) || (p.startsWith(data) && /^(mkdirSync|rmdirSync) /.test(w)));
};

function refuses(base, label, body, code, exit, { locked = true } = {}) {
  const before = snapshot(base);
  const out = traced(base, body);
  assert.ok(out.error, `${label}: expected a refusal, got ${JSON.stringify(out.result)}`);
  assert.deepEqual([out.error.code, out.error.exit], [code, exit], `${label}: ${out.error.message}`);
  assert.ok(EXIT[exit] !== undefined, `${label}: ${exit} is a CLI exit name`);
  if (locked) assert.deepEqual(out.writes.filter((w) => !lockOnly(base)(w)), [], `${label}: only the lock was touched`);
  else assert.deepEqual(out.writes, [], `${label}: no mutating file system call`);
  assert.deepEqual(snapshot(base), before, `${label}: the tree is as before (no lock, no local/ left)`);
  return out;
}

test('the recorder sees the writes of a successful call (positive control)', (t) => {
  const base = fixture(t);
  const out = traced(base, `${open} s.write('task', 'T-AB-1', ${T('T-AB-1')}); return 'ok';`);
  assert.equal(out.error, null, JSON.stringify(out.error));
  assert.ok(out.writes.some((w) => w.startsWith('renameSync')) && out.writes.some((w) => w.startsWith('openSync')), JSON.stringify(out.writes));
});

const WRITE_APIS = [
  ['write', `${open} s.write('task', 'T-AB-1', ${T('T-AB-1')});`],
  ['write new', `${open} s.write('task', 'T-AB-9', ${T('T-AB-9')});`],
  ['update', `${open} s.update('task', 'T-AB-1', (d) => ({ ...d, round: 1 }));`],
  ['create', `${open} return s.create('task', 'T-AB-8', ${T('T-AB-8')});`],
  ['write state', `${open} s.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: '${AT}' });`],
  ['allocate T', `${open} return state.allocateId(s, { prefix: 'T', handle: 'AB', build: (id) => (${T('T-AB-1').replace("id: 'T-AB-1'", 'id')}) });`],
  ['allocate D', `${open} return state.allocateId(s, { prefix: 'D', handle: 'AB', build: () => '# D' });`],
  ['retire', `${open} return state.retireId(s, 'T-AB-1', { by: 'AB', reason: 'x', at: '${AT}' });`],
  ['register new email', `${open} return state.registerHandle(s, { name: 'Zed Zee', email: 'zz@example.com', at: '${AT}' });`],
  ['register known email', `${open} return state.registerHandle(s, { name: 'A B', email: 'AB@example.com', at: '${AT}' });`],
  ['migrate', `${open} return state.migrate(s);`],
  ['migrate dry run', `${open} return state.migrate(s, { dryRun: true });`, { locked: false }],
];

test('SC10: a newer store refuses every write API with exit 7; only the lock is touched and the tree stays as it was', (t) => {
  const base = fixture(t, { 'state.json': stateDoc({ schema: KINDS.state.version + 1, future: 1 }) });
  for (const [label, body, opts] of WRITE_APIS) refuses(base, label, body, 'schema-newer', 'REFUSED', opts);
});

// Items 6 and 7: a newer file of the same kind anywhere in the store, or the target itself, refuses the write.
test('SC10: a newer sibling of the same kind, or a newer target, refuses with no write but the lock (no temporary file)', (t) => {
  const base = fixture(t, { 'tasks/T-AB-2/task.json': task('T-AB-2', { schema: KINDS.task.version + 1, future: 1 }) });
  for (const [label, body] of [
    ['write a sibling', `${open} s.write('task', 'T-AB-1', ${T('T-AB-1')});`],
    ['write a new task', `${open} s.write('task', 'T-AB-9', ${T('T-AB-9')});`],
    ['update a sibling', `${open} s.update('task', 'T-AB-1', (d) => d);`],
    ['create a new task', `${open} return s.create('task', 'T-AB-9', ${T('T-AB-9')});`],
    ['create over the newer target (review item 7)', `${open} return s.create('task', 'T-AB-2', ${T('T-AB-2')});`],
    ['allocate a task ID', `${open} return state.allocateId(s, { prefix: 'T', handle: 'AB', build: (id) => (${T('T-AB-1').replace("id: 'T-AB-1'", 'id')}) });`],
  ]) refuses(base, label, body, 'schema-newer', 'REFUSED');
  // Other kinds are not affected.
  const ok = traced(base, `${open} return s.create('team', 'CD', { handle: 'CD', emailSha256: '${'c'.repeat(64)}', addedAt: '${AT}' });`);
  assert.deepEqual([ok.error, ok.result], [null, true]);
});

test('a corrupt target: update refuses and create returns false, leaving only the lock touched (review item 12)', (t) => {
  const base = fixture(t, { 'tasks/T-AB-1/task.json': '{"schema":1,' });
  refuses(base, 'update', `${open} s.update('task', 'T-AB-1', (d) => d);`, 'state-invalid', 'FAIL');
  const before = snapshot(base);
  const created = traced(base, `${open} return s.create('task', 'T-AB-1', ${T('T-AB-1')});`);
  assert.deepEqual([created.error, created.result], [null, false], 'an existing (even corrupt) target is not created again');
  assert.deepEqual(created.writes.filter((w) => !lockOnly(base)(w)), []);
  assert.deepEqual(snapshot(base), before);
});

test('field and key refusals write nothing at all; a handle check under the lock touches only the lock', (t) => {
  const base = fixture(t);
  for (const [label, body, code] of [
    ['over a limit', `${open} s.write('task', 'T-AB-1', { ...${T('T-AB-1')}, title: 't'.repeat(121) });`, 'limit-exceeded'],
    ['key mismatch', `${open} s.write('task', 'T-AB-1', ${T('T-AB-2')});`, 'invalid-value'],
    ['invalid key', `${open} s.write('task', '../x', ${T('T-AB-1')});`, 'invalid-key'],
    ['lower-case key', `${open} s.read('task', 't-ab-1');`, 'invalid-key'],
    ['bad prefix', `${open} state.allocateId(s, { prefix: 'X', handle: 'AB', build: () => ({}) });`, 'invalid-value'],
    ['invalid explicit handle', `${open} state.registerHandle(s, { name: 'x', email: 'n@example.com', handle: 'ab', at: '${AT}' });`, 'invalid-key'],
    ['no email', `${open} state.registerHandle(s, { name: 'x', email: ' ', at: '${AT}' });`, 'email-required'],
  ]) refuses(base, label, body, code, 'USAGE', { locked: false });
  refuses(base, 'unknown handle', `${open} state.allocateId(s, { prefix: 'T', handle: 'ZZ', build: () => ({}) });`, 'handle-unknown', 'USAGE');
});

test('read-only use writes nothing: resolve, open, read, list, a dry-run migration; a migration with nothing to do touches only the lock', (t) => {
  const base = fixture(t);
  const before = snapshot(base);
  const out = traced(base, `const r = state.resolve({ cwd: repo, env, names }); const s = state.open(r.dir, { names });
return [r.active, s.read('task', 'T-AB-1').id, s.list('task'), state.migrate(s, { dryRun: true }).steps.length, state.machineDataDir(names, env) !== null];`);
  assert.deepEqual([out.error, out.result, out.writes], [null, [true, 'T-AB-1', ['T-AB-1', 'T-AB-2'], 0, true], []]);
  const fresh = traced(base, `const s = state.open(dir + '-absent', { names }); return [s.active, s.list('task'), s.read('team', 'AB')];`);
  assert.deepEqual([fresh.error, fresh.result, fresh.writes], [null, [false, [], null], []]);
  const noop = traced(base, `${open} return state.migrate(s);`);
  assert.deepEqual([noop.error, noop.result], [null, { steps: [], backup: null }]);
  assert.deepEqual(noop.writes.filter((w) => !lockOnly(base)(w)), []);
  assert.deepEqual(snapshot(base), before);
});

test('machine data: a newer projects.json refuses resolve (no call) and updateProject (only its lock)', (t) => {
  const base = fixture(t);
  const dataDir = join(base, 'home', '.claude', 'plugins', 'data', `${names.plugin}-${names.marketplace}`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), json({ schema: MACHINE_KINDS.projects.version + 1, projects: {} }));
  refuses(base, 'resolve', 'state.resolve({ cwd: repo, env, names });', 'schema-newer', 'REFUSED', { locked: false });
  refuses(base, 'updateProject', `state.updateProject({ repo, dataDir: state.machineDataDir(names, env), names, patch: { handle: 'AB' } });`, 'schema-newer', 'REFUSED');
});

// Found by the harness (round 3): a refused create must not even do housekeeping (sweeping a dead writer's
// temporary file) before it refuses. Its own temporary file is written and removed (link(2) is what fails), so
// the check is the net result: the tree as before, the dead writer's file untouched.
test('a create refused for a missing file system feature leaves a dead writer\'s temporary file alone', (t) => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const temp = `tasks/T-AB-9/.task.json.${dead}.0123abcd.tmp`;
  const base = fixture(t, { [temp]: 'partial' });
  const before = snapshot(base);
  const out = traced(base, `fs.linkSync = () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); }; syncBuiltinESMExports();
${open} return s.create('task', 'T-AB-9', ${T('T-AB-9')});`);
  assert.deepEqual([out.error?.code, out.error?.exit], ['fs-unsupported', 'REFUSED']);
  assert.deepEqual(out.writes.filter((w) => w.includes(`.${dead}.`)), [], 'the dead writer\'s file was not touched');
  assert.deepEqual(snapshot(base), before, 'no net change');
});
