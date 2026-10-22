// Test renames (retro 2026-10 §4.2, COD-3): a test that changed its title and kept its body is `renamed`, not removed,
// so verify passes without a decision; a test whose body changed with its title, or a parametrized case that
// disappeared, is still a removal. Real node --test runs (title renames) and a vitest-like JSON reporter (parametrized
// `%o` titles, as the Pinwall project printed them) exercise the pairing. Then `decide --from-verify` and `--from-file`.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

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
const verify = await lib('verify/index.mjs');
const rename = await lib('verify/rename.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-22T10:00:00.000Z';
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "passing"}\n---\n\n# Report\n';
const NODE_TEST = [{ name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }];
const N = (title, n = 1) => JSON.stringify(['', title, n]);

function repo(t, { files, gates = NODE_TEST }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-rename-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const env = { ...ISO.env, HOME: join(base, 'home') };
  mkdirSync(env.HOME);
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
  store.write('state', null, { codename: names.codename, createdWith: '2.1.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'trivial', classHistory: [{ class: 'trivial', reason: 'trivial: test', at: AT }], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  write(`${names.stateDir}/tasks/${id}/report.md`, REPORT);
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  const r = { base, dir, env, stateDir, store, handle, id, git, write, vstore: verify.openStore(stateDir, names) };
  // the first verify pins the baseline; committing it and making that commit the base anchors it (review r2 D5)
  r.pin = () => { git('add', '-A'); git('commit', '-q', '-m', 'pin'); const sha = git('rev-parse', 'HEAD'); state.setTask({ cwd: dir, env, names, id, state: 'dispatched', options: { executor: 'claude:implementer', base: sha } }); return sha; };
  return r;
}

async function cli(args, { dir, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const text = out.join('');
  return { code, text, stderr: err.join(''), env: json ? JSON.parse(text) : null };
}
const run = (r) => cli(['verify', r.id, '--yes'], r);
const show = (res) => `${res.text}\n${res.stderr}`;

const nodeTests = ({ sub = 'subtracts', subBody = 'assert.equal(2 - 1, 1);', inner = 'inner' } = {}) => [
  "import { test, describe, it } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('adds', () => { assert.equal(1 + 1, 2); });",
  `test('${sub}', () => { ${subBody} });`,
  "describe('suite', () => {",
  `  it('${inner}', () => { assert.ok(true); });`,
  '});',
  '',
].join('\n');

test('jsTestBodies: full titles with describe ancestors, bodies by content, parametrized templates with their table', () => {
  const bodies = rename.jsTestBodies(nodeTests());
  assert.deepEqual(bodies.map((b) => [b.title, b.template]), [['adds', false], ['subtracts', false], ['suite > inner', false]]);
  const renamed = rename.jsTestBodies(nodeTests({ sub: 'subtracts two numbers', inner: 'inner case' }));
  assert.deepEqual(renamed.map((b) => b.body), bodies.map((b) => b.body), 'a title change keeps every body');
  assert.notEqual(rename.jsTestBodies(nodeTests({ subBody: 'assert.equal(3 - 1, 2);' }))[1].body, bodies[1].body, 'a changed assertion changes the body');
  assert.equal(rename.jsTestBodies(nodeTests({ subBody: 'assert.equal(2 - 1,   1);' }))[1].body, bodies[1].body, 'whitespace does not count');
  assert.notEqual(rename.jsTestBodies(nodeTests({ subBody: "assert.equal(join(['a', 'b']), 'a b');" }))[1].body, rename.jsTestBodies(nodeTests({ subBody: "assert.equal(join(['a', 'b']), 'ab');" }))[1].body, 'whitespace inside a string literal counts');
  assert.notEqual(rename.jsTestBodies(nodeTests().replace("test('subtracts'", "test.skip('subtracts'"))[1].body, bodies[1].body, '.skip is part of the body');
  assert.notEqual(rename.jsTestBodies(nodeTests().replace("it('inner'", "xit('inner'"))[2].body, bodies[2].body, 'an x prefix is part of the body');
  const each = rename.jsTestBodies("describe('drawGrid', () => {\n  it.each([[light, '#b0'], [dark, '#4a']] as const)('uses the grid color for theme %o', (theme, color) => { expect(grid(theme)).toBe(color); });\n  it('draws dots', () => { expect(1).toBe(1); });\n});\n");
  assert.deepEqual(each.map((b) => [b.title, b.template]), [['drawGrid > uses the grid color for theme %o', true], ['drawGrid > draws dots', false]]);
  const other = rename.jsTestBodies("describe('drawGrid', () => {\n  it.each([[light, '#b0']] as const)('uses the grid color for theme %o', (theme, color) => { expect(grid(theme)).toBe(color); });\n});\n");
  assert.notEqual(other[0].body, each[0].body, 'the table is part of the body: a dropped case is no rename');
  assert.ok(rename.templateRegex('drawGrid > uses the grid color for theme %o').test("drawGrid > uses the grid color for theme { bg: '#121214', …(6) }"));
  assert.ok(rename.templateRegex('zoom $zoom doubles %s spacing').test('zoom 0.5 doubles world spacing'));
  assert.ok(!rename.templateRegex('a %s b').test('a b'));
  assert.ok(!rename.templateRegex('a (b) %d').test('a b 3'));
});

test('a title rename with the same body passes as renamed (node --test), a changed body with a new title is still a removal', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  assert.equal((await run(r)).code, 0);
  const none = await cli(['decide', '--from-verify', r.id, '--why', 'x', '--cost', 'y', '--yes'], r);
  assert.deepEqual([none.code, none.env.errors[0].code], [1, 'nothing-to-allow'], show(none));
  r.pin();
  r.write('calc.test.mjs', nodeTests({ sub: 'subtracts two numbers', inner: 'inner case' }));
  let res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual(res.env.data.renamed, [{ from: N('subtracts'), to: N('subtracts two numbers') }, { from: N('suite > inner'), to: N('suite > inner case') }]);
  assert.deepEqual([res.env.data.inventory.removed, res.env.data.inventory.allowedBy], [[], []], 'renamed tests are neither removed nor allowed');
  assert.ok(res.env.data.inventory.added.includes(N('subtracts two numbers')), 'the new title grows the baseline');
  const text = await cli(['verify', r.id, '--yes'], { ...r, json: false });
  assert.match(text.text, /renamed 2/);
  assert.match(text.text, /renamed \(same body, no decision needed\)/);
  assert.deepEqual(r.vstore.read('baseline', null).tests.map((x) => x.id), [N('adds'), N('subtracts two numbers'), N('suite > inner case')]);
  r.pin();
  // a renamed test that is skipped at the same time is no rename: the skip would hide
  r.write('calc.test.mjs', nodeTests({ sub: 'subtracts whole numbers', inner: 'inner case' }).replace("test('subtracts whole numbers'", "test.skip('subtracts whole numbers'"));
  res = await run(r);
  assert.deepEqual([res.code, res.env.data.result, res.env.data.renamed, res.env.data.inventory.removed], [1, 'baseline-shrunk', [], [N('subtracts two numbers')]], show(res));
  // the same title change with a changed assertion: a removal that needs a decision
  r.write('calc.test.mjs', nodeTests({ sub: 'subtracts whole numbers', subBody: 'assert.equal(3 - 1, 2);', inner: 'inner case' }));
  res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.renamed, res.env.data.inventory.removed], ['baseline-shrunk', [], [N('subtracts two numbers')]]);
  // decide --from-verify takes exactly those IDs; the next verify passes
  const d = await cli(['decide', '--from-verify', r.id, '--why', 'the assertion changed on purpose', '--cost', 'a weaker test', '--yes'], r);
  assert.equal(d.code, 0, show(d));
  const record = readFileSync(join(r.stateDir, 'decisions', `${d.env.data.id}.md`), 'utf8');
  assert.match(record, /kind: test-removal/);
  assert.match(record, new RegExp(`title: "?${r.id}: 1 test removed or newly skipped`));
  assert.ok(record.includes(JSON.stringify(N('subtracts two numbers'))), record);
  res = await run(r);
  assert.deepEqual([res.code, res.env.data.inventory.allowedBy], [0, [d.env.data.id]], show(res));
});

// A vitest-like JSON reporter: the gate prints what titles.json lists, as `--reporter=json` would, so parametrized
// titles with a printed object (`%o`) change when the object gains a key while the source stays the same.
const GRID = (dots = 'draws dots', addsBody = 'expect(1 + 1).toBe(2)') => [
  "import { describe, it, expect } from 'vitest';",
  "describe('drawGrid', () => {",
  "  it.each([[lightTheme, '#b0b0aa'], [darkTheme, '#4a4a53']] as const)('uses the grid color for theme %o', (theme, color) => { expect(grid(theme)).toBe(color); });",
  `  it('${dots}', () => { expect(dots(240)).toBe(144); });`,
  `  it('adds', () => { ${addsBody}; });`,
  '});',
  '',
].join('\n');
const REPORTER = "import { readFileSync } from 'node:fs';\nconst titles = JSON.parse(readFileSync('titles.json', 'utf8'));\nconst file = process.cwd() + '/grid.test.ts';\nconsole.log(JSON.stringify({ numFailedTests: 0, testResults: [{ name: file, status: 'passed', assertionResults: titles.map((title) => ({ ancestorTitles: ['drawGrid'], title, status: 'passed', failureMessages: [] })) }] }));\n";
const TITLES = (keys, dots = 'draws dots', adds = 'adds') => JSON.stringify([`uses the grid color for theme { bg: '#121214', grid: '#3a3a41', …(${keys}) }`, `uses the grid color for theme { bg: '#f6f6f4', grid: '#c4c4bf', …(${keys}) }`, dots, adds]);
const G = (title) => JSON.stringify(['grid.test.ts', `drawGrid > ${title}`, 1]);

test('parametrized titles (it.each with %o) that change because the printed object gained a key are renames; a case that vanished is a removal', async (t) => {
  const gates = [{ name: 'test', cmd: 'node reporter.mjs', timeoutS: 120, kind: 'test' }];
  const r = repo(t, { files: { 'grid.test.ts': GRID(), 'reporter.mjs': REPORTER, 'titles.json': TITLES(5) }, gates });
  let res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.equal(res.env.data.inventory.collector, 'jest');
  r.pin();
  // WP2 adds a theme token: the two printed titles change, the source of the test does not; `draws dots` is renamed
  r.write('titles.json', TITLES(6, 'draws 144 dots'));
  r.write('grid.test.ts', GRID('draws 144 dots'));
  res = await run(r);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual(res.env.data.renamed.map((p) => [p.from, p.to]), [
    [G('draws dots'), G('draws 144 dots')],
    [G("uses the grid color for theme { bg: '#121214', grid: '#3a3a41', …(5) }"), G("uses the grid color for theme { bg: '#121214', grid: '#3a3a41', …(6) }")],
    [G("uses the grid color for theme { bg: '#f6f6f4', grid: '#c4c4bf', …(5) }"), G("uses the grid color for theme { bg: '#f6f6f4', grid: '#c4c4bf', …(6) }")],
  ], 'in the order of the removed IDs');
  assert.deepEqual(res.env.data.inventory.removed, []);
  // a second run before the next pin: the working baseline already holds the new titles, the anchor still the old ones
  const again = await run(r);
  assert.deepEqual([again.code, again.env.data.renamed.length, again.env.data.inventory.removed], [0, 3, []], show(again));
  r.pin();
  // a changed assertion under a new title is still a removal; a parametrized case that vanished too
  r.write('titles.json', JSON.stringify([`uses the grid color for theme { bg: '#121214', grid: '#3a3a41', …(6) }`, 'draws 144 dots', 'adds numbers']));
  r.write('grid.test.ts', GRID('draws 144 dots', 'expect(2 + 2).toBe(4)').replace("[[lightTheme, '#b0b0aa'], [darkTheme, '#4a4a53']]", "[[lightTheme, '#b0b0aa']]").replace("it('adds'", "it('adds numbers'"));
  res = await run(r);
  assert.equal(res.code, 1, show(res));
  assert.deepEqual([res.env.data.result, res.env.data.renamed], ['baseline-shrunk', []]);
  assert.deepEqual(res.env.data.inventory.removed, [G('adds'), G("uses the grid color for theme { bg: '#f6f6f4', grid: '#c4c4bf', …(6) }")]);
});

test('decide --from-file reads the fields from JSON; flags given on the command line win; a bad file writes nothing', async (t) => {
  const r = repo(t, { files: { 'calc.test.mjs': nodeTests() } });
  const file = join(r.base, 'decision.json');
  writeFileSync(file, JSON.stringify({ title: 'Canvas 2D, not WebGL', why: 'Simpler to test (no GPU in CI).', cost: 'A rewrite if the dot budget needs the GPU.', scope: ['client/src/engine/**'], kind: 'general' }));
  const d = await cli(['decide', '--from-file', file, '--yes'], r);
  assert.equal(d.code, 0, show(d));
  const record = readFileSync(join(r.stateDir, 'decisions', `${d.env.data.id}.md`), 'utf8');
  assert.match(record, /title: "?Canvas 2D, not WebGL/);
  assert.match(record, /scope: \[client\/src\/engine\/\*\*\]/);
  assert.match(record, /Simpler to test \(no GPU in CI\)\./);
  const won = await cli(['decide', '--from-file', file, '--title', 'Flag wins', '--yes'], r);
  assert.equal(won.code, 0, show(won));
  assert.match(readFileSync(join(r.stateDir, 'decisions', `${won.env.data.id}.md`), 'utf8'), /title: "?Flag wins/);
  const before = readdirSync(join(r.stateDir, 'decisions')).length;
  writeFileSync(file, '{"title": "x", "why": "y", "cost": "z", "colour": "red"}');
  const bad = await cli(['decide', '--from-file', file, '--yes'], r);
  assert.deepEqual([bad.code, bad.env.errors[0].code], [2, 'invalid-value'], show(bad));
  writeFileSync(file, 'not json');
  const worse = await cli(['decide', '--from-file', file, '--yes'], r);
  assert.deepEqual([worse.code, worse.env.errors[0].code], [2, 'decision-file-unreadable'], show(worse));
  assert.equal(readdirSync(join(r.stateDir, 'decisions')).length, before, 'nothing written');
});
