// The review need comes from the tier table (spec §7.4): class × applied tier (× a detected provider at critical L1)
// → none | any | external. The applied tier is L0 while the engine is in shadow mode or no tier decision exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The plugin directory comes from name.json (SD-30): this file holds no plugin name.
const pluginDir = readdirSync(join(root, 'plugins')).filter((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json'))).map((d) => join(root, 'plugins', d))[0];
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { reviewNeed, reviewState, appliedTier } = await lib('verify/artifacts.mjs');
const { routeFor } = await lib('router/index.mjs');

const steps = (cls) => routeFor(cls).steps;
const REVIEWERS = { claude: { kind: 'claude', id: 'claude:reviewer' }, external: { kind: 'external', id: 'codex:gpt' } };

// A store holding review rounds of task T-AB-1 (kind of the latest reviewer) and the given state flags.
function store(t, { rounds = [], flags = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-need-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docs = new Map(rounds.map(([verdict, who], i) => [`T-AB-1/review-r${i + 1}`, { schema: 1, verdict, reviewer: REVIEWERS[who], findings: [] }]));
  return {
    dir,
    list: (kind) => (kind === 'review' ? [...docs.keys()] : []),
    read: (kind, key) => (kind === 'state' ? { flags } : kind === 'review' ? docs.get(key) ?? null : null),
  };
}

test('the tier table: one row per class, one column per tier', () => {
  for (const tier of ['L0', 'L1', 'L2', 'L3']) assert.equal(reviewNeed('trivial', tier, true), 'none', tier);
  assert.deepEqual(['L0', 'L1', 'L2', 'L3'].map((tier) => reviewNeed('standard', tier, false)), ['none', 'any', 'any', 'any']);
  assert.deepEqual(['L0', 'L1', 'L2', 'L3'].map((tier) => reviewNeed('critical', tier, false)), ['any', 'any', 'external', 'external']);
  assert.deepEqual(['L0', 'L1', 'L2', 'L3'].map((tier) => reviewNeed('critical', tier, true)), ['any', 'external', 'external', 'external']);
});

test('the applied tier is L0 in shadow mode and without a tier decision', (t) => {
  assert.equal(appliedTier(store(t)), 'L0', 'absent flag = shadow');
  assert.equal(appliedTier(store(t, { flags: { engine: 'shadow' } })), 'L0');
  assert.equal(appliedTier(store(t, { flags: { engine: 'on' } })), 'L0', 'no tier decision');
});

test('1: standard at L0 without a review: the review step is not required', (t) => {
  assert.equal(reviewState(store(t), 'T-AB-1', steps('standard')), 'not-required');
  assert.equal(reviewState(store(t), 'T-AB-1', steps('standard'), { tier: 'L0' }), 'not-required');
});

test('2: standard at L1: missing without a review, approved with a claude review', (t) => {
  assert.equal(reviewState(store(t), 'T-AB-1', steps('standard'), { tier: 'L1' }), 'missing');
  assert.equal(reviewState(store(t, { rounds: [['approved', 'claude']] }), 'T-AB-1', steps('standard'), { tier: 'L1' }), 'approved');
  assert.equal(reviewState(store(t, { rounds: [['approved', 'claude'], ['needs-fixes', 'claude']] }), 'T-AB-1', steps('standard'), { tier: 'L1' }), 'missing', 'the latest round counts');
});

test('3: critical at L1 without a provider takes a claude review; critical at L2 needs an external one', (t) => {
  const claude = store(t, { rounds: [['approved', 'claude']] });
  assert.equal(reviewState(claude, 'T-AB-1', steps('critical'), { tier: 'L1' }), 'approved', 'no provider detected');
  assert.equal(reviewState(claude, 'T-AB-1', steps('critical'), { tier: 'L1', providerAvailable: true }), 'missing');
  assert.equal(reviewState(claude, 'T-AB-1', steps('critical'), { tier: 'L2' }), 'missing');
  assert.equal(reviewState(store(t, { rounds: [['approved', 'external']] }), 'T-AB-1', steps('critical'), { tier: 'L2' }), 'approved');
  assert.equal(reviewState(store(t), 'T-AB-1', steps('critical')), 'missing', 'critical at L0 still needs a review');
  assert.equal(reviewState(claude, 'T-AB-1', steps('critical')), 'approved', 'critical at L0 takes any review');
});
