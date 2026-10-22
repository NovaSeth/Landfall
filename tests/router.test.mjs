// Task router (spec §7.5, SD-14, SD-15, RF2 task part): a deterministic classifier over the declared plan (paths,
// LOC estimate, risk flags) and risk globs gives trivial / standard / critical; each class has a route; the
// outcome-gate set is byte-identical for every class; inside a task the class only rises (ratchet); a downward
// change needs an override by the user with a quote and becomes a decision record (lib/state).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const router = await lib('router/index.mjs');
const state = await lib('state/index.mjs');
const decisions = await lib('decisions/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';

// ---- classifier table (spec §7.5, SD-14 thresholds: trivial <= 2 files and <= 30 LOC; critical > 15 files,
// > 400 LOC, a risk flag or a risk path) ----

const many = (n, dir = 'src') => Array.from({ length: n }, (_, i) => `${dir}/f${i}.js`);
const codes = (r) => r.reasons.map((x) => x.code);

// [label, input, class, reason codes in order]
const TABLE = [
  // sizes
  ['one file, one line', { paths: ['src/a.js'], loc: 1 }, 'trivial', ['small']],
  ['nothing changed in lines (docs rename)', { paths: ['README.md'], loc: 0 }, 'trivial', ['small']],
  ['2 files and 30 LOC: both at the trivial limit', { paths: many(2), loc: 30 }, 'trivial', ['small']],
  ['3 files', { paths: many(3), loc: 3 }, 'standard', ['files-over-trivial']],
  ['31 LOC', { paths: many(1), loc: 31 }, 'standard', ['loc-over-trivial']],
  ['3 files and 31 LOC', { paths: many(3), loc: 31 }, 'standard', ['files-over-trivial', 'loc-over-trivial']],
  ['new dependency on a one-line change', { paths: ['package.json'], loc: 1, flags: ['new-dependency'] }, 'standard', ['flag']],
  ['15 files and 400 LOC: both at the critical limit', { paths: many(15), loc: 400 }, 'standard', ['files-over-trivial', 'loc-over-trivial']],
  ['16 files', { paths: many(16), loc: 16 }, 'critical', ['files-over']],
  ['401 LOC', { paths: many(1), loc: 401 }, 'critical', ['loc-over']],
  ['16 files and 401 LOC', { paths: many(16), loc: 401 }, 'critical', ['files-over', 'loc-over']],
  // risk flags (one tiny file each)
  ...['migration', 'public-api', 'security', 'data-write', 'irreversible'].map((f) => [`flag ${f}`, { paths: ['src/a.js'], loc: 1, flags: [f] }, 'critical', ['risk-flag']]),
  // risk paths: the default globs (auth, payments, migrations, security, CI workflows, SQL data writes)
  ['auth directory', { paths: ['src/auth/session.js'], loc: 2 }, 'critical', ['risk-path']],
  ['auth at the root', { paths: ['auth/login.js'], loc: 2 }, 'critical', ['risk-path']],
  ['auth directory itself', { paths: ['services/auth'], loc: 2 }, 'critical', ['risk-path']],
  ['payments', { paths: ['src/payments/charge.js'], loc: 2 }, 'critical', ['risk-path']],
  ['migrations', { paths: ['db/migrations/0001_init.js'], loc: 2 }, 'critical', ['risk-path']],
  ['data write: SQL file', { paths: ['db/schema.sql'], loc: 2 }, 'critical', ['risk-path']],
  ['data write: SQL file, upper-case extension', { paths: ['queries/Update_Users.SQL'], loc: 2 }, 'critical', ['risk-path']],
  ['security', { paths: ['lib/security/csp.js'], loc: 2 }, 'critical', ['risk-path']],
  ['CI workflow', { paths: ['.github/workflows/ci.yml'], loc: 2 }, 'critical', ['risk-path']],
  ['risk path, upper-case directory', { paths: ['src/Auth/session.js'], loc: 2 }, 'critical', ['risk-path']],
  ['risk path given as ./path', { paths: ['./src/auth/session.js'], loc: 2 }, 'critical', ['risk-path']],
  // findings-r1 #6: a backslash is part of a file name on POSIX, never a separator
  ['a backslash is a file-name character: one file in the root', { paths: ['src\\auth\\session.js'], loc: 2 }, 'trivial', ['small']],
  ['auth\\x.js is a file in the root', { paths: ['auth\\x.js'], loc: 2 }, 'trivial', ['small']],
  ['auth/x.js is inside auth', { paths: ['auth/x.js'], loc: 2 }, 'critical', ['risk-path']],
  ['..\\safe.js is a file inside auth, not a way out of it', { paths: ['auth/..\\safe.js'], loc: 2 }, 'critical', ['risk-path']],
  ['risk path reached through ..', { paths: ['src/../auth/session.js'], loc: 2 }, 'critical', ['risk-path']],
  // look-alikes are not risk paths: a glob segment matches a whole path segment
  ['authors is not auth', { paths: ['src/authors/list.js'], loc: 2 }, 'trivial', ['small']],
  ['oauth is not auth (a glob directory is a whole segment)', { paths: ['src/oauth/callback.js'], loc: 2 }, 'trivial', ['small']],
  ['a guide about migrations is not a migration', { paths: ['docs/migration-guide.md'], loc: 2 }, 'trivial', ['small']],
  ['sqlite.js is not SQL', { paths: ['src/sqlite.js'], loc: 2 }, 'trivial', ['small']],
  ['.github outside workflows', { paths: ['.github/CODEOWNERS'], loc: 2 }, 'trivial', ['small']],
  // docs and binaries are weightless (retro 2026-10 §3.6): size never raises them above standard; risk globs and flags still do
  ['a manual of 2,100 lines in 12 files is docs-only: standard', { paths: many(12, 'docs/manual/pl').map((p) => p.replace('.js', '.md')), loc: 2100 }, 'standard', ['docs-only']],
  ['35 screenshots are docs-only: standard', { paths: many(35, 'docs/qa').map((p) => p.replace('.js', '.png')), loc: 0 }, 'standard', ['docs-only']],
  ['one README line stays trivial', { paths: ['README.md'], loc: 5 }, 'trivial', ['small']],
  ['a docs file under a risk glob is still critical', { paths: ['src/auth/README.md', 'docs/a.md', 'docs/b.md'], loc: 900 }, 'critical', ['risk-path']],
  ['a flag on docs is still a flag', { paths: ['docs/a.md', 'docs/b.md', 'docs/c.md'], loc: 900, flags: ['new-dependency'] }, 'standard', ['docs-only', 'flag']],
  ['16 code files plus 20 images: the images weigh nothing (16 files > 15 by the code alone)', { paths: [...many(16), ...many(20, 'assets').map((p) => p.replace('.js', '.png'))], loc: 100 }, 'critical', ['files-over']],
  ['15 code files plus 20 images: standard, not critical', { paths: [...many(15), ...many(20, 'assets').map((p) => p.replace('.js', '.png'))], loc: 100 }, 'standard', ['files-over-trivial', 'loc-over-trivial']],
  // every reason is listed, critical ones first
  ['risk path, risk flag and size together', { paths: ['src/auth/a.js', ...many(16)], loc: 500, flags: ['migration', 'new-dependency'] }, 'critical', ['risk-path', 'risk-flag', 'files-over', 'loc-over']],
  // duplicate paths count once
  ['the same file three times is one file', { paths: ['a.js', './a.js', 'x/../a.js'], loc: 3 }, 'trivial', ['small']],
];

for (const [label, input, cls, expected] of TABLE) {
  test(`classifier: ${label} → ${cls}`, () => {
    const r = router.classify(input);
    assert.equal(r.class, cls, JSON.stringify(r.reasons));
    assert.deepEqual(codes(r), expected);
    for (const reason of r.reasons) assert.ok(typeof reason.text === 'string' && reason.text.length > 0 && reason.text.length <= 200, `reason text: ${reason.text}`);
  });
}

test('classifier: a risk-path reason names the path and the glob it matched', () => {
  const r = router.classify({ paths: ['src/a.js', 'src/auth/x.js', 'db/migrations/1.sql'], loc: 5 });
  assert.deepEqual(r.reasons.map((x) => [x.code, x.path]), [['risk-path', 'src/auth/x.js'], ['risk-path', 'db/migrations/1.sql']]);
  assert.match(r.reasons[0].text, /\*\*\/auth\/\*\*/);
  assert.match(r.reasons[1].text, /\*\*\/migrations\/\*\*/, 'the first matching glob is named');
});

test('classifier: risk globs from the profile add to the defaults (public API dirs, single-name globs)', () => {
  const riskPaths = ['lib/public/**', 'index.d.ts', 'api/v?/**'];
  const at = (paths) => router.classify({ paths, loc: 2, riskPaths });
  assert.equal(at(['lib/public/client.js']).class, 'critical', 'public API directory');
  assert.equal(at(['types/index.d.ts']).class, 'critical', 'a glob without a slash matches the name at any depth');
  assert.equal(at(['api/v2/users.js']).class, 'critical', '? matches one character');
  assert.equal(at(['api/v10/users.js']).class, 'trivial', '? matches exactly one character');
  assert.equal(at(['src/lib/public/client.js']).class, 'trivial', 'a glob with a slash is anchored at the repository root');
  assert.equal(at(['src/auth/session.js']).class, 'critical', 'the defaults still apply (findings-r1 #1: profile globs are additions)');
  assert.equal(router.classify({ paths: ['src/auth/session.js'], loc: 2, riskPaths: [] }).class, 'critical', 'an empty profile list keeps the defaults');
});

test('classifier: thresholds and default risk globs are data with the spec values', () => {
  const data = JSON.parse(readFileSync(join(pluginDir, 'lib', 'router', 'thresholds.json'), 'utf8'));
  assert.deepEqual(data.trivial, { maxFiles: 2, maxLoc: 30 });
  assert.deepEqual(data.critical, { overFiles: 15, overLoc: 400 });
  assert.deepEqual(data.criticalFlags, ['migration', 'public-api', 'security', 'data-write', 'irreversible']);
  assert.deepEqual(data.flags, [...data.criticalFlags, 'new-dependency']);
  assert.deepEqual(data.riskPaths, ['**/auth/**', '**/payment*/**', '**/migrations/**', '**/security/**', '.github/workflows/**', '**/*.sql']);
  assert.deepEqual(router.THRESHOLDS, data, 'the router reads exactly this file');
});

test('classifier: invalid input is a usage error (exit name USAGE), never a guess', () => {
  const bad = [
    ['no paths', { paths: [], loc: 1 }],
    ['an empty path', { paths: [''], loc: 1 }],
    ['a path that normalizes to nothing', { paths: ['./'], loc: 1 }],
    ['negative LOC', { paths: ['a.js'], loc: -1 }],
    ['fractional LOC', { paths: ['a.js'], loc: 1.5 }],
    ['LOC as text', { paths: ['a.js'], loc: '12' }],
    ['unknown flag', { paths: ['a.js'], loc: 1, flags: ['risky'] }],
    ['too many paths', { paths: many(10001), loc: 1 }],
    ['a path over the limit', { paths: [`${'a/'.repeat(2100)}x.js`], loc: 1 }],
  ];
  // findings-r1 #5: line terminators and control characters are refused, never matched loosely.
  for (const bad of ['auth/session\n.js', 'auth/session\u2028.js', 'auth/session\u2029.js', 'auth/session\r.js', 'auth/\u0000x.js', 'auth/\u001b[0mx.js', 'auth/x\u0085.js', 'au\u200bth/x.js', 'auth/\u202ex.js']) {
    assert.throws(() => router.classify({ paths: ['src/ok.js', bad], loc: 1 }), (e) => e.exit === 'USAGE' && e.code === 'invalid-path', JSON.stringify(bad));
  }
  assert.throws(() => router.classify({ paths: ['a.js'], loc: 1, riskPaths: ['auth/\n**'] }), (e) => e.exit === 'USAGE' && e.code === 'invalid-risk-paths');
  for (const [label, input] of bad) {
    assert.throws(() => router.classify(input), (e) => e.exit === 'USAGE' && /^[a-z]+(-[a-z]+)*$/.test(e.code), label);
  }
});

// findings-r1 #4: no regular expression, no backtracking. CPU time, not wall time, so a loaded machine does not
// fail it; the regex compiler took 1,840 ms for one of these paths and over 3 s for 10k.
const cpuMs = (fn) => { const s = process.cpuUsage(); fn(); const d = process.cpuUsage(s); return (d.user + d.system) / 1000; };
test('glob matching: the review\'s adversarial glob and 10k paths stay within a CPU budget', () => {
  const glob = '*a'.repeat(10) + 'b';
  const one = cpuMs(() => assert.equal(router.classify({ paths: [`${'a'.repeat(30)}c`], loc: 1, riskPaths: [glob] }).class, 'trivial'));
  assert.ok(one < 50, `one adversarial path: ${one} ms CPU`);
  assert.equal(router.classify({ paths: [`${'a'.repeat(30)}b`], loc: 1, riskPaths: [glob] }).class, 'critical', 'and it still matches');
  const long = cpuMs(() => router.classify({ paths: [`${'a'.repeat(4000)}c`], loc: 1, riskPaths: [glob, '**/*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b/**'] }));
  assert.ok(long < 50, `one 4,000-character path: ${long} ms CPU`);
  const paths = Array.from({ length: 10000 }, (_, i) => `${'a/'.repeat(i % 7)}${'a'.repeat(20 + (i % 60))}c${i}`);
  const globs = [glob, '**/' + '*a'.repeat(10) + 'b/**', '**/a/**/a/**/a/**/b', ...Array.from({ length: 40 }, (_, k) => `**/${'*a'.repeat(3)}${k}x/**`)];
  let out;
  const many = cpuMs(() => { out = router.classify({ paths, loc: 1, riskPaths: globs }); });
  assert.equal(out.class, 'critical', 'over 15 files');
  assert.ok(!out.reasons.some((x) => x.code === 'risk-path'), 'no adversarial path matches');
  assert.ok(many < 3000, `10k adversarial paths x ${globs.length + router.DEFAULT_RISK_PATHS.length} globs: ${many} ms CPU`);
});

// The matcher keeps the glob semantics: compared with a reference regular expression over every small glob and path.
function referenceRegExp(glob) {
  let g = glob.replace(/^(?:\.\/)+/, '');
  const dirOnly = g.length > 1 && g.endsWith('/');
  if (dirOnly) g = g.replace(/\/+$/, '');
  const anchored = g.includes('/');
  let re = '';
  if (g === '**') re = '[^]*';
  else {
    for (let i = 0; i < g.length;) {
      if (g.startsWith('**/', i) && (i === 0 || g[i - 1] === '/')) { re += '(?:[^]*/)?'; i += 3; continue; }
      if (g.startsWith('/**', i) && i + 3 === g.length) { re += '(?:/[^]*)?'; i += 3; continue; }
      const c = g[i];
      if (c === '*') { re += '[^/]*'; while (g[i] === '*') i++; continue; }
      if (c === '?') { re += '[^/]'; i++; continue; }
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
      i++;
    }
  }
  if (dirOnly) re += '(?:/[^]*)?';
  return new RegExp(`^${anchored ? '' : '(?:[^]*/)?'}${re}$`, 'i');
}
test('glob matching: same answers as the reference semantics for every small glob and path', () => {
  const globParts = ['a', 'B', '*', '?', '/', '**', '.'];
  const pathParts = ['a', 'b', 'A', '/', '.', 'ab'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const glob = Array.from({ length: 1 + rnd(6) }, () => globParts[rnd(globParts.length)]).join('');
    const path = router.normalizePath(Array.from({ length: 1 + rnd(7) }, () => pathParts[rnd(pathParts.length)]).join(''));
    if (path === '' || path.startsWith('/') || path.startsWith('../') || path === '..') continue;
    assert.equal(router.globMatch(glob, path), referenceRegExp(glob).test(path), `${JSON.stringify(glob)} vs ${JSON.stringify(path)}`);
    checked++;
  }
  assert.ok(checked > 3000, `checked ${checked}`);
});

test('router sources hold no literal control, zero-width or bidirectional character (escapes only)', () => {
  const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/u;
  const dir = join(pluginDir, 'lib', 'router');
  const files = [...readdirSync(dir).map((f) => join(dir, f)), fileURLToPath(import.meta.url)];
  assert.ok(files.length >= 8);
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => assert.ok(!unsafe.test(line), `${f}:${i + 1} holds a literal invisible character; write it as a \\u escape`));
  }
});

// ---- routes and outcome gates (spec §7.5 routes, SD-15) ----

const SD15_GATES = ['profile-gates-pass', 'test-baseline-kept', 'report-red-green', 'state-valid'];
const FLAG_SETS = [[], ['new-dependency'], ['irreversible'], ['migration', 'irreversible'], ['public-api', 'security', 'data-write', 'irreversible', 'new-dependency']];

test('routes: each class has its own steps; the decision record is a step only for an irreversible critical change', () => {
  assert.deepEqual(router.CLASSES, ['trivial', 'standard', 'critical']);
  assert.deepEqual(router.routeFor('trivial').steps, ['implement', 'verify', 'done']);
  assert.deepEqual(router.routeFor('standard').steps, ['plan-in-brief', 'implement', 'verify', 'review', 'done']);
  assert.deepEqual(router.routeFor('critical').steps, ['spec-plan', 'implement', 'verify', 'cross-provider-review', 'rereview', 'done']);
  assert.deepEqual(router.routeFor('critical', { flags: ['irreversible'] }).steps, ['spec-plan', 'implement', 'verify', 'cross-provider-review', 'rereview', 'decision-record', 'done']);
  assert.deepEqual(router.routeFor('standard', { flags: ['irreversible'] }).steps, router.routeFor('standard').steps, 'only the critical route records a decision');
  assert.throws(() => router.routeFor('huge'), (e) => e.exit === 'USAGE');
});

test('routes: the steps a higher class adds (what verify lists on escalation)', () => {
  assert.deepEqual(router.addedSteps('trivial', 'standard'), ['plan-in-brief', 'review']);
  assert.deepEqual(router.addedSteps('standard', 'critical'), ['spec-plan', 'cross-provider-review', 'rereview']);
  assert.deepEqual(router.addedSteps('trivial', 'critical', { flags: ['irreversible'] }), ['spec-plan', 'cross-provider-review', 'rereview', 'decision-record']);
  assert.deepEqual(router.addedSteps('critical', 'trivial'), [], 'a lower class adds nothing');
  assert.deepEqual(router.addedSteps(null, 'trivial'), ['implement', 'verify', 'done'], 'no class yet: every step is new');
});

test('outcome gates: byte-identical for every class and every flag set, and exactly the SD-15 set', () => {
  assert.deepEqual([...router.OUTCOME_GATES], SD15_GATES);
  const seen = new Set();
  const steps = new Set();
  for (const cls of router.CLASSES) {
    for (const flags of FLAG_SETS) {
      const route = router.routeFor(cls, { flags });
      seen.add(JSON.stringify(route.gates));
      steps.add(JSON.stringify(route.steps));
    }
  }
  assert.deepEqual([...seen], [JSON.stringify(SD15_GATES)], 'one gate set for every class');
  assert.ok(steps.size >= 4, 'not vacuous: the routes themselves differ by class');
  // A caller cannot weaken the shared set through a returned route.
  const r = router.routeFor('trivial');
  assert.throws(() => { r.gates.pop(); });
  assert.deepEqual(router.routeFor('trivial').gates, SD15_GATES);
});

// ---- ratchet and overrides through lib/state (spec §7.5 ratchet, SD-14 override, §5.1 task.json class fields) ----

// A throwaway git repository; active: a store with state.json and the handle of the repository's git identity.
function repo(t, { active = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'router-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(dir);
  mkdirSync(home);
  const env = { ...ISO.env, HOME: home };
  const git = (...a) => assert.equal(spawnSync('git', a, { cwd: dir, env }).status, 0, `git ${a.join(' ')}`);
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  const stateDir = join(dir, names.stateDir);
  let store = null;
  let handle = null;
  if (active) {
    store = state.open(stateDir, { names });
    store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
    handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  }
  return { base, dir, home, env, stateDir, store, handle };
}
const newTask = (store, owner, title = 'a task') => state.allocateId(store, {
  prefix: 'T', handle: owner, build: (id) => ({ id, kind: 'task', title, lane: null, owner, class: null, classHistory: [], status: 'new', round: 0, events: [], base: null, branch: null }),
});
const taskText = (r, id) => readFileSync(join(r.stateDir, 'tasks', id, 'task.json'), 'utf8');
const decisionsDir = (r) => join(r.stateDir, 'decisions');
const QUOTE = 'Keep it light: this auth change only renames a log message.';

test('ratchet: the first classification sets the class; a higher one escalates; a lower or equal one writes nothing', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const go = (plan) => router.routeTask(r.store, id, { ...plan, handle: r.handle, at: AT });

  const first = go({ paths: ['src/a.js'], loc: 5 });
  assert.deepEqual([first.outcome, first.class, first.previous, first.escalated], ['classified', 'trivial', null, false]);
  assert.deepEqual(first.route.steps, ['implement', 'verify', 'done']);
  let doc = r.store.read('task', id);
  assert.equal(doc.class, 'trivial');
  assert.equal(doc.classHistory.length, 1);
  assert.equal(doc.classHistory[0].class, 'trivial');
  assert.match(doc.classHistory[0].reason, /^trivial: /);
  assert.equal(doc.classHistory[0].at, AT);

  const up = go({ paths: ['src/a.js'], loc: 50 });
  assert.deepEqual([up.outcome, up.class, up.computed, up.previous, up.escalated], ['escalated', 'standard', 'standard', 'trivial', true]);
  assert.deepEqual(up.addedSteps, ['plan-in-brief', 'review']);

  const before = taskText(r, id);
  const down = go({ paths: ['src/a.js'], loc: 5 });
  assert.deepEqual([down.outcome, down.class, down.computed, down.escalated], ['held', 'standard', 'trivial', false], 'the class never falls');
  assert.deepEqual(down.addedSteps, []);
  assert.equal(taskText(r, id), before, 'a lower class writes nothing');
  const same = go({ paths: ['src/b.js'], loc: 40 });
  assert.deepEqual([same.outcome, same.class], ['unchanged', 'standard']);
  assert.equal(taskText(r, id), before, 'an equal class writes nothing');

  const crit = go({ paths: ['src/a.js'], loc: 5, flags: ['migration'] });
  assert.deepEqual([crit.outcome, crit.class, crit.previous], ['escalated', 'critical', 'standard']);
  assert.deepEqual(crit.addedSteps, ['spec-plan', 'cross-provider-review', 'rereview']);
  doc = r.store.read('task', id);
  assert.deepEqual(doc.classHistory.map((h) => h.class), ['trivial', 'standard', 'critical']);
  assert.match(doc.classHistory[2].reason, /^critical: flag migration$/);
  for (const h of doc.classHistory) assert.ok(h.reason.length <= 200);
});

test('ratchet: over random plans the stored class is the running maximum and history only rises', (t) => {
  const r = repo(t);
  let seed = 20261015;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const plain = ['src/a.js', 'src/b.js', 'lib/d.js', 'docs/f.md'];
  const risky = ['src/auth/c.js', 'db/e.sql'];
  const seen = new Set();
  for (let task = 0; task < 5; task++) {
    const id = newTask(r.store, r.handle);
    let expected = null;
    for (let i = 0; i < 30; i++) {
      const paths = Array.from({ length: 1 + rnd(4) }, () => (rnd(25) === 0 ? risky[rnd(2)] : plain[rnd(4)]));
      const plan = { paths, loc: rnd(6) === 0 ? 30 + rnd(500) : rnd(31), flags: rnd(10) === 0 ? ['new-dependency'] : [] };
      const out = router.routeTask(r.store, id, { ...plan, handle: r.handle, at: AT });
      seen.add(out.computed);
      expected = router.higher(expected, out.computed);
      assert.equal(out.class, expected, `task ${task} step ${i}`);
      assert.equal(r.store.read('task', id).class, expected, `stored, task ${task} step ${i}`);
    }
    const ranks = r.store.read('task', id).classHistory.map((h) => router.rank(h.class));
    assert.ok(ranks.every((v, k) => k === 0 || v > ranks[k - 1]), `history strictly rises: ${ranks}`);
  }
  assert.equal(seen.size, 3, `not vacuous: every class was computed (${[...seen]})`);
});

test('override: lowering needs the user and a quote, and becomes a route-override decision record', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  router.routeTask(r.store, id, { paths: ['src/auth/session.js'], loc: 3, handle: r.handle, at: AT });
  const before = taskText(r, id);
  const ov = (opts) => router.overrideTask(r.store, id, { to: 'standard', by: 'user', quote: QUOTE, handle: r.handle, at: AT, ...opts });

  for (const [label, opts, code] of [
    ['by an agent', { by: 'agent' }, 'invalid-by'],
    ['by nobody', { by: undefined }, 'invalid-by'],
    ['no quote', { quote: undefined }, 'invalid-quote'],
    ['a blank quote', { quote: '  \n ' }, 'invalid-quote'],
    ['a quote over 300 characters', { quote: 'x'.repeat(301) }, 'invalid-quote'],
    ['a quote with a bidi control', { quote: 'fine \u202e enif' }, 'invalid-quote'],
    ['a quote with a zero-width space', { quote: 'fine\u200b' }, 'invalid-quote'],
    ['a quote with an escape character', { quote: 'fine \u001b[31m' }, 'invalid-quote'],
    ['an unknown class', { to: 'tiny' }, 'invalid-class'],
  ]) {
    assert.throws(() => ov(opts), (e) => e.exit === 'USAGE' && e.code === code, label);
  }
  assert.equal(taskText(r, id), before, 'a refused override writes nothing');
  assert.ok(!existsSync(decisionsDir(r)), 'and records no decision');

  const out = ov({});
  assert.deepEqual([out.outcome, out.class, out.previous, out.decision, out.escalated], ['overridden', 'standard', 'critical', `D-${r.handle}-1`, false]);
  assert.deepEqual(out.route.steps, router.routeFor('standard').steps);
  const doc = r.store.read('task', id);
  assert.equal(doc.class, 'standard');
  assert.deepEqual(doc.classHistory.at(-1), { class: 'standard', reason: `override from critical to standard by user, decision D-${r.handle}-1`, at: AT });

  const text = readFileSync(join(decisionsDir(r), `D-${r.handle}-1.md`), 'utf8');
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
  assert.ok(front, `frontmatter block:\n${text}`);
  const fields = Object.fromEntries(front.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  assert.deepEqual(fields, {
    schema: '1', id: `D-${r.handle}-1`, title: `Route override of ${id} from critical to standard`, status: 'active', kind: 'route-override',
    date: '2026-10-15', author: r.handle, by: 'user', task: id, from: 'critical', to: 'standard', supersedes: '[]', scope: '[]',
  });
  assert.deepEqual(body.match(/^## .+$/gm), ['## What', '## Why', '## Cost if wrong', '## Alternatives']);
  assert.ok(body.includes(`> ${QUOTE}\n`), 'the user words, verbatim, as a quote');
  assert.match(body, /spec-plan, cross-provider-review, rereview/, 'the cost names the skipped steps');

  // The same plan again: the class the user waived does not come back.
  const again = router.routeTask(r.store, id, { paths: ['src/auth/session.js'], loc: 3, handle: r.handle, at: AT });
  assert.deepEqual([again.outcome, again.class, again.computed], ['held', 'standard', 'critical']);
});

test('override: the waiver covers the reasons recorded before it; a new reason escalates again', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const go = (plan) => router.routeTask(r.store, id, { ...plan, handle: r.handle, at: AT });
  go({ paths: ['src/a.js'], loc: 50 });
  const ov = router.overrideTask(r.store, id, { to: 'trivial', by: 'user', quote: 'It is a typo fix in a long file.', handle: r.handle, at: AT });
  assert.deepEqual([ov.outcome, ov.class, ov.previous], ['overridden', 'trivial', 'standard']);
  assert.equal(go({ paths: ['src/a.js'], loc: 50 }).outcome, 'held', 'the waived reason (LOC over the trivial limit) is held');
  const up = go({ paths: ['src/a.js'], loc: 50, flags: ['migration'] });
  assert.deepEqual([up.outcome, up.class, up.previous], ['escalated', 'critical', 'trivial'], 'a new reason escalates');
  assert.deepEqual(readdirSync(decisionsDir(r)).sort(), [`D-${r.handle}-1.md`]);
});

test('override: a waiver never covers an unrelated later risk (findings-r1 #2, the review reproduction)', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const go = (plan) => router.routeTask(r.store, id, { ...plan, handle: r.handle, at: AT });
  // generated code (docs would be weightless since 2.1): 401 lines are critical by size until the user waives it
  assert.equal(go({ paths: ['src/generated/api.js'], loc: 401 }).class, 'critical');
  router.overrideTask(r.store, id, { to: 'trivial', by: 'user', quote: 'Only generated code changed; skip the critical review for that', handle: r.handle, at: AT });
  const docs = go({ paths: ['src/generated/api.js'], loc: 401 });
  assert.deepEqual([docs.outcome, docs.class], ['held', 'trivial'], 'the waived plan stays waived');
  const risky = go({ paths: ['auth/delete-users.sql'], loc: 1000, flags: ['security', 'data-write', 'irreversible'] });
  assert.deepEqual([risky.outcome, risky.class, risky.computed, risky.escalated], ['escalated', 'critical', 'critical', true]);
  assert.ok(risky.route.steps.includes('decision-record'));
  // A new risk path alone (no flag, small) escalates too.
  const r2 = repo(t);
  const id2 = newTask(r2.store, r2.handle);
  router.routeTask(r2.store, id2, { paths: ['src/auth/session.js'], loc: 3, handle: r2.handle, at: AT });
  router.overrideTask(r2.store, id2, { to: 'standard', by: 'user', quote: QUOTE, handle: r2.handle, at: AT });
  const again = router.routeTask(r2.store, id2, { paths: ['src/auth/session.js'], loc: 3, handle: r2.handle, at: AT });
  assert.equal(again.outcome, 'held');
  const other = router.routeTask(r2.store, id2, { paths: ['src/auth/session.js', 'src/auth/tokens.js'], loc: 3, handle: r2.handle, at: AT });
  assert.deepEqual([other.outcome, other.class], ['escalated', 'critical'], 'another risky path is outside the waived set');
  assert.deepEqual(other.reasons.map((x) => x.path), ['src/auth/tokens.js'], 'the history names the unwaived reason');
});

test('override: every override waives the reasons recorded before it; later reasons are not waived', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const go = (plan) => router.routeTask(r.store, id, { ...plan, handle: r.handle, at: AT });
  const ov = (to) => router.overrideTask(r.store, id, { to, by: 'user', quote: 'The migration is a no-op rename.', handle: r.handle, at: AT });
  go({ paths: ['src/a.js'], loc: 5, flags: ['migration'] });
  assert.deepEqual([ov('standard').previous, ov('trivial').previous], ['critical', 'standard']);
  const same = go({ paths: ['src/a.js'], loc: 5, flags: ['migration'] });
  assert.deepEqual([same.outcome, same.class], ['held', 'trivial'], 'the migration flag was waived');
  const bigger = go({ paths: ['src/a.js'], loc: 50 });
  assert.deepEqual([bigger.outcome, bigger.class], ['escalated', 'standard'], 'LOC over the trivial limit was never recorded, so never waived');
  assert.deepEqual(readdirSync(decisionsDir(r)).sort(), [`D-${r.handle}-1.md`, `D-${r.handle}-2.md`]);
});

test('override: a route-override event without its decision in classHistory waives nothing', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 50, handle: r.handle, at: AT });
  router.overrideTask(r.store, id, { to: 'trivial', by: 'user', quote: QUOTE, handle: r.handle, at: AT });
  // Another command appends a forged override event after a new reason was recorded (held? no: it escalated).
  r.store.update('task', id, (c) => ({ ...c, class: 'trivial', events: [...c.events, { at: AT, by: r.handle, event: 'route', data: { computed: 'critical', keys: ['risk-flag:migration'] } }, { at: AT, by: r.handle, event: 'route-override', data: { decision: 'D-ZZ-9', from: 'critical', to: 'trivial' } }] }));
  const out = router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 5, flags: ['migration'], handle: r.handle, at: AT });
  assert.deepEqual([out.outcome, out.class], ['escalated', 'critical'], 'only overrides confirmed by classHistory count');
});

test('override: raising needs no decision; the same class changes nothing; an unclassified task has nothing to lower', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const ov = (to) => router.overrideTask(r.store, id, { to, by: 'user', quote: 'Treat this one with care.', handle: r.handle, at: AT });
  const before = taskText(r, id);
  assert.throws(() => ov('trivial'), (e) => e.exit === 'FAIL' && e.code === 'not-classified');
  assert.equal(taskText(r, id), before);
  router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 1, handle: r.handle, at: AT });
  const raised = ov('critical');
  assert.deepEqual([raised.outcome, raised.class, raised.previous, raised.decision, raised.escalated], ['raised', 'critical', 'trivial', null, true]);
  assert.deepEqual(raised.addedSteps, ['spec-plan', 'cross-provider-review', 'rereview']);
  assert.deepEqual(r.store.read('task', id).classHistory.at(-1), { class: 'critical', reason: 'raised from trivial by user', at: AT });
  const mid = taskText(r, id);
  assert.deepEqual([ov('critical').outcome, taskText(r, id)], ['unchanged', mid]);
  assert.ok(!existsSync(decisionsDir(r)), 'no decision for a raise');
});

test('route steps: a flag seen once stays (findings-r1 #3): irreversible keeps the decision record', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const go = (plan) => router.routeTask(r.store, id, { ...plan, handle: r.handle, at: AT });
  assert.ok(go({ paths: ['src/change.js'], loc: 1, flags: ['irreversible'] }).route.steps.includes('decision-record'));
  const before = taskText(r, id);
  const plain = go({ paths: ['src/change.js'], loc: 1 });
  assert.deepEqual([plain.outcome, plain.class], ['held', 'critical']);
  assert.ok(plain.route.steps.includes('decision-record'), 'the irreversible flag recorded earlier still counts');
  assert.equal(taskText(r, id), before, 'nothing new: nothing written');
  const same = router.overrideTask(r.store, id, { to: 'critical', by: 'user', quote: QUOTE, handle: r.handle, at: AT });
  assert.deepEqual([same.outcome, same.route.steps.includes('decision-record')], ['unchanged', true]);
  // Flags recorded while the class was lower count once it rises.
  const id2 = newTask(r.store, r.handle);
  router.routeTask(r.store, id2, { paths: ['src/a.js'], loc: 1, flags: ['new-dependency'], handle: r.handle, at: AT });
  router.routeTask(r.store, id2, { paths: ['src/a.js'], loc: 1, flags: ['irreversible'], handle: r.handle, at: AT });
  const up = router.routeTask(r.store, id2, { paths: ['src/a.js'], loc: 500, handle: r.handle, at: AT });
  assert.ok(up.route.steps.includes('decision-record'));
});

test('override: a multi-line quote stays a quote inside Why and cannot add frontmatter or sections', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 500, handle: r.handle, at: AT });
  const quote = 'line one\r\n---\nstatus: retired\n## What\n\nline five';
  const out = router.overrideTask(r.store, id, { to: 'standard', by: 'user', quote, handle: r.handle, at: AT });
  const text = readFileSync(join(decisionsDir(r), `${out.decision}.md`), 'utf8');
  assert.equal(text.match(/^---$/gm).length, 2, 'only the frontmatter delimiters');
  assert.equal(text.match(/^status: /gm).length, 1);
  assert.deepEqual(text.match(/^## .+$/gm), ['## What', '## Why', '## Cost if wrong', '## Alternatives']);
  assert.ok(text.includes('> line one\n> ---\n> status: retired\n> ## What\n>\n> line five\n'), text);
});

test('owner only: another developer\'s task is refused and nothing is written; unknown or malformed IDs are usage errors', (t) => {
  const r = repo(t);
  const other = state.registerHandle(r.store, { name: 'Xavier Young', email: 'xy@example.com', at: AT }).handle;
  const id = newTask(r.store, other);
  const before = taskText(r, id);
  assert.throws(() => router.routeTask(r.store, id, { paths: ['a.js'], loc: 1, handle: r.handle, at: AT }), (e) => e.exit === 'REFUSED' && e.code === 'not-owner');
  router.routeTask(r.store, id, { paths: ['a.js'], loc: 900, handle: other, at: AT });
  const owned = taskText(r, id);
  assert.notEqual(owned, before);
  assert.throws(() => router.overrideTask(r.store, id, { to: 'trivial', by: 'user', quote: QUOTE, handle: r.handle, at: AT }), (e) => e.exit === 'REFUSED' && e.code === 'not-owner');
  assert.throws(() => router.routeTask(r.store, id, { paths: ['a.js'], loc: 1, handle: null, at: AT }), (e) => e.exit === 'REFUSED' && e.code === 'not-owner');
  assert.equal(taskText(r, id), owned);
  assert.ok(!existsSync(decisionsDir(r)));
  assert.throws(() => router.routeTask(r.store, `T-${r.handle}-99`, { paths: ['a.js'], loc: 1, handle: r.handle, at: AT }), (e) => e.exit === 'USAGE' && e.code === 'task-not-found');
  assert.throws(() => router.overrideTask(r.store, `T-${r.handle}-99`, { to: 'trivial', by: 'user', quote: QUOTE, handle: r.handle, at: AT }), (e) => e.exit === 'USAGE' && e.code === 'task-not-found');
  assert.throws(() => router.routeTask(r.store, 'X-1', { paths: ['a.js'], loc: 1, handle: r.handle, at: AT }), (e) => e.exit === 'USAGE');
  assert.ok(!existsSync(join(r.stateDir, 'tasks', `T-${r.handle}-99`)));
});

// ---- the command: `route <task> --paths --loc [--flags]`, `--probe`, `--override` (spec §8.2, §8.1 envelope) ----

async function cli(args, { dir, env, tty = false, json = true, commands = COMMANDS }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd: dir, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io, commands });
  const text = out.join('');
  return { code, text, stderr: err.join(''), env: json ? JSON.parse(text) : null };
}
// Every file under `dir` (except .git) with its content: a zero-footprint snapshot.
function snapshot(dir) {
  const files = {};
  const walk = (d, rel) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (rel === '' && f.name === '.git') continue;
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p, `${rel}${f.name}/`);
      else files[`${rel}${f.name}`] = readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return files;
}

test('route --json: one envelope with the class, the route, the outcome gates and the reasons', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const res = await cli(['route', id, '--paths', 'src/auth/a.js, src/b.js', '--loc', '12', '--flags', 'migration', '--yes'], r);
  assert.equal(res.code, 0, res.text);
  const { env } = res;
  assert.deepEqual([env.command, env.ok, env.exit, env.errors], ['route', true, 'OK', []]);
  assert.deepEqual([env.data.task, env.data.probe, env.data.class, env.data.computed, env.data.previous, env.data.outcome], [id, false, 'critical', 'critical', null, 'classified']);
  assert.deepEqual(env.data.route, { class: 'critical', steps: ['spec-plan', 'implement', 'verify', 'cross-provider-review', 'rereview', 'done'], gates: SD15_GATES });
  assert.deepEqual(env.data.reasons.map((x) => [x.code, x.path ?? null]), [['risk-path', 'src/auth/a.js'], ['risk-flag', null]]);
  assert.deepEqual(env.data.input, { files: 2, loc: 12, flags: ['migration'] });
  assert.equal(r.store.read('task', id).class, 'critical');
});

test('route via the command: the outcome-gate set is byte-identical for a trivial, a standard and a critical task', async (t) => {
  const r = repo(t);
  const plans = [['src/a.js', '3'], ['src/a.js,src/b.js,src/c.js', '3'], ['src/security/a.js', '3']];
  const out = [];
  for (const [paths, loc] of plans) {
    const id = newTask(r.store, r.handle);
    const res = await cli(['route', id, '--paths', paths, '--loc', loc, '--yes'], r);
    assert.equal(res.code, 0, res.text);
    out.push(res.env.data);
  }
  assert.deepEqual(out.map((d) => d.class), ['trivial', 'standard', 'critical']);
  assert.deepEqual([...new Set(out.map((d) => JSON.stringify(d.route.gates)))], [JSON.stringify(SD15_GATES)]);
});

test('route via the command: escalation, hold, and absolute paths inside the repository taken as repository-relative', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const go = (paths, loc = '3') => cli(['route', id, '--paths', paths, '--loc', loc, '--yes'], r);
  assert.equal((await go('src/a.js')).env.data.class, 'trivial');
  const up = (await go(join(r.dir, '.github', 'workflows', 'ci.yml'))).env.data;
  assert.deepEqual([up.outcome, up.class, up.previous, up.escalated], ['escalated', 'critical', 'trivial', true]);
  assert.deepEqual(up.addedSteps, ['spec-plan', 'cross-provider-review', 'rereview']);
  assert.equal(up.reasons[0].path, '.github/workflows/ci.yml');
  const before = taskText(r, id);
  const held = (await go('src/a.js')).env.data;
  assert.deepEqual([held.outcome, held.class, held.computed], ['held', 'critical', 'trivial']);
  assert.equal(taskText(r, id), before);
});

test('route --override via the command: lowering records a decision; --by user and --quote are required', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  await cli(['route', id, '--paths', 'src/auth/a.js', '--loc', '3', '--yes'], r);
  const before = taskText(r, id);
  const noBy = await cli(['route', id, '--override', 'standard', '--quote', QUOTE, '--yes'], r);
  assert.deepEqual([noBy.code, noBy.env.errors[0].code], [2, 'invalid-by']);
  const noQuote = await cli(['route', id, '--override', 'standard', '--by', 'user', '--yes'], r);
  assert.deepEqual([noQuote.code, noQuote.env.errors[0].code], [2, 'invalid-quote']);
  assert.equal(taskText(r, id), before);
  const res = await cli(['route', id, '--override', 'standard', '--by', 'user', '--quote', QUOTE, '--yes'], r);
  assert.equal(res.code, 0, res.text);
  assert.deepEqual([res.env.data.outcome, res.env.data.class, res.env.data.previous, res.env.data.decision, res.env.data.input], ['overridden', 'standard', 'critical', `D-${r.handle}-1`, null]);
  assert.deepEqual(res.env.data.route.gates, SD15_GATES, 'an override changes the route, never the gates');
  assert.ok(readFileSync(join(decisionsDir(r), `D-${r.handle}-1.md`), 'utf8').includes(`> ${QUOTE}`));
});

test('route via the command: usage errors exit 2 and write nothing', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  await cli(['route', id, '--paths', 'src/a.js', '--loc', '50', '--yes'], r);
  const before = snapshot(r.stateDir);
  const cases = [
    [[id, '--loc', '3'], 'missing-paths'],
    [[id, '--paths', ' , ,', '--loc', '3'], 'missing-paths'],
    [[id, '--paths', 'a.js'], 'missing-loc'],
    [[id, '--paths', 'a.js', '--loc', 'ten'], 'invalid-loc'],
    [[id, '--paths', 'a.js', '--loc', '-1'], 'invalid-loc'],
    [[id, '--paths', 'a.js', '--loc', '1e3'], 'invalid-loc'],
    [[id, '--paths', 'a.js', '--loc', '1', '--flags', 'bogus'], 'invalid-flag'],
    [['--paths', 'a.js', '--loc', '1'], 'missing-task'],
    [[id, '--probe', '--paths', 'a.js', '--loc', '1'], 'invalid-combination'],
    [['--probe', '--override', 'trivial', '--paths', 'a.js', '--loc', '1'], 'invalid-combination'],
    [[id, '--override', 'trivial', '--by', 'user', '--quote', QUOTE, '--paths', 'a.js'], 'invalid-combination'],
    [[id, '--override', 'trivial', '--by', 'user', '--quote', QUOTE, '--loc', '1'], 'invalid-combination'],
    [[id, '--paths', 'a.js', '--loc', '1', '--by', 'user'], 'invalid-combination'],
    [[id, '--paths', 'a.js', '--loc', '1', '--quote', QUOTE], 'invalid-combination'],
    [[id, '--override', 'tiny', '--by', 'user', '--quote', QUOTE], 'invalid-class'],
    [[`T-${r.handle}-99`, '--paths', 'a.js', '--loc', '1'], 'task-not-found'],
    [['X-1', '--paths', 'a.js', '--loc', '1'], null],
    [[id, '--paths', 'a.js', '--loc', '1', '--bogus'], 'unknown-flag'],
  ];
  for (const [args, code] of cases) {
    const res = await cli(['route', ...args, '--yes'], r);
    assert.equal(res.code, 2, `${args.join(' ')}\n${res.text}`);
    if (code) assert.equal(res.env.errors[0].code, code, args.join(' '));
  }
  assert.deepEqual(snapshot(r.stateDir), before, 'nothing written');
});

test('route via the command: consent, an untracked repository, another developer\'s task, an unregistered identity, outside git', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const args = ['route', id, '--paths', 'src/a.js', '--loc', '3'];
  const before = taskText(r, id);
  const refused = await cli(args, r);
  assert.deepEqual([refused.code, refused.env.errors[0].code], [7, 'consent-required'], 'it changes files: a terminal or --yes');
  assert.equal(taskText(r, id), before);
  assert.equal((await cli(args, { ...r, tty: true })).code, 0, 'a terminal is consent');

  const other = state.registerHandle(r.store, { name: 'Xavier Young', email: 'xy@example.com', at: AT }).handle;
  const theirs = newTask(r.store, other);
  const notOwner = await cli(['route', theirs, '--paths', 'src/a.js', '--loc', '3', '--yes'], r);
  assert.deepEqual([notOwner.code, notOwner.env.errors[0].code], [7, 'not-owner']);
  assert.equal(r.store.read('task', theirs).class, null);

  assert.equal(spawnSync('git', ['config', 'user.email', 'nobody@example.com'], { cwd: r.dir, env: r.env }).status, 0);
  const noHandle = await cli([...args, '--yes'], r);
  assert.deepEqual([noHandle.code, noHandle.env.errors[0].code], [7, 'no-handle']);

  const u = repo(t, { active: false });
  const inactive = await cli(['route', 'T-TU-1', '--paths', 'src/a.js', '--loc', '3', '--yes'], u);
  assert.deepEqual([inactive.code, inactive.env.errors[0].code], [7, 'inactive']);
  assert.match(inactive.env.errors[0].hint, /--probe/);
  assert.deepEqual(snapshot(u.dir), {}, 'an untracked repository stays untouched');

  const plain = join(u.base, 'plain');
  mkdirSync(plain);
  const outside = await cli(['route', 'T-TU-1', '--paths', 'src/a.js', '--loc', '3', '--yes'], { dir: plain, env: u.env });
  assert.deepEqual([outside.code, outside.env.exit], [8, 'ENV']);
});

test('route --probe: classifies a plan without a task and leaves zero footprint', async (t) => {
  const u = repo(t, { active: false });
  const probe = ['route', '--probe', '--paths', 'src/auth/a.js', '--loc', '3', '--yes'];
  const res = await cli(probe, u);
  assert.equal(res.code, 0, res.text);
  assert.deepEqual([res.env.data.task, res.env.data.probe, res.env.data.class, res.env.data.outcome, res.env.data.decision], [null, true, 'critical', 'probed', null]);
  assert.deepEqual(res.env.data.route.gates, SD15_GATES);
  assert.deepEqual(snapshot(u.dir), {}, 'no state directory in an untracked repository');
  assert.deepEqual(snapshot(u.home), {}, 'no machine data');
  const small = await cli(['route', '--probe', '--paths', 'README.md', '--loc', '2', '--yes'], u);
  assert.equal(small.env.data.class, 'trivial');

  const r = repo(t);
  const before = snapshot(r.stateDir);
  assert.equal((await cli(probe, r)).code, 0);
  assert.deepEqual(snapshot(r.stateDir), before, 'a probe in a tracked repository writes nothing');

  const plain = join(u.base, 'plain');
  mkdirSync(plain);
  const outside = await cli(probe, { dir: plain, env: u.env });
  assert.deepEqual([outside.code, outside.env.data.class], [0, 'critical'], 'a probe works outside git too');
  assert.deepEqual(snapshot(plain), {});
});

test('route text output: the class, the route, the gates and the reasons for people', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const res = await cli(['route', id, '--paths', 'src/a.js', '--loc', '3', '--yes'], { ...r, json: false });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.text, new RegExp(`^${id}: trivial\\n`));
  assert.match(res.text, /^route: implement > verify > done$/m);
  assert.match(res.text, /^outcome gates \(the same for every class\): profile-gates-pass, test-baseline-kept, report-red-green, state-valid$/m);
  assert.match(res.text, /^ {2}- 1 file <= 2, 3 LOC <= 30, no flags$/m);
  const up = await cli(['route', id, '--paths', 'src/auth/a.js', '--loc', '3', '--yes'], { ...r, json: false });
  assert.match(up.text, new RegExp(`^${id}: critical \\(raised from trivial\\)\\n`));
  assert.match(up.text, /^ {2}- src\/auth\/a\.js: matches risk glob \*\*\/auth\/\*\*$/m);
  assert.match(up.text, /^adds: spec-plan, cross-provider-review, rereview$/m);
  const held = await cli(['route', id, '--paths', 'src/a.js', '--loc', '3', '--yes'], { ...r, json: false });
  assert.match(held.text, new RegExp(`^${id}: critical \\(the plan is trivial; the class only rises\\)\\n`));
  await cli(['route', id, '--override', 'standard', '--by', 'user', '--quote', QUOTE, '--yes'], r);
  const waived = await cli(['route', id, '--paths', 'src/auth/a.js', '--loc', '3', '--yes'], { ...r, json: false });
  assert.match(waived.text, new RegExp(`^${id}: standard \\(the plan is critical; the user's override waived it\\)\\n`));
});

test('route via the command: profile risk globs come from an injectable reader and add to the defaults (findings-r1 #1)', async (t) => {
  const r = repo(t);
  const { makeRoute, readProfileRiskPaths } = await lib('router/command.mjs');
  assert.deepEqual(readProfileRiskPaths({ dir: r.stateDir, names }), [], 'no profile yet: no additions');
  const calls = [];
  const row = COMMANDS.find((x) => x.name === 'route');
  const reader = ({ dir }) => { calls.push(dir); return ['lib/public/**']; };
  const commands = COMMANDS.map((x) => (x === row ? { ...row, load: async () => makeRoute({ readProfileRiskPaths: reader }) } : x));
  const go = async (paths, opts = {}) => (await cli(['route', ...(opts.probe ? ['--probe'] : [newTask(r.store, r.handle)]), '--paths', paths, '--loc', '1', '--yes'], { ...r, ...opts })).env.data.class;
  assert.equal(await go('lib/public/client.js'), 'trivial', 'the default reader: no profile, no additions');
  assert.equal(await go('lib/public/client.js', { commands }), 'critical', 'a profile glob');
  assert.equal(await go('src/auth/a.js', { commands }), 'critical', 'the defaults still apply');
  assert.equal(await go('lib/public/client.js', { commands, probe: true }), 'critical', 'a probe in a tracked repository reads the profile too');
  assert.ok(calls.length === 3 && calls.every((d) => d === r.stateDir), `the reader got the store: ${calls}`);
  const u = repo(t, { active: false });
  assert.equal(await go.call(null, 'src/a.js', { ...u, commands, probe: true }), 'trivial');
  assert.equal(calls.length, 3, 'no profile is read in an untracked repository');
});

test('route reads the profile (INT-1): a risk glob the profile adds makes a path critical, in both forms', async (t) => {
  const r = repo(t);
  writeFileSync(join(r.dir, 'package.json'), `${JSON.stringify({ name: 'x', bin: { tool: './tools/run.js' } })}\n`);
  const id = newTask(r.store, r.handle);
  const plan = (form) => ['route', ...form, '--paths', 'tools/run.js', '--loc', '1', '--yes'];
  assert.equal((await cli(plan(['--probe']), r)).env.data.class, 'trivial', 'no profile yet');
  const observed = await cli(['profile', 'observe', '--yes'], r);
  assert.equal(observed.code, 0, observed.text);
  const stored = JSON.parse(readFileSync(join(r.stateDir, 'profile.json'), 'utf8')).riskPaths;
  assert.deepEqual(stored, [...router.DEFAULT_RISK_PATHS, 'tools/**'], 'the profile holds the router defaults plus its addition');
  for (const form of [['--probe'], [id]]) {
    const res = await cli(plan(form), r);
    assert.equal(res.code, 0, res.text);
    assert.equal(res.env.data.class, 'critical', `${form}: ${res.text}`);
    assert.deepEqual(res.env.data.reasons, [{ code: 'risk-path', text: 'matches risk glob tools/**', path: 'tools/run.js' }]);
  }
});

test('route consent per form (I4.1): --probe writes nothing and needs no consent; a task form needs a terminal or --yes', async (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  const probe = await cli(['route', '--probe', '--paths', 'src/a.js', '--loc', '1'], r);
  assert.deepEqual([probe.code, probe.env.data.outcome], [0, 'probed'], probe.text);
  const task = await cli(['route', id, '--paths', 'src/a.js', '--loc', '1'], r);
  assert.deepEqual([task.code, task.env.errors[0].code], [7, 'consent-required'], task.text);
  const override = await cli(['route', id, '--override', 'critical', '--by', 'user', '--quote', QUOTE], r);
  assert.deepEqual([override.code, override.env.errors[0].code], [7, 'consent-required'], override.text);
  assert.equal(JSON.parse(taskText(r, id)).class, null, 'nothing written without consent');
  assert.equal((await cli(['route', id, '--paths', 'src/a.js', '--loc', '1'], { ...r, tty: true })).code, 0, 'a terminal consents');
  const help = await cli(['route', '--help'], { ...r, json: false });
  assert.match(help.text, /^Changes files: needs a terminal or --yes, otherwise exit 7 REFUSED\. Read-only with --probe: no consent needed\.$/m);
});

test('route row: listed in help, changes files, and its --flags help names exactly the router flags', () => {
  const row = COMMANDS.find((x) => x.name === 'route');
  assert.ok(row && !row.hidden && typeof row.mutating === 'function', 'public; consent depends on the form');
  assert.deepEqual([row.mutating({}), row.mutating({ probe: true })], [true, false], 'every form but --probe changes files');
  assert.deepEqual(row.exits, ['OK', 'FAIL', 'USAGE', 'REFUSED', 'ENV']);
  assert.deepEqual(row.args.map((a) => [a.name, Boolean(a.required)]), [['task', false]]);
  assert.deepEqual(row.flags.map((f) => f.flag), ['--paths', '--loc', '--flags', '--probe', '--override', '--by', '--quote']);
  const listed = /: (.+)$/.exec(row.flags.find((f) => f.flag === '--flags').summary)[1].split(', ');
  assert.deepEqual(listed, [...router.FLAGS]);
  assert.deepEqual(/: (.+)$/.exec(row.flags.find((f) => f.flag === '--override').summary)[1].split(', '), [...router.CLASSES]);
});

// ---- the review need (spec §7.4): route prints it, from class x applied tier ----

function atTier(r, tier) {
  r.store.write('config', null, { flags: { engine: 'on' } });
  decisions.createDecision({ store: r.store, where: state.resolve({ cwd: r.dir, env: r.env, names }), names, env: r.env, handle: r.handle, today: AT.slice(0, 10), input: { title: `Tier ${tier} from L0`, why: 'test fixture', cost: 'none', kind: 'tier', scope: [], supersedes: [] } });
}

test('route: the review need is in the data and the text (critical: cross-provider at L2; trivial: none; shadow mode: any reviewer)', async (t) => {
  const r = repo(t);
  const crit = ['--paths', 'src/auth/a.js', '--loc', '5', '--yes'];
  const a = newTask(r.store, r.handle);
  const shadow = await cli(['route', a, ...crit], r);
  assert.deepEqual([shadow.env.data.review.need, shadow.env.data.review.text], ['any', 'any reviewer'], shadow.text);
  const probe = await cli(['route', '--probe', '--paths', 'src/a.js', '--loc', '1'], r);
  assert.deepEqual(probe.env.data.review, { need: 'none', text: 'none' });
  atTier(r, 'L2');
  const j = await cli(['route', '--probe', '--paths', 'src/auth/a.js', '--loc', '5'], r);
  assert.deepEqual(j.env.data.review, { need: 'external', text: 'cross-provider' });
  const text = await cli(['route', '--probe', '--paths', 'src/auth/a.js', '--loc', '5'], { ...r, json: false });
  assert.match(text.text, /^review: cross-provider$/m);
});

// ---- threshold overrides from config.json (T-MG-40) ----

const decisionText = (id, status) => `---\nschema: 1\nid: ${id}\ntitle: Larger changes\nstatus: ${status}\nkind: general\ndate: 2026-10-15\nauthor: TU\nsupersedes: []\nsupersededBy: null\nscope: []\nallowsTestRemoval: []\n---\n\n## What\n\nLarger changes.\n\n## Why\n\nLong modules.\n\n## Cost if wrong\n\nlow\n`;
function override(r, decision, status = 'active', value = 800) {
  if (status) {
    mkdirSync(decisionsDir(r), { recursive: true });
    writeFileSync(join(decisionsDir(r), `${decision}.md`), decisionText(decision, status));
  }
  r.store.write('config', null, { schema: 1, thresholds: { 'router.critical.overLoc': { value, decision, at: AT } } });
}
const probe500 = ['route', '--probe', '--paths', 'src/a.js', '--loc', '500', '--yes'];

test('route --probe and the ratchet read router threshold overrides from config.json; defaults hold without them', async (t) => {
  const r = repo(t);
  assert.equal((await cli(probe500, r)).env.data.class, 'critical', 'default: 500 LOC > 400');
  override(r, 'D-TU-1');
  assert.equal((await cli(probe500, r)).env.data.class, 'standard', 'override 800: 500 LOC is standard');
  const id = newTask(r.store, r.handle);
  assert.equal(router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 500, handle: r.handle, at: AT }).class, 'standard');
  const outside = repo(t, { active: false });
  assert.equal((await cli(probe500, outside)).env.data.class, 'critical', 'no repository state: defaults');
});

test('an override whose decision is missing or not active changes nothing; an unreadable config gives the defaults', async (t) => {
  const r = repo(t);
  override(r, 'D-TU-1', null);
  assert.equal((await cli(probe500, r)).env.data.class, 'critical', 'no record of the cited decision');
  override(r, 'D-TU-2', 'retired');
  assert.equal((await cli(probe500, r)).env.data.class, 'critical', 'retired decision');
  writeFileSync(join(r.stateDir, 'config.json'), '{ not json');
  assert.equal((await cli(probe500, r)).env.data.class, 'critical', 'unreadable config: shipped defaults');
});

test('a raised critical.overLoc after a task was routed critical keeps it critical (the ratchet only rises)', (t) => {
  const r = repo(t);
  const id = newTask(r.store, r.handle);
  assert.equal(router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 500, handle: r.handle, at: AT }).class, 'critical');
  override(r, 'D-TU-1');
  const again = router.routeTask(r.store, id, { paths: ['src/a.js'], loc: 500, handle: r.handle, at: AT });
  assert.equal(again.class, 'critical');
  assert.equal(r.store.read('task', id).class, 'critical');
});
