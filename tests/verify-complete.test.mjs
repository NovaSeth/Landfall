// Verify completion (spec §5.1, §7.6, §8.2, SD-16, SD-47, GC3): `review record <id> --from <file>` validates a typed
// review against templates/review.schema.json and writes the next review-r<k>.json through the review kind;
// `baseline show` prints the pinned inventory and `baseline pin --decision <D>` repairs it (after a collector change
// or a resolved tests.json conflict) with an active decision, which the baseline records; `decide
// --allows-test-removal <ids>` fills the record field verify reads, and verify accepts exactly those removals; the
// task report template opens with red/green frontmatter; `task set <id> done` names `task done <id>`. Two parts of
// the flow verify → review record → task done → task merge: a review recorded after a passing verify is bound by
// value when the task closes, and a done task merges.
// This file holds no plugin name, path or literal decision ID: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (git, node, the gates) gets a throwaway HOME and environment (S1).
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const decisions = await lib('decisions/index.mjs');
const verify = await lib('verify/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const schemaJson = () => JSON.parse(readFileSync(join(pluginDir, 'templates', 'review.schema.json'), 'utf8'));
const TEMPLATE = readFileSync(join(pluginDir, 'templates', 'task', 'report.md'), 'utf8');
const AT = '2026-10-16T05:42:00.000Z';
const TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\ntest('subtracts', () => {});\n";
const NODE_TEST = { name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' };
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "2 passing"}\n---\n\n# Report\n';
const N = (title, n = 1) => JSON.stringify(['', title, n]);
const REVIEW = { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] };
const FINDING = { id: 'F1', severity: 'blocking', path: 'calc.mjs', line: 3, rule: 'COD-7', text: 'subtract has no test' };

// A throwaway repository with `files` committed, an active store (handle of the git identity), the profile gates,
// a dispatched task (base = the first commit) and its report with RED/GREEN evidence; all committed.
function repo(t, { files = { 'calc.test.mjs': TESTS }, gates = [NODE_TEST], cls = 'trivial', report = REPORT, tier = 'L2' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-complete-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(dir);
  mkdirSync(home);
  const env = { ...ISO.env, HOME: home };
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  if (tier !== 'L0') store.write('config', null, { flags: { engine: 'on' } });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  // The applied tier (spec §7.4): L2 by default, where a standard task needs a review and a critical one an external one.
  if (tier !== 'L0') decisions.createDecision({ store, where: state.resolve({ cwd: dir, env, names }), names, env, handle, today: AT.slice(0, 10), input: { title: `Tier ${tier} from L0`, why: 'test fixture', cost: 'none', kind: 'tier', scope: [], supersedes: [] } });
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: cls, classHistory: [{ class: cls, reason: `${cls}: test`, at: AT }], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  if (report !== null) write(`${names.stateDir}/tasks/${id}/report.md`, report);
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  return { base, dir, home, env, stateDir, store, handle, id, head, git, write, vstore: verify.openStore(stateDir, names) };
}

async function cli(args, { dir, env, json = true, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd: dir, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const text = out.join('');
  return { code, text, stderr: err.join(''), env: json ? JSON.parse(text) : null };
}
const run = (r, ...extra) => cli(['verify', r.id, '--yes', ...extra], r);
const done = (r) => cli(['task', 'done', r.id, '--yes'], r);
const show = (res) => `${res.text}\n${res.stderr}`;
const errorCodes = (res) => res.env.errors.map((e) => e.code);
const commitAll = (r, msg = 'work') => { r.git('add', '-A'); r.git('commit', '-q', '-m', msg); return r.git('rev-parse', 'HEAD'); };
const setGates = (r, gates) => profile.openStore(r.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
// Commits everything and makes that commit the task base, so the committed baseline anchors later test changes.
function rebase(r, msg = 'anchor') {
  const base = commitAll(r, msg);
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'dispatched', options: { executor: 'claude:implementer', base } });
  return base;
}
// A review input file outside the repository; `value` is written as JSON unless it is a string.
function reviewFile(r, value, name = 'review.json') {
  const file = join(r.base, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
const record = (r, file, extra = []) => cli(['review', 'record', r.id, '--from', file, '--yes', ...extra], r);
const reviewKeys = (r) => r.vstore.list('review').filter((k) => k.startsWith(`${r.id}/`));
const decide = (r, ...flags) => cli(['decide', '--title', 'Remove obsolete tests', '--why', 'They test removed code.', '--cost', 'Lost coverage.', '--yes', ...flags], r);
const recordOf = (r, id) => decisions.parseRecord(readFileSync(join(r.stateDir, 'decisions', `${id}.md`), 'utf8'), `${id}.md`).doc;

// ---- (1) review record ----

test('review record: a valid typed review becomes review-r<k>.json through the review kind; rounds count up', async (t) => {
  const r = repo(t, { cls: 'standard' });
  const first = { verdict: 'needs-fixes', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [FINDING, { ...FINDING, id: 'F2', severity: 'minor', path: null, line: null, rule: null, text: 'naming' }] };
  let res = await record(r, reviewFile(r, first));
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.env.command, res.env.data.task, res.env.data.round, res.env.data.verdict], ['review record', r.id, 1, 'needs-fixes']);
  assert.equal(res.env.data.file, `${names.stateDir}/tasks/${r.id}/review-r1.json`);
  assert.deepEqual(r.vstore.read('review', verify.reviewKey(r.id, 1)), { schema: 1, ...first });
  const event = r.store.read('task', r.id).events.at(-1);
  assert.deepEqual([event.event, event.by, event.data], ['review', r.handle, { round: 1, verdict: 'needs-fixes', reviewer: 'claude' }]);
  assert.equal(verify.reviewState(r.vstore, r.id, ['review']), 'missing', 'the latest round needs fixes');

  // A relative path is read from the current directory; the next round is r2.
  writeFileSync(join(r.dir, 'r2.json'), JSON.stringify(REVIEW));
  res = await record(r, 'r2.json');
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.round, 2);
  assert.deepEqual(reviewKeys(r), [verify.reviewKey(r.id, 1), verify.reviewKey(r.id, 2)]);
  assert.equal(verify.reviewState(r.vstore, r.id, ['review']), 'approved');
  const text = await cli(['review', 'record', r.id, '--from', reviewFile(r, REVIEW), '--yes'], { ...r, json: false });
  assert.equal(text.code, 0, show(text));
  assert.match(text.text, /review r3 recorded: approved by claude:reviewer/);
});

test('review record: input that breaks review.schema.json exits 2 naming the failing field; nothing is written', async (t) => {
  const r = repo(t);
  const long = 'x'.repeat(501);
  const cases = [
    [{ ...REVIEW, verdict: 'ok' }, 'verdict'],
    [{ verdict: 'approved', findings: [] }, 'reviewer'],
    [{ ...REVIEW, reviewer: { kind: 'human', id: 'me' } }, 'reviewer.kind'],
    [{ ...REVIEW, score: 3 }, 'score'],
    [{ ...REVIEW, findings: [{ ...FINDING, severity: 'major' }] }, 'findings[0].severity'],
    [{ ...REVIEW, findings: [{ ...FINDING, text: long }] }, 'findings[0].text'],
    [{ ...REVIEW, findings: [{ ...FINDING, text: 'two\nlines' }] }, 'findings[0].text'],
    [{ ...REVIEW, findings: [{ ...FINDING, line: 0 }] }, 'findings[0].line'],
    [{ ...REVIEW, findings: [{ id: 'F1', severity: 'minor', text: 'x' }] }, 'findings[0].path'],
    [{ ...REVIEW, findings: {} }, 'findings'],
  ];
  for (const [value, field] of cases) {
    const res = await record(r, reviewFile(r, value));
    assert.equal(res.code, 2, `${field}: ${show(res)}`);
    assert.equal(res.env.exit, 'USAGE');
    assert.equal(errorCodes(res)[0], 'invalid-review', field);
    assert.ok(res.env.errors.some((e) => e.message.startsWith(`${field}:`)), `${field} named: ${res.env.errors.map((e) => e.message).join(' | ')}`);
  }
  for (const [raw, code] of [['{"verdict": ', 'invalid-review'], ['[]', 'invalid-review']]) {
    const res = await record(r, reviewFile(r, raw));
    assert.deepEqual([res.code, errorCodes(res)[0]], [2, code], show(res));
  }
  let res = await record(r, join(r.base, 'missing.json'));
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'review-unreadable'], show(res));
  res = await cli(['review', 'record', r.id, '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'missing-flag'], show(res));
  assert.deepEqual(reviewKeys(r), [], 'nothing written');
  assert.ok(!r.store.read('task', r.id).events.some((e) => e.event === 'review'));
});

test('review.schema.json is the typed contract: strict objects, every property required, the review kind\'s values and limits', async () => {
  const SCHEMA = schemaJson();
  const objects = [];
  const walk = (s, at) => {
    if (s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))) objects.push([at, s]);
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${at}.${k}`);
    if (s.items) walk(s.items, `${at}[]`);
  };
  walk(SCHEMA, '$');
  assert.deepEqual(objects.map(([at]) => at), ['$', '$.reviewer', '$.findings[]']);
  for (const [at, s] of objects) {
    assert.equal(s.additionalProperties, false, `${at}: no other fields`);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${at}: every property required (nullable by type)`);
  }
  assert.deepEqual(SCHEMA.properties.verdict.enum, [...verify.REVIEW_VERDICTS]);
  // The schema and the review kind agree on every sample: what one accepts the other accepts.
  const samples = [
    REVIEW, { ...REVIEW, verdict: 'needs-fixes', findings: [FINDING] }, { ...REVIEW, reviewer: { kind: 'external', id: 'codex' } },
    { ...REVIEW, findings: [{ ...FINDING, path: null, line: null, rule: null }] },
    { ...REVIEW, verdict: 'ok' }, { ...REVIEW, reviewer: { kind: 'claude', id: '-x' } }, { ...REVIEW, reviewer: { kind: 'claude', id: '' } },
    { ...REVIEW, findings: [{ ...FINDING, id: '' }] }, { ...REVIEW, findings: [{ ...FINDING, id: 'x'.repeat(41) }] },
    { ...REVIEW, findings: [{ ...FINDING, text: '' }] }, { ...REVIEW, findings: [{ ...FINDING, text: 'x'.repeat(500) }] },
    { ...REVIEW, findings: [{ ...FINDING, text: 'x'.repeat(501) }] }, { ...REVIEW, findings: [{ ...FINDING, text: 'tab\there' }] },
    { ...REVIEW, findings: [{ ...FINDING, text: 'zero​width' }] }, { ...REVIEW, findings: [{ ...FINDING, rule: 'r'.repeat(41) }] },
    { ...REVIEW, findings: [{ ...FINDING, line: 1.5 }] }, { ...REVIEW, findings: [{ ...FINDING, line: 100000001 }] },
    { ...REVIEW, findings: [{ ...FINDING, path: 'p'.repeat(4097) }] }, { ...REVIEW, findings: [{ ...FINDING, extra: 1 }] },
  ];
  for (const s of samples) {
    const bySchema = verify.reviewErrors(s).length === 0;
    const byKind = state.check(verify.VERIFY_KINDS.review, { schema: 1, ...s }).length === 0;
    assert.equal(bySchema, byKind, `schema and kind disagree on ${JSON.stringify(s).slice(0, 120)}`);
  }
  assert.throws(() => verify.schemaErrors({ type: 'string', format: 'email' }, 'a'), /format/, 'an unsupported keyword is an error, never ignored');
});

test('review record: the owner records, only on an open task, in an active repository, with consent', async (t) => {
  const r = repo(t);
  state.registerHandle(r.store, { name: 'Other Person', email: 'other@example.com', at: AT });
  const other = { ...r, env: { ...r.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'other@example.com' } };
  const file = reviewFile(r, REVIEW);
  let res = await record(other, file);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'not-owner'], show(res));
  res = await cli(['review', 'record', r.id, '--from', file], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [7, 'consent-required'], show(res));
  res = await cli(['review', 'record', `${r.id.replace(/\d+$/, '')}99`, '--from', file, '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'task-unknown'], show(res));
  state.setTask({ cwd: r.dir, env: r.env, names, id: r.id, state: 'cancelled', options: { reason: 'dropped' } });
  res = await record(r, file);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'task-closed'], show(res));
  assert.deepEqual(reviewKeys(r), []);
  rmSync(r.stateDir, { recursive: true, force: true });
  res = await record(r, file);
  assert.equal(res.code, 7, show(res));
});

// ---- the flow verify → review record → task done ----

test('a review recorded after a passing verify is bound by value: task done closes; a later needs-fixes round keeps a standard task open', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0);
  r.vstore.write('review', verify.reviewKey(r.id, 1), REVIEW);
  let d = await done(r);
  assert.equal(d.code, 0, `a typed review is not code: ${show(d)}`);
  const file = join(r.stateDir, 'receipts', `${r.id}.json`);
  assert.ok(existsSync(file), 'task done wrote receipts/<id>.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).task, r.id);

  const s = repo(t, { cls: 'standard' });
  s.vstore.write('review', verify.reviewKey(s.id, 1), REVIEW);
  commitAll(s, 'review r1');
  assert.equal((await run(s)).code, 0);
  s.vstore.write('review', verify.reviewKey(s.id, 2), { ...REVIEW, verdict: 'needs-fixes', findings: [FINDING] });
  d = await done(s);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'review-missing'], show(d));
  s.vstore.write('review', verify.reviewKey(s.id, 3), REVIEW);
  d = await done(s);
  assert.equal(d.code, 0, show(d));
  // The state directory is not code: a Markdown review, a decision or any other file written there after verify is no
  // change of the code (the typed review record is read by value above), so task done closes without a second verify.
  const m = repo(t);
  assert.equal((await run(m)).code, 0);
  m.write(`${names.stateDir}/tasks/${m.id}/review-r1.md`, '**Approved**\n');
  m.write(`${names.stateDir}/decisions/D-TU-9.md`, '---\nschema: 1\n---\n');
  d = await done(m);
  assert.equal(d.code, 0, `state files are not code: ${show(d)}`);
  // A file outside the state directory is a change of the code.
  const o = repo(t);
  assert.equal((await run(o)).code, 0);
  o.write('notes.md', 'later\n');
  d = await done(o);
  assert.deepEqual([d.code, errorCodes(d)[0]], [1, 'uncommitted-changes'], show(d));
});

test('task merge merges a done task (done on its branch, then merged); a cancelled task stays refused', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0, 'the target verifies');
  rebase(r, 'baseline on the target');
  r.git('checkout', '-q', '-b', 'feat/x');
  r.write('calc.test.mjs', `${TESTS}test('feature', () => {});\n`);
  commitAll(r, 'feature');
  assert.equal((await run(r)).code, 0);
  assert.equal((await done(r)).code, 0);
  commitAll(r, 'done');
  r.git('checkout', '-q', 'main');
  const res = await cli(['task', 'merge', r.id, '--branch', 'feat/x', '--yes'], r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.merged, true);
  assert.equal(r.store.read('task', r.id).status, 'done');
  // T-MG-80 (intended change): the code is clean; the merge record is an uncommitted state write, like task done's.
  assert.equal(r.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '');
  assert.deepEqual(r.git('status', '--porcelain').split('\n').map((l) => l.replace(/^\s*\S+\s+/, '')), [`${names.stateDir}/tasks/${r.id}/task.json`]);
  assert.equal(r.store.read('task', r.id).events.at(-1).event, 'merged');
});

// ---- (2) baseline show | pin ----

test('baseline show prints the pinned inventory: none yet, then the tests verify pinned; an edited baseline is invalid', async (t) => {
  const r = repo(t);
  let res = await cli(['baseline', 'show'], r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.env.data.baseline, res.env.data.valid], [null, null]);
  assert.equal((await run(r)).code, 0);
  res = await cli(['baseline', 'show'], r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual(res.env.data.baseline.tests.map((x) => x.id), [N('adds'), N('subtracts')]);
  assert.deepEqual([res.env.data.baseline.collector, res.env.data.valid], ['node-test', true]);
  const text = await cli(['baseline', 'show'], { ...r, json: false });
  assert.match(text.text, /2 tests \(0 skipped\), 0 failing; collector node-test/);
  for (const id of [N('adds'), N('subtracts')]) assert.ok(text.text.includes(id), `${id} listed`);
  const doc = r.vstore.read('baseline', null);
  r.write(`${names.stateDir}/baseline/tests.json`, `${JSON.stringify({ ...doc, tests: doc.tests.slice(1) }, null, 2)}\n`);
  res = await cli(['baseline', 'show'], r);
  assert.deepEqual([res.code, errorCodes(res)[0], res.env.data.valid], [1, 'baseline-invalid', false], show(res));
  assert.equal((await cli(['baseline', 'show'], r)).env.data.baseline.tests.length, 1, 'show writes nothing');
});

test('baseline pin needs an active gate-change or test-removal decision; it writes the inventory collected now and records the decision', async (t) => {
  const r = repo(t);
  let res = await cli(['baseline', 'pin', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'missing-flag'], show(res));
  res = await cli(['baseline', 'pin', '--decision', 'nope', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'invalid-value'], show(res));
  res = await cli(['baseline', 'pin', '--decision', ['D', r.handle, 9].join('-'), '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'unknown-decision'], show(res));
  const general = (await decide(r)).env.data.id;
  res = await cli(['baseline', 'pin', '--decision', general, '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'decision-kind'], show(res));
  const retired = (await decide(r, '--kind', 'gate-change')).env.data.id;
  assert.equal((await cli(['decisions', 'retire', retired, '--yes'], r)).code, 0);
  res = await cli(['baseline', 'pin', '--decision', retired, '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'decision-not-active'], show(res));
  res = await cli(['baseline', 'pin', '--decision', general], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [7, 'consent-required'], show(res));
  assert.equal(r.vstore.read('baseline', null), null, 'nothing pinned by a refusal');

  const ok = (await decide(r, '--kind', 'gate-change')).env.data.id;
  res = await cli(['baseline', 'pin', '--decision', ok, '--yes'], r);
  assert.equal(res.code, 0, show(res));
  const doc = r.vstore.read('baseline', null);
  assert.deepEqual([doc.collector, doc.pinnedBy, doc.head, doc.sha256], ['node-test', ok, r.git('rev-parse', 'HEAD'), verify.baselineSha(doc)]);
  assert.deepEqual(doc.tests.map((x) => [x.id, x.skipped]), [[N('adds'), false], [N('subtracts'), false]]);
  assert.deepEqual([res.env.data.decision, res.env.data.baseline.tests.length, res.env.data.previous], [ok, 2, null]);
  // Verify keeps the decision of the last pin when the baseline grows (the pin committed at the task base).
  rebase(r, 'pin on the target');
  r.write('calc.test.mjs', `${TESTS}test('more', () => {});\n`);
  assert.equal((await run(r)).code, 0);
  assert.equal(r.vstore.read('baseline', null).pinnedBy, ok);
  const removal = (await decide(r, '--kind', 'test-removal')).env.data.id;
  assert.equal((await cli(['baseline', 'pin', '--decision', removal, '--yes'], r)).code, 0, 'test-removal decisions pin too');
});

test('baseline pin repairs after a collector change: verify refuses collector-changed until the target pins the new collector\'s inventory', async (t) => {
  const r = repo(t, { gates: [{ name: 'test', cmd: 'node -e 0', timeoutS: 60, kind: 'test' }] });
  let v = await run(r);
  assert.equal(v.code, 0, show(v));
  assert.equal(v.env.data.inventory.collector, 'generic');
  rebase(r, 'generic baseline');
  setGates(r, [NODE_TEST]);
  commitAll(r, 'structured reporter');
  v = await run(r);
  assert.deepEqual([v.code, errorCodes(v)], [1, ['collector-changed']], show(v));
  const d = (await decide(r, '--kind', 'gate-change')).env.data.id;
  const res = await cli(['baseline', 'pin', '--decision', d, '--yes'], r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.env.data.baseline.collector, res.env.data.previous.collector], ['node-test', 'generic']);
  rebase(r, 'pin the node-test baseline on the target');
  v = await run(r);
  assert.equal(v.code, 0, show(v));
  assert.deepEqual(v.env.data.inventory.removed, []);
});

test('baseline pin repairs a resolved tests.json conflict: a hand-merged or unparsable baseline becomes the current inventory', async (t) => {
  const r = repo(t);
  assert.equal((await run(r)).code, 0);
  const doc = r.vstore.read('baseline', null);
  r.write(`${names.stateDir}/baseline/tests.json`, `${JSON.stringify({ ...doc, tests: [...doc.tests, { id: N('theirs'), file: '', skipped: false }] }, null, 2)}\n`);
  let v = await run(r);
  assert.ok(errorCodes(v).includes('baseline-invalid'), show(v));
  const d = (await decide(r, '--kind', 'gate-change')).env.data.id;
  let res = await cli(['baseline', 'pin', '--decision', d, '--yes'], r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.previous.valid, false);
  v = await run(r);
  assert.equal(v.code, 0, show(v));
  r.write(`${names.stateDir}/baseline/tests.json`, '<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n');
  res = await cli(['baseline', 'pin', '--decision', d, '--yes'], r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.previous, null, 'an unparsable baseline is replaced');
  assert.equal(r.vstore.read('baseline', null).sha256, verify.baselineSha(r.vstore.read('baseline', null)));
});

test('baseline pin pins collected failures as pre-existing and refuses what it cannot pin: a crash, focused tests, a gate that cannot run', async (t) => {
  const failing = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => {});\ntest('broken', () => { assert.equal(1, 2); });\n";
  const r = repo(t, { files: { 'calc.test.mjs': failing }, gates: [{ ...NODE_TEST, cmd: 'node --test --test-reporter=tap' }] });
  const d = (await decide(r, '--kind', 'gate-change')).env.data.id;
  const pin = (x = r) => cli(['baseline', 'pin', '--decision', d, '--yes'], x);
  let res = await pin();
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.baseline.failing.length, 1);
  assert.ok(res.env.data.baseline.failing[0].startsWith(`${N('broken')}@`));
  rebase(r, 'pinned failure');
  const v = await run(r);
  assert.equal(v.code, 0, `the pinned failure is pre-existing: ${show(v)}`);
  assert.deepEqual(v.env.data.failures.new, []);

  const before = readFileSync(join(r.stateDir, 'baseline', 'tests.json'), 'utf8');
  // A failing gate whose report holds no failure: nothing collected says what failed.
  r.write('calc.test.mjs', TESTS);
  setGates(r, [{ ...NODE_TEST, cmd: 'node --test --test-reporter=tap; exit 3' }]);
  res = await pin();
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'gate-failed'], show(res));
  r.write('calc.test.mjs', "import { test } from 'node:test';\ntest.only('adds', () => {});\ntest('subtracts', () => {});\n");
  setGates(r, [{ ...NODE_TEST, cmd: 'node -e 0' }]);
  res = await pin();
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'focused'], show(res));
  setGates(r, [{ ...NODE_TEST, cmd: 'definitely-not-a-command-xyz' }]);
  res = await pin();
  assert.deepEqual([res.code, errorCodes(res)[0]], [8, 'gate-error'], show(res));
  setGates(r, []);
  res = await pin();
  assert.deepEqual([res.code, errorCodes(res)[0]], [1, 'no-gates'], show(res));
  assert.equal(readFileSync(join(r.stateDir, 'baseline', 'tests.json'), 'utf8'), before, 'a refused pin writes nothing');
});

// ---- (3) decide --allows-test-removal ----

test('decide --allows-test-removal records the test IDs (a JSON ID keeps its commas) with kind test-removal by default', async (t) => {
  const r = repo(t);
  let res = await decide(r, '--allows-test-removal', `${N('adds')},["", "subtracts", 1], #${'a'.repeat(64)}`);
  assert.equal(res.code, 0, show(res));
  const doc = recordOf(r, res.env.data.id);
  assert.deepEqual(doc.allowsTestRemoval, [N('adds'), N('subtracts'), `#${'a'.repeat(64)}`]);
  assert.equal(doc.kind, 'test-removal');
  assert.deepEqual(decisions.readRecords(r.stateDir).invalid, [], 'the record parses and validates');
  res = await decide(r, '--allows-test-removal', N('adds'), '--kind', 'general');
  assert.equal(recordOf(r, res.env.data.id).kind, 'general', 'an explicit kind stays');
  res = await decide(r);
  assert.deepEqual(recordOf(r, res.env.data.id).allowsTestRemoval, []);
  res = await decide(r, '--allows-test-removal', 'a​b');
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'invalid-value'], show(res));
  res = await decide(r, '--allows-test-removal', 'x'.repeat(301));
  assert.equal(res.code, 2, show(res));
  const help = await cli(['decide', '--help'], { ...r, json: false });
  assert.match(help.text, /--allows-test-removal <ids>/);
});

test('verify accepts exactly the removals a decision allows', async (t) => {
  const three = `${TESTS}test('multiplies', () => {});\n`;
  const r = repo(t, { files: { 'calc.test.mjs': three } });
  assert.equal((await run(r)).code, 0);
  rebase(r, 'baseline');
  const d = (await decide(r, '--allows-test-removal', N('adds'))).env.data.id;
  r.write('calc.test.mjs', "import { test } from 'node:test';\ntest('multiplies', () => {});\n");
  commitAll(r, 'drop two tests');
  let v = await run(r);
  assert.deepEqual([v.code, v.env.data.result], [1, 'baseline-shrunk'], show(v));
  assert.deepEqual(v.env.data.inventory.removed, [N('adds'), N('subtracts')]);
  assert.match(v.env.errors.find((e) => e.code === 'baseline-shrunk').message, /subtracts/);
  assert.doesNotMatch(v.env.errors.find((e) => e.code === 'baseline-shrunk').message, /adds/);
  r.write('calc.test.mjs', "import { test } from 'node:test';\ntest('subtracts', () => {});\ntest('multiplies', () => {});\n");
  commitAll(r, 'drop one test');
  v = await run(r);
  assert.equal(v.code, 0, show(v));
  assert.deepEqual([v.env.data.inventory.removed, v.env.data.inventory.allowedBy], [[N('adds')], [d]]);
});

// ---- (4) report template ----

// Fills the placeholders of the template's red and green lines with `evidence` ({ red, green }: command, exit, excerpt).
function fillReport(template, evidence) {
  return template.replace(/^(red|green): (.*)$/gm, (line, key, value) => {
    const e = evidence[key];
    const filled = value.replace(/"command": "<[^"]*>"/, `"command": ${JSON.stringify(e.command)}`)
      .replace(/"exit": <[^>]*>/, `"exit": ${e.exit}`).replace(/"excerpt": "<[^"]*>"/, `"excerpt": ${JSON.stringify(e.excerpt)}`);
    return `${key}: ${filled}`;
  });
}
const EVIDENCE = { red: { command: 'node --test', exit: 1, excerpt: 'not ok 2 - subtracts' }, green: { command: 'node --test', exit: 0, excerpt: '# pass 2' } };

test('the report template opens with red/green frontmatter: unfilled it is no evidence, filled it passes verify', async (t) => {
  assert.match(TEMPLATE, /^---\nred: \{.*\}\ngreen: \{.*\}\n---\n/);
  assert.equal(verify.reportHasEvidence(TEMPLATE), false, 'placeholders are not evidence');
  const filled = fillReport(TEMPLATE, EVIDENCE);
  const lines = filled.split('\n');
  assert.deepEqual([JSON.parse(lines[1].slice(5)), JSON.parse(lines[2].slice(7))], [EVIDENCE.red, EVIDENCE.green]);
  assert.equal(verify.reportHasEvidence(filled), true);
  assert.equal(verify.reportHasEvidence(fillReport(TEMPLATE, { ...EVIDENCE, red: { ...EVIDENCE.red, exit: 0 } })), false, 'red must fail');
  let r = repo(t, { report: TEMPLATE });
  let v = await run(r);
  assert.deepEqual([v.code, v.env.data.artifacts.report], [1, false], show(v));
  r = repo(t, { report: filled });
  v = await run(r);
  assert.deepEqual([v.code, v.env.data.artifacts.report], [0, true], show(v));
});

// ---- (5) the done-needs-verify hint ----

test('task set <id> done is refused with a hint that names task done <id>', async (t) => {
  const r = repo(t);
  const res = await cli(['task', 'set', r.id, 'done', '--yes'], r);
  assert.deepEqual([res.code, errorCodes(res)[0]], [2, 'done-needs-verify'], show(res));
  assert.match(res.env.errors[0].hint, new RegExp(`${names.bin} task done ${r.id}\\b`));
});

// ---- command rows ----

test('review record, baseline show and baseline pin are command rows; show is read-only', async (t) => {
  const row = (n) => COMMANDS.find((c) => c.name === n);
  for (const n of ['review record', 'baseline pin']) assert.equal(row(n)?.mutating, true, `${n}: changes files`);
  assert.ok(row('baseline show') && !row('baseline show').mutating, 'baseline show: read-only');
  assert.deepEqual(row('review record').flags.map((f) => f.flag), ['--from', '--kind', '--run']);
  assert.deepEqual(row('baseline pin').flags.map((f) => f.flag), ['--decision']);
  assert.ok(row('decide').flags.some((f) => f.flag === '--allows-test-removal'));
  const r = repo(t);
  const help = await cli(['--help'], { ...r, json: false });
  for (const n of ['review record', 'baseline show', 'baseline pin']) assert.match(help.text, new RegExp(`${n}\\s`));
});
