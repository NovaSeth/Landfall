// Task schema 3 and finding schema 2 (T-MG-116, D-MG-38, plan M1.1, P1, P13, RF2): a cancelled task may carry
// `outcome { kind: delivered|superseded|dropped, by, at }` and any task or finding may name the task it is a regression
// of (`regressionOf`). `by` is a task ID, a 7–40 hex SHA or vX.Y.Z and nothing else: reason text is untrusted, so an ID
// never carries the rest of a sentence. The reader before the bump refuses the new files as newer (GC9, exit 7).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const { EXIT } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'commands.mjs')).href);
const { KINDS, check } = state;
const AT = '2026-11-04T10:00:00.000Z';

const task = (extra = {}) => ({
  schema: KINDS.task.version, id: 'T-MG-1', kind: 'task', title: 'Cart', lane: null, owner: 'MG', class: null, classHistory: [],
  status: 'cancelled', round: 0, events: [], base: null, branch: null, ...extra,
});
const finding = (extra = {}) => ({
  schema: KINDS.finding.version, id: 'B-MG-1', status: 'open', task: 'T-MG-2', round: 1, reviewer: { kind: 'external', id: 'codex' },
  finding: 'B1', severity: 'blocking', path: null, line: null, rule: null, text: 'Lost event.', filedAt: AT, filedBy: 'MG',
  takenBy: null, closedAt: null, closedBy: null, reason: null, ...extra,
});
const outcome = (extra = {}) => ({ kind: 'delivered', by: 'T-MG-87', at: AT, ...extra });
const paths = (errors) => errors.map((e) => `${e.path}:${e.code}`);

test('versions: task schema 3, finding schema 2', () => {
  assert.equal(KINDS.task.version, 3);
  assert.equal(KINDS.finding.version, 2);
});

test('task outcome: the three kinds and every form of `by` validate; outcome and regressionOf stay optional', () => {
  assert.deepEqual(check(KINDS.task, task()), [], 'neither field is required');
  for (const kind of ['delivered', 'superseded', 'dropped']) assert.deepEqual(check(KINDS.task, task({ outcome: outcome({ kind }) })), [], kind);
  for (const by of ['T-MG-87', 'T-ABCD-999999', 'abcdef0', 'a'.repeat(40), 'v2.6.0', 'v10.20.300', null]) {
    assert.deepEqual(check(KINDS.task, task({ outcome: outcome({ by }) })), [], `by ${JSON.stringify(by)}`);
  }
  assert.deepEqual(check(KINDS.task, task({ regressionOf: 'T-MG-80' })), []);
  assert.deepEqual(check(KINDS.task, task({ outcome: outcome(), regressionOf: 'T-MG-80' })), []);
});

test('task outcome: a kind outside the three, a `by` that is not an ID, a bad time or a stray field is rejected at its path', () => {
  for (const kind of ['cancelled', 'done', 'Delivered', '', null]) {
    assert.deepEqual(paths(check(KINDS.task, task({ outcome: outcome({ kind }) }))), ['outcome.kind:invalid-value'], `kind ${JSON.stringify(kind)}`);
  }
  const badBy = ['T-MG-87; rm -rf', 'T-MG-87 ', ' T-MG-87', 'T-MG-0', 'T-mg-87', 'T-M-87', 'T-MG-1234567', 'B-MG-1', 'D-MG-38',
    'abcdef', 'a'.repeat(41), 'ABCDEF0', 'abcdefg', 'v2.6', 'v2.6.0-beta.1', '2.6.0', 'V2.6.0', 'delivered in T-MG-87', 'T-MG-87\nx', ''];
  for (const by of badBy) {
    assert.deepEqual(paths(check(KINDS.task, task({ outcome: outcome({ by }) }))), ['outcome.by:invalid-value'], `by ${JSON.stringify(by)}`);
  }
  assert.deepEqual(paths(check(KINDS.task, task({ outcome: outcome({ by: 7 }) }))), ['outcome.by:invalid-value'], 'by is a string');
  assert.deepEqual(paths(check(KINDS.task, task({ outcome: outcome({ at: '2026-11-04' }) }))), ['outcome.at:invalid-value']);
  const { at: _at, ...noAt } = outcome();
  assert.deepEqual(paths(check(KINDS.task, task({ outcome: noAt }))), ['outcome.at:invalid-value'], 'at is required');
  const { by: _by, ...noBy } = outcome();
  assert.deepEqual(paths(check(KINDS.task, task({ outcome: noBy }))), ['outcome.by:invalid-value'], 'by is required (null when unknown)');
  assert.deepEqual(paths(check(KINDS.task, task({ outcome: outcome({ note: 'x' }) }))), ['outcome.note:invalid-value'], 'no stray field');
  assert.ok(check(KINDS.task, task({ outcome: 'delivered' })).length > 0, 'outcome is an object');
  assert.ok(check(KINDS.task, task({ outcome: null })).length > 0, 'outcome is absent, never null');
});

test('regressionOf on a task and a finding is a task ID and nothing else', () => {
  assert.deepEqual(check(KINDS.finding, finding()), [], 'optional on a finding');
  assert.deepEqual(check(KINDS.finding, finding({ regressionOf: 'T-MG-80' })), []);
  for (const bad of ['B-MG-1', 'D-MG-38', 'T-MG-0', 'T-MG-80; x', 'abcdef0', 'v2.6.0', '', null, 80]) {
    assert.deepEqual(paths(check(KINDS.task, task({ regressionOf: bad }))), ['regressionOf:invalid-value'], `task ${JSON.stringify(bad)}`);
    assert.deepEqual(paths(check(KINDS.finding, finding({ regressionOf: bad }))), ['regressionOf:invalid-value'], `finding ${JSON.stringify(bad)}`);
  }
});

test('a schema-3 task and a schema-2 finding under the reader before the bump are refused as newer (REFUSED, exit 7)', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-schema-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = state.open(dir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  store.write('task', 'T-MG-1', task({ outcome: outcome(), regressionOf: 'T-MG-80' }));
  store.write('finding', 'B-MG-1', finding({ regressionOf: 'T-MG-80' }));
  // The plugin before the bump (2.6.0): task schema 2 with mergedAt, finding schema 1, and no steps 006 and 007.
  const { schema: _s, outcome: _o, regressionOf: _r, ...taskFields } = KINDS.task.spec.f;
  const { schema: _fs, regressionOf: _fr, ...findingFields } = KINDS.finding.spec.f;
  const oldTask = state.defineKind('task', 2, { dir: 'tasks', keyPattern: KINDS.task.keyPattern, file: (id) => `tasks/${id}/task.json`, match: KINDS.task.match, key: 'id', fields: taskFields, opt: ['mergedAt'] });
  const oldFinding = state.defineKind('finding', 1, { dir: 'findings', keyPattern: KINDS.finding.keyPattern, file: (id) => `findings/${id}.json`, match: KINDS.finding.match, key: 'id', fields: findingFields });
  const old = state.open(dir, {
    names, kinds: { ...KINDS, task: oldTask, finding: oldFinding },
    migrations: state.MIGRATIONS.filter((m) => !(m.kind === 'task' && m.from >= 2) && !(m.kind === 'finding' && m.from >= 1)),
  });
  const newer = (schema, known) => (e) => e instanceof state.StateError && e.code === 'schema-newer' && e.exit === 'REFUSED'
    && EXIT.REFUSED === 7 && new RegExp(`has schema ${schema}; this plugin knows schema ${known}`).test(e.message);
  assert.throws(() => old.read('task', 'T-MG-1'), newer(3, 2));
  assert.throws(() => old.read('finding', 'B-MG-1'), newer(2, 1));
  assert.equal(store.read('task', 'T-MG-1').outcome.by, 'T-MG-87', 'the current reader reads it');
  mkdirSync(join(dir, 'tasks', 'T-MG-3'), { recursive: true });
  writeFileSync(join(dir, 'tasks', 'T-MG-3', 'task.json'), `${JSON.stringify(task({ id: 'T-MG-3', schema: 2 }), null, 2)}\n`);
  assert.equal(store.read('task', 'T-MG-3').schema, 3, 'a schema-2 task reads upgraded through 006');
});
