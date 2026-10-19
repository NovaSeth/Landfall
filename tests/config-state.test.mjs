// The config kind of the state (spec §5.1 config.json, §5.4, §14, SD-38): capability flags, threshold overrides that
// cite a decision, executor role preferences. The flags map moved out of state.json (store schema 2): a state.json of
// schema 1 with a flags map is read as before (its flags are carried into the config on read, nothing lost) and
// `migrate` moves them for good; a newer config.json or state.json refuses (exit 7). The shadow log is appended
// through store.append (local/shadow.jsonl, one JSON line per entry, under the store lock).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const { KINDS, MACHINE_KINDS, StateError } = state;
const AT = '2026-10-18T10:00:00.000Z';
const is = (code, exit) => (e) => e instanceof StateError && e.code === code && e.exit === exit;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'config-state-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
const put = (dir, rel, value) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null);
const v1State = (flags) => ({ schema: 1, codename: names.codename, createdWith: '2.0.0-beta.1', activatedAt: AT, flags });
const v2State = (extra = {}) => ({ schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT, ...extra });
const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

test('state.json is store schema 2 without a flags map; config.json holds flags, threshold overrides with their decision and executor preferences', (t) => {
  const dir = join(scratch(t), 'store');
  assert.equal(KINDS.state.version, 2);
  assert.deepEqual(state.check(KINDS.state, v2State()), []);
  assert.ok(state.check(KINDS.state, v2State({ flags: {} })).some((e) => e.path === 'flags'), 'a flags map is no longer a state.json field');
  put(dir, 'state.json', v2State());
  const s = state.open(dir, { names });
  assert.equal(s.read('config', null), null, 'no config.json: nothing configured');
  const doc = {
    flags: { engine: 'off', lanes: 'on' },
    thresholds: { 'router.trivial.maxLoc': { value: 50, decision: 'D-AB-3', at: AT } },
    executors: { reviewer: ['codex', 'claude'], implementer: ['claude'] },
  };
  s.write('config', null, doc);
  assert.deepEqual(s.read('config', null), { schema: 1, ...doc });
  assert.deepEqual(JSON.parse(read(dir, 'config.json')), { schema: 1, ...doc });
  // Every part is optional; a threshold override without its decision, a bad mode or a bad provider is refused.
  s.write('config', null, { flags: { engine: 'on' } });
  assert.deepEqual(s.read('config', null), { schema: 1, flags: { engine: 'on' } });
  for (const bad of [
    { thresholds: { 'router.trivial.maxLoc': { value: 50, at: AT } } },
    { thresholds: { 'router.trivial.maxLoc': { value: 50, decision: 'not-an-id', at: AT } } },
    { thresholds: { 'router.trivial.maxLoc': { value: -1, decision: 'D-AB-3', at: AT } } },
    { thresholds: { 'Router..x': { value: 1, decision: 'D-AB-3', at: AT } } },
    { flags: { engine: 'maybe' } },
    { executors: { reviewer: ['Not A Provider'] } },
    { executors: { designer: [] } },
  ]) assert.throws(() => s.write('config', null, bad), is('invalid-value', 'USAGE'), JSON.stringify(bad));
  assert.deepEqual(s.read('config', null), { schema: 1, flags: { engine: 'on' } }, 'a refused write wrote nothing');
});

test('a state.json of schema 1 with a flags map is read as before: its flags are carried into the config, nothing lost (acceptance 4)', (t) => {
  const dir = join(scratch(t), 'store');
  const legacy = v1State({ engine: 'off', lanes: 'on', 'pre-push': 'off' });
  put(dir, 'state.json', legacy);
  const s = state.open(dir, { names });
  const before = read(dir, 'state.json');
  assert.deepEqual(s.read('state', null), { schema: 2, codename: names.codename, createdWith: '2.0.0-beta.1', activatedAt: AT }, 'state.json upgrades in memory');
  assert.deepEqual(s.read('config', null), { schema: 1, flags: { engine: 'off', lanes: 'on', 'pre-push': 'off' } }, 'the flags are read from the old state.json');
  assert.equal(read(dir, 'state.json'), before, 'a read writes nothing');
  assert.equal(read(dir, 'config.json'), null);
  // A config write starts from the carried flags: the old ones survive next to the new one; the config wins.
  s.update('config', null, (cur) => ({ ...cur, flags: { ...cur.flags, engine: 'on' } }));
  assert.deepEqual(JSON.parse(read(dir, 'config.json')).flags, { engine: 'on', lanes: 'on', 'pre-push': 'off' });
  assert.deepEqual(s.read('config', null).flags, { engine: 'on', lanes: 'on', 'pre-push': 'off' }, 'config.json wins over the old state.json');
  assert.equal(read(dir, 'state.json'), before, 'state.json is left for migrate');
  // An old state.json with an empty flags map carries nothing.
  const empty = join(scratch(t), 'empty');
  put(empty, 'state.json', v1State({}));
  assert.equal(state.open(empty, { names }).read('config', null), null);
  // Writes of other kinds still work on the old store (it is older, not newer).
  assert.equal(state.open(empty, { names }).create('team', 'AB', { handle: 'AB', emailSha256: 'a'.repeat(64), addedAt: AT }), true);
});

test('migrate moves the flags of an old state.json into config.json and drops them from state.json; config.json entries win', (t) => {
  const dir = join(scratch(t), 'store');
  put(dir, 'state.json', v1State({ engine: 'off', lanes: 'on' }));
  put(dir, 'config.json', { schema: 1, flags: { lanes: 'off', admission: 'on' } });
  const s = state.open(dir, { names });
  const dry = state.migrate(s, { dryRun: true });
  assert.deepEqual(dry.steps.map(({ rel, kind, from, to, ids }) => ({ rel, kind, from, to, ids })), [
    { rel: 'config.json', kind: 'config', from: 1, to: 1, ids: ['001-state-flags-to-config'] },
    { rel: 'state.json', kind: 'state', from: 1, to: 2, ids: ['001-state-flags-to-config'] },
  ], 'the dry run lists the config.json step before the state.json step');
  assert.equal(JSON.parse(read(dir, 'state.json')).schema, 1, 'the dry run wrote nothing');
  const r = state.migrate(s);
  assert.equal(r.steps.length, 2);
  assert.deepEqual(JSON.parse(read(dir, 'state.json')), { schema: 2, codename: names.codename, createdWith: '2.0.0-beta.1', activatedAt: AT });
  assert.deepEqual(JSON.parse(read(dir, 'config.json')).flags, { admission: 'on', engine: 'off', lanes: 'off' });
  assert.equal(JSON.parse(read(join(dir, r.backup), 'state.json')).flags.engine, 'off', 'the old state.json is in the backup');
  assert.deepEqual(state.migrate(s), { steps: [], backup: null }, 'a second run writes nothing');
  // Without a config.json, the carried flags create it; an empty flags map creates none.
  const fresh = join(scratch(t), 'fresh');
  put(fresh, 'state.json', v1State({ engine: 'on' }));
  const f = state.migrate(state.open(fresh, { names }));
  assert.deepEqual(f.steps.map((x) => [x.rel, x.from]), [['config.json', null], ['state.json', 1]]);
  assert.deepEqual(JSON.parse(read(fresh, 'config.json')), { schema: 1, flags: { engine: 'on' } });
  const none = join(scratch(t), 'none');
  put(none, 'state.json', v1State({}));
  assert.deepEqual(state.migrate(state.open(none, { names })).steps.map((x) => x.rel), ['state.json']);
  assert.equal(read(none, 'config.json'), null);
});

test('a newer config.json or state.json refuses with exit 7 before any byte is written', (t) => {
  const dir = join(scratch(t), 'store');
  put(dir, 'state.json', v2State());
  put(dir, 'config.json', { schema: 2, flags: { engine: 'on' }, future: true });
  const s = state.open(dir, { names });
  const before = listing(dir);
  assert.throws(() => s.read('config', null), is('schema-newer', 'REFUSED'));
  assert.throws(() => s.update('config', null, () => ({ flags: {} })), is('schema-newer', 'REFUSED'));
  assert.throws(() => state.migrate(s, { dryRun: true }), is('schema-newer', 'REFUSED'));
  assert.deepEqual(listing(dir), before);
  const newer = join(scratch(t), 'newer');
  put(newer, 'state.json', v2State({ schema: 3, flags: { engine: 'on' } }));
  const n = state.open(newer, { names });
  assert.equal(n.read('config', null), null, 'reads go by the file kind (spec §5.4): a newer store.json carries nothing into it');
  assert.throws(() => n.write('config', null, { flags: { engine: 'off' } }), is('schema-newer', 'REFUSED'));
  assert.equal(read(newer, 'config.json'), null);
});

test('machine config: flags and executor preferences in the plugin data directory, schema-versioned, read-only for the plugin', (t) => {
  const data = join(scratch(t), 'data');
  assert.equal(state.readMachineConfig(data, names), null, 'absent: nothing configured');
  put(data, 'config.json', { schema: 1, flags: { 'guard-bash': 'off' }, executors: { reviewer: ['codex'] } });
  assert.deepEqual(state.readMachineConfig(data, names), { schema: 1, flags: { 'guard-bash': 'off' }, executors: { reviewer: ['codex'] } });
  put(data, 'config.json', { schema: 2 });
  assert.throws(() => state.readMachineConfig(data, names), is('schema-newer', 'REFUSED'));
  put(data, 'config.json', '{"schema":1,');
  assert.throws(() => state.readMachineConfig(data, names), is('state-invalid', 'FAIL'));
  put(data, 'config.json', { schema: 1, thresholds: {} });
  assert.throws(() => state.readMachineConfig(data, names), is('state-invalid', 'FAIL'), 'thresholds are per repository (they cite its decisions)');
  assert.equal(MACHINE_KINDS.machineConfig.path(), 'config.json', 'a machine kind');
});

test('store.append writes one JSON line to the shadow log under the store lock; a callback decides on the log text', (t) => {
  const dir = join(scratch(t), 'store');
  put(dir, 'state.json', v2State());
  const s = state.open(dir, { names });
  assert.deepEqual(s.append('shadow', { at: AT, capability: 'engine', event: 'tier' }), { at: AT, capability: 'engine', event: 'tier' });
  const seen = [];
  assert.equal(s.append('shadow', (text) => { seen.push(text); return undefined; }), null, 'undefined: nothing appended');
  s.append('shadow', (text) => ({ at: AT, capability: 'auto-allow', lines: text.split('\n').filter(Boolean).length }));
  assert.deepEqual(read(dir, 'local/shadow.jsonl').split('\n'), [
    JSON.stringify({ at: AT, capability: 'engine', event: 'tier' }),
    JSON.stringify({ at: AT, capability: 'auto-allow', lines: 1 }),
    '',
  ]);
  assert.equal(seen[0], `${JSON.stringify({ at: AT, capability: 'engine', event: 'tier' })}\n`);
  assert.deepEqual(readdirSync(join(dir, 'local')).filter((n) => n.startsWith('lock')), [], 'the lock is released');
  // A line that does not end in a newline (a torn append of an older writer) gets one first.
  writeFileSync(join(dir, 'local/shadow.jsonl'), '{"torn":');
  s.append('shadow', { at: AT });
  assert.equal(read(dir, 'local/shadow.jsonl'), `{"torn":\n${JSON.stringify({ at: AT })}\n`);
  // Refusals write nothing: not an object, too large, an unknown log, a newer store, an inactive store.
  const before = read(dir, 'local/shadow.jsonl');
  assert.throws(() => s.append('shadow', ['x']), is('invalid-value', 'USAGE'));
  assert.throws(() => s.append('shadow', { big: 'x'.repeat(20000) }), is('limit-exceeded', 'USAGE'));
  assert.throws(() => s.append('nolog', { at: AT }), TypeError);
  assert.equal(read(dir, 'local/shadow.jsonl'), before);
  put(dir, 'state.json', v2State({ schema: 3 }));
  assert.throws(() => s.append('shadow', { at: AT }), is('schema-newer', 'REFUSED'));
  assert.equal(read(dir, 'local/shadow.jsonl'), before);
  const inactive = join(scratch(t), 'inactive');
  assert.throws(() => state.open(inactive, { names }).append('shadow', { at: AT }), is('inactive', 'REFUSED'));
  assert.equal(existsSync(inactive), false, 'an inactive store gets no directory');
});
