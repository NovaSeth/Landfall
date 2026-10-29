// State schemas (spec §5, §5.1, §5.3, §8.2 limits, SD-9 ID formats): every state file kind has an integer
// schema version, strict fields, length limits and patterns. A write over a limit fails (never truncates);
// files are JSON with 2-space indent, a trailing newline and keys in schema order. REV-45: a valid document
// passes and the same document with one change fails, at the changed path.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
const { KINDS, MACHINE_KINDS, LIMITS, check, serialize } = state;

// Seeded PRNG (mulberry32): failures reproduce from the printed seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const AT = '2026-10-15T05:42:00.000Z';
const examples = {
  state: () => ({ schema: KINDS.state.version, codename: 'zzq', createdWith: '2.0.0', activatedAt: AT }),
  config: () => ({ schema: KINDS.config.version, flags: { scheduler: 'shadow', lanes: 'off' }, thresholds: { 'router.trivial.maxLoc': { value: 50, decision: 'D-MG-3', at: AT } }, executors: { reviewer: ['codex'] } }),
  team: () => ({ schema: KINDS.team.version, handle: 'MG', emailSha256: 'a'.repeat(64), addedAt: AT }),
  task: () => ({
    schema: KINDS.task.version, id: 'T-MG-1', kind: 'task', title: 'Add the state core', lane: 'state', owner: 'MG', class: 'critical',
    classHistory: [{ class: 'critical', reason: 'touches state', at: AT }], status: 'new', round: 0,
    events: [{ at: AT, by: 'MG', event: 'created', data: { note: 'x' } }], base: 'f2bb128', branch: 'feat/state-I2.1',
  }),
  tombstone: () => ({ schema: KINDS.tombstone.version, id: 'T-MG-7', retiredAt: AT, by: 'MG', reason: 'created by mistake' }),
  projects: () => ({ schema: MACHINE_KINDS.projects.version, projects: { '/work/repo': { stateDir: '/work/state' }, '/work/other': { declinedAt: AT, handle: 'MG' } } }),
  machineConfig: () => ({ schema: MACHINE_KINDS.machineConfig.version, flags: { 'guard-bash': 'on' }, executors: { implementer: ['claude'] } }),
};
const kindOf = (name) => KINDS[name] ?? MACHINE_KINDS[name];
const errorsAt = (name, doc) => check(kindOf(name), doc);
const set = (obj, path, value) => {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  if (value === undefined) delete o[keys.at(-1)]; else o[keys.at(-1)] = value;
  return obj;
};

test('the kinds of the state store and of machine data: versions, paths and keys round-trip', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['config', 'counter', 'state', 'task', 'team', 'tombstone']);
  assert.deepEqual(Object.keys(MACHINE_KINDS), ['projects', 'machine', 'machineConfig']); // T-MG-77 (intended): the machine id
  for (const [name, kind] of [...Object.entries(KINDS), ...Object.entries(MACHINE_KINDS)]) {
    assert.ok(Number.isInteger(kind.version) && kind.version >= 1, `${name}: integer version`);
    assert.ok(kind.readUpTo >= kind.version, `${name}: reads at least its own version`);
  }
  const keys = { state: null, config: null, team: 'MG', task: 'T-MG-12', tombstone: 'D-ABCD-999999', counter: 'T-MG' };
  for (const [name, key] of Object.entries(keys)) {
    const rel = KINDS[name].path(key);
    const m = KINDS[name].match.exec(rel);
    assert.ok(m, `${name}: ${rel} matches its own pattern`);
    assert.equal(m[1] ?? null, key, `${name}: the key comes back from the path`);
  }
  assert.equal(KINDS.task.path('T-MG-1'), 'tasks/T-MG-1/task.json');
  assert.equal(KINDS.team.path('MG'), 'team/MG.json');
  assert.equal(KINDS.state.path(), 'state.json');
});

test('spec §8.2 limits are the single source the schemas use', () => {
  assert.deepEqual({ title: LIMITS.title, evidence: LIMITS.evidence, reason: LIMITS.reason, glob: LIMITS.glob, eventData: LIMITS.eventData }, { title: 120, evidence: 300, reason: 200, glob: 120, eventData: 1024 });
});

test('valid documents pass and serialize as 2-space JSON with a trailing newline and keys in schema order', () => {
  for (const name of Object.keys(examples)) {
    const doc = examples[name]();
    assert.deepEqual(errorsAt(name, doc), [], name);
    const shuffled = Object.fromEntries(Object.entries(doc).reverse());
    const text = serialize(kindOf(name), shuffled);
    assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'), `${name}: one trailing newline`);
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, `${name}: 2-space JSON`);
    assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(doc), `${name}: keys in schema order`);
    assert.deepEqual(JSON.parse(text), doc, `${name}: lossless`);
  }
  // Map keys are sorted, so two writers produce the same bytes.
  const flags = serialize(KINDS.config, { ...examples.config(), flags: { b: 'on', a: 'off' } });
  assert.ok(flags.indexOf('"a"') < flags.indexOf('"b"'));
});

// Each limited field: exactly at the limit passes, one over fails with limit-exceeded at that path.
const LIMITED = [
  ['task', 'title', 120, (n) => 't'.repeat(n)],
  ['task', 'lane', 40, (n) => `a${'b'.repeat(n - 1)}`],
  ['task', 'branch', 200, (n) => `f/${'b'.repeat(n - 2)}`],
  ['task', 'classHistory.0.reason', 200, (n) => 'r'.repeat(n)],
  ['task', 'events.0.by', 80, (n) => `M${'g'.repeat(n - 1)}`],
  ['task', 'events.0.event', 40, (n) => 'e'.repeat(n)],
  ['tombstone', 'reason', 200, (n) => 'r'.repeat(n)],
  ['state', 'codename', 40, (n) => 'c'.repeat(n)],
];

test('limits: at the limit passes, one over fails with limit-exceeded (never truncated)', () => {
  for (const [name, path, max, make] of LIMITED) {
    assert.deepEqual(errorsAt(name, set(examples[name](), path, make(max))), [], `${name}.${path} at ${max}`);
    const errs = errorsAt(name, set(examples[name](), path, make(max + 1)));
    assert.equal(errs.length, 1, `${name}.${path} at ${max + 1}: ${JSON.stringify(errs)}`);
    assert.deepEqual([errs[0].path, errs[0].code], [path, 'limit-exceeded']);
  }
  // Characters, not UTF-16 units: 120 astral characters are a valid title.
  assert.deepEqual(errorsAt('task', set(examples.task(), 'title', '\u{1F600}'.repeat(120))), []);
  // Event data: serialized size in bytes.
  const data = (bytes) => ({ k: 'x'.repeat(bytes - 8) }); // {"k":""} is 8 bytes
  assert.deepEqual(errorsAt('task', set(examples.task(), 'events.0.data', data(1024))), []);
  assert.deepEqual(errorsAt('task', set(examples.task(), 'events.0.data', data(1025))).map((e) => [e.path, e.code]), [['events.0.data', 'limit-exceeded']]);
});

test('IDs, handles and lanes follow the spec patterns', () => {
  const ok = (name, path, v) => assert.deepEqual(errorsAt(name, set(examples[name](), path, v)), [], `${path}=${v}`);
  const bad = (name, path, v) => assert.deepEqual(errorsAt(name, set(examples[name](), path, v)).map((e) => [e.path, e.code]), [[path, 'invalid-value']], `${path}=${v}`);
  for (const v of ['T-AB-1', 'T-ABCD-999999']) ok('task', 'id', v);
  for (const v of ['T-A-1', 'T-ABCDE-1', 'T-AB-1234567', 'T-ab-1', 'T-AB-0', 'T-AB-01', 'D-AB-1', 'T-AB-1 ']) bad('task', 'id', v);
  for (const v of ['T-AB-3', 'D-AB-3']) ok('tombstone', 'id', v);
  for (const v of ['AB', 'ABCD']) ok('team', 'handle', v);
  for (const v of ['A', 'ABCDE', 'ab', 'A1', '']) bad('team', 'handle', v);
  for (const v of ['a', 'ui', 'state.v2', 'x_y-z']) ok('task', 'lane', v);
  for (const v of ['-a', 'A', 'a b', '.a']) bad('task', 'lane', v);
  for (const v of ['feat/x', 'main']) ok('task', 'branch', v);
  for (const v of ['-x', 'a..b', 'a b']) bad('task', 'branch', v);
  ok('task', 'lane', null);
  ok('task', 'class', null);
  bad('team', 'emailSha256', 'A'.repeat(64));
  // Machine data: absolute paths only (keys and the linked state directory).
  for (const projects of [{ 'relative/path': {} }, { '/abs': { stateDir: 'relative' } }, { '/abs': { handle: 'x' } }]) {
    const errs = errorsAt('projects', { ...examples.projects(), projects });
    assert.ok(errs.length === 1 && errs[0].code === 'invalid-value' && errs[0].path.startsWith('projects'), JSON.stringify(errs));
  }
});

// REV-45 property: random valid tasks pass; the same task with exactly one change fails at that path.
const MUTATIONS = [
  ['unknown field', (d) => { d.extra = 1; return 'extra'; }],
  ['missing field', (d) => { delete d.status; return 'status'; }],
  ['unknown nested field', (d) => { d.events[0].extra = 1; return 'events.0.extra'; }],
  ['wrong type', (d) => { d.round = '1'; return 'round'; }],
  ['negative round', (d) => { d.round = -1; return 'round'; }],
  ['fraction', (d) => { d.round = 1.5; return 'round'; }],
  ['enum outside', (d) => { d.status = 'finished'; return 'status'; }],
  ['control character', (d) => { d.title = `a\u0007b`; return 'title'; }],
  ['newline in a one-line field', (d) => { d.title = 'a\nb'; return 'title'; }],
  ['bidi override', (d) => { d.title = 'a\u202eb'; return 'title'; }],
  ['zero-width character', (d) => { d.title = 'a\u200bb'; return 'title'; }],
  ['empty title', (d) => { d.title = ''; return 'title'; }],
  ['time without offset', (d) => { d.events[0].at = '2026-10-15T05:42:00'; return 'events.0.at'; }],
  ['not a time', (d) => { d.events[0].at = 'yesterday'; return 'events.0.at'; }],
  ['impossible month', (d) => { d.events[0].at = '2026-13-15T05:42:00Z'; return 'events.0.at'; }],
  ['older schema', (d) => { d.schema = KINDS.task.version - 1; return 'schema'; }],
  ['newer schema', (d) => { d.schema = KINDS.task.version + 1; return 'schema'; }],
  ['array for object', (d) => { d.events[0].data = ['x']; return 'events.0.data'; }],
  ['null where not nullable', (d) => { d.owner = null; return 'owner'; }],
  ['object for array', (d) => { d.events = {}; return 'events'; }],
];

test('a valid document with one change fails at the changed path (seeded property, REV-45)', () => {
  const seed = 0x51A7E;
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  for (let i = 0; i < 300; i++) {
    const doc = examples.task();
    doc.title = 'w'.repeat(1 + Math.floor(rand() * 120));
    doc.status = pick(['new', 'planned', 'dispatched', 'implemented', 'in-review', 'fix-round', 'verified', 'done', 'blocked', 'cancelled']);
    doc.round = Math.floor(rand() * 5);
    doc.events = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, k) => ({ at: AT, by: pick(['MG', 'agent-7']), event: pick(['created', 'dispatched', 'fix-round']), data: { k } }));
    assert.deepEqual(errorsAt('task', doc), [], `seed ${seed} #${i}: valid`);
    const [label, mutate] = MUTATIONS[i % MUTATIONS.length];
    const path = mutate(doc);
    const errs = errorsAt('task', doc);
    assert.ok(errs.length >= 1 && errs.every((e) => e.path === path), `seed ${seed} #${i} ${label}: ${JSON.stringify(errs)}`);
    for (const e of errs) assert.ok(typeof e.message === 'string' && e.message.length > 0 && e.message.length <= 300);
  }
});

test('documents that are not objects fail without throwing', () => {
  for (const v of [null, 'x', 3, [], undefined]) assert.equal(errorsAt('task', v).length, 1);
});

// ---- Review round 1, item 10: what validates must survive serialization unchanged ----
// The validator's own definition of the round trip (findings-r2 point 6): the value read back is deeply,
// strictly equal (prototypes, array properties and -0 included).
const same = isDeepStrictEqual;
const roundTrips = (name, doc) => same(JSON.parse(serialize(kindOf(name), doc)), doc);

test('values JSON cannot carry are invalid: sparse arrays, non-plain objects, undefined, functions, symbols, BigInt, NaN, Infinity, -0, cycles', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const withGetter = Object.defineProperty({}, 'k', { get: () => 1, enumerable: true });
  const extraProp = Object.assign([{ at: AT, by: 'MG', event: 'x', data: {} }], { extra: 1 });
  class Thing { constructor() { this.k = 1; } }
  const cases = [
    ['sparse events (review repro)', 'events', new Array(1)],
    ['sparse classHistory', 'classHistory', [, { class: 'critical', reason: 'r', at: AT }]], // eslint-disable-line no-sparse-arrays
    ['array with an extra property', 'events', extraProp],
    ['class instance as data', 'events.0.data', new Thing()],
    ['Date as data', 'events.0.data', new Date(0)],
    ['Map as data', 'events.0.data', new Map([['a', 1]])],
    ['undefined in data', 'events.0.data', { a: undefined }],
    ['function in data', 'events.0.data', { f: () => 1 }],
    ['symbol in data', 'events.0.data', { s: Symbol('x') }],
    ['symbol key in data', 'events.0.data', { [Symbol('k')]: 1 }],
    ['BigInt in data', 'events.0.data', { n: 10n }],
    ['NaN in data', 'events.0.data', { n: NaN }],
    ['Infinity in data', 'events.0.data', { n: Infinity }],
    ['-0 in data', 'events.0.data', { n: -0 }],
    ['nested sparse array in data', 'events.0.data', { a: [1, , 3] }], // eslint-disable-line no-sparse-arrays
    ['cycle in data', 'events.0.data', cyclic],
    ['-0 round', 'round', -0],
    ['undefined optional-free field', 'lane', undefined],
  ];
  for (const [label, path, value] of cases) {
    const doc = examples.task();
    const keys = path.split('.');
    let o = doc;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = value; // set even when undefined: an own property holding undefined
    let errs;
    assert.doesNotThrow(() => { errs = errorsAt('task', doc); }, label);
    assert.ok(errs.length >= 1, `${label}: must be invalid`);
  }
  // A class instance or a null-prototype object as the whole document.
  assert.ok(errorsAt('team', Object.assign(new (class X {})(), examples.team())).length >= 1, 'class instance document');
  assert.ok(errorsAt('team', Object.assign(Object.create(null), examples.team())).length >= 1, 'a null-prototype object reads back as an ordinary object: invalid');
  // An accessor that yields the same value is data as written; the round trip decides.
  const withGetterDoc = examples.task();
  withGetterDoc.events[0].data = withGetter;
  assert.deepEqual(errorsAt('task', withGetterDoc), []);
  // Optional fields: absent is fine, an own property holding undefined is not.
  assert.deepEqual(errorsAt('projects', { schema: 1, projects: { '/a': {} } }), []);
  assert.ok(errorsAt('projects', { schema: 1, projects: { '/a': { stateDir: undefined } } }).length >= 1);
});

// Seeded property: random documents with random hostile values planted anywhere; whenever validation passes,
// the serialized file parses back to exactly the same value.
test('round-trip property: validate(x) passes \u21d2 parse(serialize(x)) equals x (seeded)', () => {
  const seed = 0x10AD;
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const hostile = () => pick([undefined, null, NaN, Infinity, -Infinity, -0, 0, 1.5, 10n, Symbol('s'), () => 1, new Date(0), new Map(), new (class K {})(), new Array(2), [1, , 2], Object.create(null), { a: undefined }, '', 'x', true, [], {}, [{}], { n: { m: [null] } }]); // eslint-disable-line no-sparse-arrays
  let passed = 0;
  for (let i = 0; i < 2000; i++) {
    const doc = examples.task();
    doc.events = Array.from({ length: Math.floor(rand() * 3) }, () => ({ at: AT, by: 'MG', event: 'e', data: {} }));
    const slots = [['title'], ['round'], ['lane'], ['class'], ['base']];
    for (let e = 0; e < doc.events.length; e++) slots.push(['events', e, 'data'], ['events', e, 'data', 'k'], ['events', e, 'data', 'k', 'deep']);
    const [first, ...rest] = pick(slots);
    let o = doc;
    const path = [first, ...rest];
    for (const k of path.slice(0, -1)) { if (o[k] === null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    if (rand() < 0.7) o[path.at(-1)] = hostile();
    const errs = errorsAt('task', doc);
    if (errs.length === 0) {
      passed++;
      assert.ok(roundTrips('task', doc), `seed ${seed} #${i}: validated but did not round-trip at ${path.join('.')}`);
    }
  }
  assert.ok(passed > 300, `the property exercised valid documents (${passed})`);
  for (const name of Object.keys(examples)) assert.ok(roundTrips(name, examples[name]()), name);
});

// ---- Review round 2 ----
// Item E (rereview-r1): a digit string that is not an array index (2^32 - 1) is an ordinary property, which
// JSON drops; validation must reject what the serialized file cannot give back.
test('an array property that is not an index is invalid (rereview item E)', () => {
  const doc = examples.task();
  doc.events = [];
  doc.events['4294967295'] = { discarded: 'data' };
  assert.ok(errorsAt('task', doc).length >= 1, 'events["4294967295"] would be lost by serialization');
  assert.equal(roundTrips('task', doc), false, 'it indeed does not round-trip');
});
