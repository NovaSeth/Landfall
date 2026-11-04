// Verify collectors (spec §7.6 step 3-4, SD-16, SC8): the test inventory from the test gate's own output
// (node:test TAP and spec lines, Jest/Vitest --json, pytest -v / --collect-only -q / -rs, go test -json,
// cargo test and cargo test -- --list with the #[ignore] scan) and the generic static scan of test files, compared
// with the baseline: a removed or newly skipped test is rejected unless an active decision lists it in
// allowsTestRemoval. Every mutation fixture of SC8 (deleted test, .skip, xit, t.skip, @pytest.mark.skip, #[ignore])
// is run through every collector that can see it, on recorded outputs (no tool but node is needed).
// This file holds no plugin name, path or literal decision ID: names come from lib/name.json, IDs are built by D().
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
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const verify = await lib('verify/index.mjs');
const profile = await lib('profile/index.mjs');
const D = (n, h = 'AB') => ['D', h, n].join('-');
const REPO = '/work/repo';

// IDs are the JSON [file, title, occurrence] (review r1 #9); `name` shows one as `file::title [n]` for reading.
const name = (id) => {
  if (!id.startsWith('[')) return id;
  const [file, title, n] = JSON.parse(id);
  return `${file ? `${file}::` : ''}${title}${n > 1 ? ` [${n}]` : ''}`;
};
const ids = (inv) => inv.tests.map((t) => name(t.id));
const skipped = (inv) => inv.tests.filter((t) => t.skipped).map((t) => name(t.id));
const failures = (inv) => inv.failing.map((f) => [name(f.id), f.location, f.message]);
// A collector context over in-memory files.
const ctx = (files = {}) => ({ repo: REPO, files: () => Object.keys(files), read: (f) => files[f] ?? null });
const parse = (text, files) => verify.parseReport(text, ctx(files));
const asBaseline = (inv) => ({ collector: inv.collector, tests: inv.tests, failing: [] });

// ---- recorded outputs ----

// node --test (Node 26 default: the spec reporter, also when piped); a file of three tests and a suite.
const nodeSpec = ({ skipRuntime = false, dotSkip = false, deleted = false } = {}) => [
  '✔ adds (0.9ms)',
  dotSkip ? '﹣ subtracts (0.1ms) # SKIP' : '✔ subtracts (0.2ms)',
  skipRuntime ? '﹣ divides (0.1ms) # not ready' : '✔ divides (0.3ms)',
  '▶ suite',
  '  ✔ inner (0.1ms)',
  ...(deleted ? [] : ['  ✔ other (0.1ms)']),
  '✔ suite (0.5ms)',
  'ℹ tests 5',
  'ℹ suites 1',
  'ℹ pass 5',
  'ℹ duration_ms 50.1',
  '',
].join('\n');

const nodeTap = ({ skipRuntime = false, dotSkip = false, deleted = false } = {}) => [
  'TAP version 13',
  '# Subtest: adds',
  'ok 1 - adds',
  '  ---',
  '  duration_ms: 0.9',
  "  type: 'test'",
  '  ...',
  '# Subtest: subtracts',
  `ok 2 - subtracts${dotSkip ? ' # SKIP' : ''}`,
  '  ---',
  '  duration_ms: 0.2',
  '  ...',
  '# Subtest: divides',
  `ok 3 - divides${skipRuntime ? ' # SKIP not ready' : ''}`,
  '# Subtest: suite',
  '    # Subtest: inner',
  '    ok 1 - inner',
  ...(deleted ? [] : ['    # Subtest: other', '    ok 2 - other']),
  `    1..${deleted ? 1 : 2}`,
  'ok 4 - suite',
  '  ---',
  "  type: 'suite'",
  '  ...',
  '1..4',
  '# tests 5',
  '',
].join('\n');

// jest --json through `npm run test`: npm's header lines, stderr progress merged in, one JSON line.
const jestJson = ({ status = {}, deleted = false } = {}) => {
  const a = (ancestorTitles, title) => ({ ancestorTitles, failureMessages: [], fullName: [...ancestorTitles, title].join(' '), location: null, status: status[title] ?? 'passed', title });
  const results = [a(['math'], 'adds'), a(['math'], 'subtracts'), ...(deleted ? [] : [a(['math'], 'divides')])];
  return `\n> calc@1.0.0 test\n> jest --json\n\nPASS src/math.test.js\n${JSON.stringify({
    numTotalTests: results.length, success: true,
    testResults: [{ assertionResults: results, name: `${REPO}/src/math.test.js`, status: 'passed', message: '' }],
  })}\n`;
};

// vitest --reporter=json: pretty-printed, after vitest's own lines.
const vitestJson = ({ status = {}, deleted = false } = {}) => {
  const a = (ancestorTitles, title) => ({ ancestorTitles, fullName: [...ancestorTitles, title].join(' '), status: status[title] ?? 'passed', title, duration: 1, failureMessages: [], meta: {} });
  const results = [a(['math'], 'adds'), ...(deleted ? [] : [a(['math'], 'subtracts')])];
  return ` RUN  v2.1.0 ${REPO}\n\n${JSON.stringify({
    numTotalTestSuites: 1, numTotalTests: results.length, success: true,
    testResults: [{ assertionResults: results, startTime: 1, endTime: 2, status: 'passed', message: '', name: `${REPO}/src/math.test.ts` }],
  }, null, 2)}\n`;
};

const pytestVerbose = ({ skip = false, deleted = false } = {}) => [
  '============================= test session starts ==============================',
  'platform darwin -- Python 3.12.0, pytest-8.3.2, pluggy-1.5.0 -- /usr/bin/python3',
  `rootdir: ${REPO}`,
  'collecting ... collected 4 items',
  '',
  'tests/test_math.py::test_add PASSED                                      [ 25%]',
  `tests/test_math.py::test_sub ${skip ? 'SKIPPED (not ready)' : 'PASSED'}                        [ 50%]`,
  ...(deleted ? [] : ['tests/test_math.py::TestDiv::test_div PASSED                             [ 75%]']),
  'tests/test_math.py::test_param[1-2] PASSED                               [100%]',
  '',
  '============================== 4 passed in 0.03s ===============================',
  '',
].join('\n');

const pytestCollect = ({ deleted = false } = {}) => [
  'tests/test_math.py::test_add',
  'tests/test_math.py::test_sub',
  ...(deleted ? [] : ['tests/test_math.py::TestDiv::test_div']),
  '',
  `${deleted ? 2 : 3} tests collected in 0.01s`,
  '',
].join('\n');

const pyFile = ({ skip = false } = {}) => [
  'import pytest',
  '',
  'def test_add():',
  '    assert 1 + 1 == 2',
  '',
  ...(skip ? ['@pytest.mark.skip(reason="not ready")'] : []),
  'def test_sub():',
  '    assert 2 - 1 == 1',
  '',
  'class TestDiv:',
  '    def test_div(self):',
  '        assert 1 / 1 == 1',
  '',
].join('\n');

// pytest --collect-only -q, then pytest -q -rs: the skip summary names a location, not an ID.
const pytestCollectAndSkips = ({ skip = false } = {}) => `${pytestCollect()}${skip ? '..s.' : '....'}                                     [100%]\n${skip ? '=========================== short test summary info ============================\nSKIPPED [1] tests/test_math.py:6: not ready\n' : ''}3 passed in 0.02s\n`;

const goJson = ({ skip = false, deleted = false } = {}) => {
  const ev = (o) => JSON.stringify({ Time: '2026-10-15T10:00:00.1Z', Package: 'example.com/calc', ...o });
  const t = (name, end, output = []) => [ev({ Action: 'run', Test: name }), ...output.map((o) => ev({ Action: 'output', Test: name, Output: o })), ev({ Action: end, Test: name, Elapsed: 0 })];
  return [
    ev({ Action: 'start' }),
    ...t('TestAdd', 'pass', ['=== RUN   TestAdd\n', '--- PASS: TestAdd (0.00s)\n']),
    ...t('TestSub', skip ? 'skip' : 'pass', skip ? ['=== RUN   TestSub\n', '    calc_test.go:12: not ready\n', '--- SKIP: TestSub (0.00s)\n'] : ['--- PASS: TestSub (0.00s)\n']),
    ...(deleted ? [] : t('TestDiv', 'pass')),
    ev({ Action: 'output', Output: 'ok  \texample.com/calc\t0.1s\n' }),
    ev({ Action: 'pass', Elapsed: 0.1 }),
    '',
  ].join('\n');
};

const cargoRun = ({ ignore = false, deleted = false } = {}) => [
  '   Compiling calc v0.1.0 (/work/repo)',
  '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.50s',
  '     Running unittests src/lib.rs (target/debug/deps/calc-1a2b3c)',
  '',
  `running ${deleted ? 2 : 3} tests`,
  'test tests::adds ... ok',
  `test tests::slow ... ${ignore ? 'ignored, needs network' : 'ok'}`,
  ...(deleted ? [] : ['test tests::divides ... ok']),
  '',
  `test result: ok. ${deleted ? 2 : 3} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`,
  '',
].join('\n');

const cargoList = ({ deleted = false } = {}) => `tests::adds: test\ntests::slow: test\n${deleted ? '' : 'tests::divides: test\n'}\n${deleted ? 2 : 3} tests, 0 benchmarks\n`;
const rsFile = ({ ignore = false } = {}) => [
  '#[cfg(test)]',
  'mod tests {',
  '    #[test]',
  '    fn adds() { assert_eq!(1 + 1, 2); }',
  '',
  '    #[test]',
  ...(ignore ? ['    #[ignore = "needs network"]'] : []),
  '    fn slow() {}',
  '',
  '    #[test]',
  '    fn divides() {}',
  '}',
  '',
].join('\n');

// ---- detection and inventories ----

test('each recorded output is detected as its collector; other output is no report (generic scan)', () => {
  const cases = [
    ['node-test', nodeSpec()], ['node-test', nodeTap()], ['jest', jestJson()], ['jest', vitestJson()],
    ['pytest', pytestVerbose()], ['pytest', pytestCollect()], ['go', goJson()], ['cargo', cargoRun()], ['cargo', cargoList()],
  ];
  for (const [collector, text] of cases) assert.equal(parse(text, { 'src/lib.rs': rsFile(), 'tests/test_math.py': pyFile() })?.collector, collector, text.slice(0, 80));
  // pytest without per-test lines (dots and the default short summary) lists no inventory: not a report.
  const dots = '..F.\n=========================== short test summary info ============================\nFAILED tests/test_math.py::test_sub - assert 1 == 2\n1 failed, 3 passed in 0.02s\n';
  for (const text of ['', 'ok  \texample.com/calc\t0.1s\n', '> calc@1.0.0 test\n> node scripts/check.js\nall good\n', dots, 'lint: 0 problems\n']) {
    assert.equal(parse(text), null, JSON.stringify(text));
  }
});

test('node:test: spec and TAP output give the same IDs (suite > test), skip and todo are skipped', () => {
  const spec = parse(nodeSpec({ skipRuntime: true }));
  const tap = parse(nodeTap({ skipRuntime: true }));
  assert.deepEqual(ids(spec), ['adds', 'subtracts', 'divides', 'suite > inner', 'suite > other']);
  assert.deepEqual(ids(tap), ids(spec));
  assert.deepEqual(skipped(spec), ['divides']);
  assert.deepEqual(skipped(tap), ['divides']);
  const todo = parse('✔ later (0.1ms) # TODO\n✔ now (0.1ms)\nℹ tests 2\n');
  assert.deepEqual(skipped(todo), ['later']);
  // A name with " # " and a duplicate name: the last "(Nms)" ends the name; duplicates are numbered in order.
  const odd = parse('✔ issue # 5 (0.1ms)\n✔ same (0.1ms)\n✔ same (0.2ms)\nℹ tests 3\n');
  assert.deepEqual(ids(odd), ['issue # 5', 'same', 'same [2]']);
});

test('node:test: failures carry location and message; a failed suite is a failure of its own, never a test', () => {
  const text = [
    '✔ adds (0.9ms)',
    '▶ suite',
    '  ✖ fails (0.7ms)',
    '✖ suite (1.0ms)',
    'ℹ tests 2',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at a.test.mjs:10:3',
    '✖ fails (0.7ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    '  1 !== 2',
    '',
  ].join('\n');
  const inv = parse(text);
  assert.deepEqual(ids(inv), ['adds', 'suite > fails']);
  assert.deepEqual(failures(inv), [['suite > fails', 'a.test.mjs:10:3', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n1 !== 2'], ['suite', '', '']]);
  assert.equal(inv.failCount, 1);
  const tap = parse(['TAP version 13', '# Subtest: s', '    # Subtest: fails', '    not ok 1 - fails', '      ---', "      location: '/r/a.test.mjs:10:3'", '      error: |-', '        Expected values to be strictly equal:', '        ', '        1 !== 2', '      ...', '    1..1', 'not ok 1 - s', '  ---', "  error: '1 subtest failed'", '  ...', '1..1', ''].join('\n'));
  assert.deepEqual(ids(tap), ['s > fails']);
  assert.deepEqual(failures(tap), [['s > fails', '/r/a.test.mjs:10:3', 'Expected values to be strictly equal:\n1 !== 2'], ['s', '', '1 subtest failed']]);
});

test('Jest and Vitest JSON: file-relative IDs, pending/skipped/todo/disabled are skipped, failures keep their message', () => {
  const j = parse(jestJson({ status: { subtracts: 'pending', divides: 'todo' } }));
  assert.deepEqual(ids(j), ['src/math.test.js::math > adds', 'src/math.test.js::math > subtracts', 'src/math.test.js::math > divides']);
  assert.deepEqual(skipped(j), ['src/math.test.js::math > subtracts', 'src/math.test.js::math > divides']);
  assert.equal(j.tests[0].file, 'src/math.test.js');
  const v = parse(vitestJson({ status: { subtracts: 'skipped' } }));
  assert.deepEqual(skipped(v), ['src/math.test.ts::math > subtracts']);
  const failed = JSON.stringify({ testResults: [{ name: `${REPO}/a.test.js`, assertionResults: [{ ancestorTitles: [], title: 'x', status: 'failed', failureMessages: ['Error: \u001b[2mexpect(\u001b[22mreceived).toBe(expected)\n\nExpected: 3\nReceived: 4'] }] }] });
  assert.deepEqual(failures(parse(failed)), [['a.test.js::x', '', 'Error: expect(received).toBe(expected)\nExpected: 3\nReceived: 4']]);
});

test('pytest: verbose lines, --collect-only -q lines with the static skip scan, and -rs locations map to IDs', () => {
  const v = parse(pytestVerbose({ skip: true }));
  assert.deepEqual(ids(v), ['tests/test_math.py::test_add', 'tests/test_math.py::test_sub', 'tests/test_math.py::TestDiv::test_div', 'tests/test_math.py::test_param[1-2]']);
  assert.deepEqual(skipped(v), ['tests/test_math.py::test_sub']);
  assert.equal(v.tests[0].file, 'tests/test_math.py');
  const c = parse(pytestCollect(), { 'tests/test_math.py': pyFile({ skip: true }) });
  assert.deepEqual(skipped(c), ['tests/test_math.py::test_sub'], 'the decorator marks the collected test');
  const rs = parse(pytestCollectAndSkips({ skip: true }), { 'tests/test_math.py': pyFile() });
  assert.deepEqual(skipped(rs), ['tests/test_math.py::test_sub'], 'line 6 is inside test_sub (its decorator line or body)');
  const failed = parse('tests/t_test.py::test_x FAILED [100%]\n=== short test summary info ===\nFAILED tests/t_test.py::test_x - assert 1 == 2\n');
  assert.deepEqual(failures(failed), [['tests/t_test.py::test_x', '', 'assert 1 == 2']]);
});

test('go test -json: package and Test IDs, skip actions are skipped, failures keep their message with its location', () => {
  const g = parse(goJson({ skip: true }));
  assert.deepEqual(ids(g), ['example.com/calc::TestAdd', 'example.com/calc::TestSub', 'example.com/calc::TestDiv']);
  assert.deepEqual(skipped(g), ['example.com/calc::TestSub']);
  const ev = (o) => JSON.stringify({ Package: 'p', ...o });
  const failed = parse([ev({ Action: 'run', Test: 'TestX' }), ev({ Action: 'output', Test: 'TestX', Output: '=== RUN   TestX\n' }), ev({ Action: 'output', Test: 'TestX', Output: '    x_test.go:20: got 1, want 2\n' }), ev({ Action: 'fail', Test: 'TestX' })].join('\n'));
  assert.deepEqual(failures(failed), [['p::TestX', '', 'x_test.go:20: got 1, want 2']]);
});

test('cargo: result lines (ignored is skipped), --list lines with the #[ignore] scan, panics give the failure message', () => {
  const r = parse(cargoRun({ ignore: true }));
  assert.deepEqual(ids(r), ['tests::adds', 'tests::slow', 'tests::divides']);
  assert.deepEqual(skipped(r), ['tests::slow']);
  const l = parse(cargoList(), { 'src/lib.rs': rsFile({ ignore: true }) });
  assert.deepEqual(skipped(l), ['tests::slow']);
  const failed = parse(['running 1 test', 'test tests::divides ... FAILED', '', 'failures:', '', '---- tests::divides stdout ----', '', "thread 'tests::divides' panicked at src/lib.rs:20:9:", 'assertion `left == right` failed', '  left: 1', ''].join('\n'));
  assert.deepEqual(failures(failed), [['tests::divides', '', "thread 'tests::divides' panicked at src/lib.rs:20:9:\nassertion `left == right` failed\nleft: 1"]]);
});

// ---- generic static scan ----

test('generic scan: JS, Python, Go and Rust declarations and skip markers; comments are not tests', () => {
  const js = verify.scanSource('src/a.test.js', [
    "import { test, describe, it } from 'node:test';",
    "test('plain', () => {});",
    "test.skip('dot skip', () => {});",
    "xit('x it', () => {});",
    "it('runtime', (t) => {",
    "  t.skip('later');",
    '});',
    "test('options', { skip: true }, () => {});",
    "test('not skipped', { skip: false }, () => {});",
    "describe.skip('whole suite', () => {",
    "  it.todo('todo');",
    '});',
    "// test('commented out', () => {});",
    '/*',
    "test('block comment', () => {});",
    '*/',
    "test.each([[1], [2]])('each %s', () => {});",
    "assert.ok(/x/.test('not a test'));",
    "test('plain', () => {});",
  ].join('\n'));
  assert.deepEqual(js.map((t) => [name(t.id), t.skipped]), [
    ['src/a.test.js::plain', false], ['src/a.test.js::dot skip', true], ['src/a.test.js::x it', true], ['src/a.test.js::runtime', true],
    ['src/a.test.js::options', true], ['src/a.test.js::not skipped', false], ['src/a.test.js::whole suite', true], ['src/a.test.js::todo', true],
    ['src/a.test.js::each %s', false], ['src/a.test.js::plain [2]', false],
  ]);
  const py = verify.scanSource('tests/test_m.py', [
    'import pytest, unittest',
    'def test_a(): pass',
    '@pytest.mark.skip(reason="x")',
    'def test_b(): pass',
    '# def test_commented(): pass',
    '@unittest.skip("x")',
    'class TestK:',
    '    def test_c(self): pass',
    'class TestL(unittest.TestCase):',
    '    def test_d(self):',
    '        pytest.skip("later")',
    '    async def test_e(self): pass',
    'def helper(): pass',
  ].join('\n'));
  assert.deepEqual(py.map((t) => [name(t.id), t.skipped]), [
    ['tests/test_m.py::test_a', false], ['tests/test_m.py::test_b', true], ['tests/test_m.py::TestK::test_c', true],
    ['tests/test_m.py::TestL::test_d', true], ['tests/test_m.py::TestL::test_e', false],
  ]);
  const go = verify.scanSource('calc_test.go', 'package calc\nimport "testing"\nfunc TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {\n\tt.Skip("later")\n}\n// func TestC(t *testing.T) {}\nfunc TestMain(m *testing.M) {}\n');
  assert.deepEqual(go.map((t) => [name(t.id), t.skipped]), [['calc_test.go::TestA', false], ['calc_test.go::TestB', true]]);
  const rs = verify.scanSource('src/lib.rs', rsFile({ ignore: true }));
  assert.deepEqual(rs.map((t) => [name(t.id), t.skipped]), [['src/lib.rs::adds', false], ['src/lib.rs::slow', true], ['src/lib.rs::divides', false]]);
  assert.deepEqual(verify.scanSource('src/main.js', "test('not in a test file', () => {});\n"), []);
});

test('IDs are state-safe: escaped as JSON, or a hash when too long or unsafe (stable, unique)', () => {
  const long = 'x'.repeat(400);
  const a = parse(`✔ ${long} (0.1ms)\n✔ ${long}y (0.1ms)\n✔ tab\there (0.1ms)\nℹ tests 3\n`);
  assert.ok(a.tests.every((t) => [...t.id].length <= 300), 'at most 300 characters');
  assert.notEqual(a.tests[0].id, a.tests[1].id);
  assert.deepEqual(parse(`✔ ${long} (0.2ms)\nℹ tests 1\n`).tests[0].id, a.tests[0].id, 'stable across runs');
  assert.doesNotMatch(a.tests[2].id, /\t/);
});

// ---- SC8: every mutation fixture through every collector that can see it ----

// [collector, mutation, before, after, ID that must be reported]
const SC8 = [
  ['node-test spec', 'deleted test', nodeSpec(), nodeSpec({ deleted: true }), 'suite > other'],
  ['node-test spec', '.skip', nodeSpec(), nodeSpec({ dotSkip: true }), 'subtracts'],
  ['node-test spec', 't.skip', nodeSpec(), nodeSpec({ skipRuntime: true }), 'divides'],
  ['node-test TAP', 'deleted test', nodeTap(), nodeTap({ deleted: true }), 'suite > other'],
  ['node-test TAP', '.skip', nodeTap(), nodeTap({ dotSkip: true }), 'subtracts'],
  ['node-test TAP', 't.skip', nodeTap(), nodeTap({ skipRuntime: true }), 'divides'],
  ['jest', 'deleted test', jestJson(), jestJson({ deleted: true }), 'src/math.test.js::math > divides'],
  ['jest', '.skip', jestJson(), jestJson({ status: { subtracts: 'pending' } }), 'src/math.test.js::math > subtracts'],
  ['jest', 'xit', jestJson(), jestJson({ status: { adds: 'pending' } }), 'src/math.test.js::math > adds'],
  ['vitest', 'deleted test', vitestJson(), vitestJson({ deleted: true }), 'src/math.test.ts::math > subtracts'],
  ['vitest', '.skip', vitestJson(), vitestJson({ status: { subtracts: 'skipped' } }), 'src/math.test.ts::math > subtracts'],
  ['pytest -v', 'deleted test', pytestVerbose(), pytestVerbose({ deleted: true }), 'tests/test_math.py::TestDiv::test_div'],
  ['pytest -v', '@pytest.mark.skip', pytestVerbose(), pytestVerbose({ skip: true }), 'tests/test_math.py::test_sub'],
  ['pytest --collect-only', 'deleted test', pytestCollect(), pytestCollect({ deleted: true }), 'tests/test_math.py::TestDiv::test_div'],
  ['pytest --collect-only', '@pytest.mark.skip', [pytestCollect(), pyFile()], [pytestCollect(), pyFile({ skip: true })], 'tests/test_math.py::test_sub'],
  ['pytest -rs', '@pytest.mark.skip', [pytestCollectAndSkips(), pyFile()], [pytestCollectAndSkips({ skip: true }), pyFile()], 'tests/test_math.py::test_sub'],
  ['go', 'deleted test', goJson(), goJson({ deleted: true }), 'example.com/calc::TestDiv'],
  ['go', 't.Skip', goJson(), goJson({ skip: true }), 'example.com/calc::TestSub'],
  ['cargo', 'deleted test', cargoRun(), cargoRun({ deleted: true }), 'tests::divides'],
  ['cargo', '#[ignore]', cargoRun(), cargoRun({ ignore: true }), 'tests::slow'],
  ['cargo --list', 'deleted test', cargoList(), cargoList({ deleted: true }), 'tests::divides'],
  ['cargo --list', '#[ignore]', [cargoList(), rsFile()], [cargoList(), rsFile({ ignore: true })], 'tests::slow'],
];

const inventoryOf = (fixture) => {
  const [text, file] = Array.isArray(fixture) ? fixture : [fixture, null];
  const files = file === null ? {} : file.startsWith('import pytest') ? { 'tests/test_math.py': file } : { 'src/lib.rs': file };
  return parse(text, files);
};

test('SC8: every mutation fixture is rejected by every collector without a decision, and allowed with one', () => {
  let rejected = 0;
  for (const [collector, mutation, before, after, id] of SC8) {
    const label = `${collector}: ${mutation}`;
    const base = inventoryOf(before);
    const now = inventoryOf(after);
    assert.ok(base && now, `${label}: both outputs parse`);
    const r = verify.compareInventory(asBaseline(base), now, []);
    assert.deepEqual(r.unallowed.map(name), [id], `${label}: rejected`);
    assert.deepEqual([...r.removed, ...r.newlySkipped].map(name), [id], label);
    if (r.unallowed.length) rejected++;
    const raw = r.unallowed[0];
    const ok = verify.compareInventory(asBaseline(base), now, [{ id: D(1), allowsTestRemoval: [raw] }]);
    assert.deepEqual([ok.unallowed, ok.allowedBy], [[], [D(1)]], `${label}: allowed by the decision`);
    const other = verify.compareInventory(asBaseline(base), now, [{ id: D(2), allowsTestRemoval: [`${raw} (other)`] }]);
    assert.deepEqual(other.unallowed, [raw], `${label}: a decision about another test does not cover it`);
  }
  assert.equal(rejected, SC8.length, 'SC8: 100% of the mutation fixtures rejected');
  const kinds = new Set(SC8.map(([, m]) => m));
  for (const m of ['deleted test', '.skip', 'xit', 't.skip', '@pytest.mark.skip', '#[ignore]']) assert.ok(kinds.has(m), `fixture ${m}`);
});

test('SC8 through the generic scan: each mutation of a source file is rejected', () => {
  const js = (lines) => verify.scanSource('test/a.test.js', lines.join('\n'));
  const before = js(["test('one', () => {});", "test('two', (t) => {});", "it('three', () => {});"]);
  const cases = [
    ['deleted test', js(["test('one', () => {});", "it('three', () => {});"]), 'test/a.test.js::two'],
    ['.skip', js(["test.skip('one', () => {});", "test('two', (t) => {});", "it('three', () => {});"]), 'test/a.test.js::one'],
    ['xit', js(["test('one', () => {});", "test('two', (t) => {});", "xit('three', () => {});"]), 'test/a.test.js::three'],
    ['t.skip', js(["test('one', () => {});", "test('two', (t) => {", "  t.skip('later');", '});', "it('three', () => {});"]), 'test/a.test.js::two'],
    ['commented out', js(["test('one', () => {});", "// test('two', (t) => {});", "it('three', () => {});"]), 'test/a.test.js::two'],
  ];
  const inv = (tests) => ({ collector: 'generic', tests, failing: [] });
  for (const [mutation, now, id] of cases) assert.deepEqual(verify.compareInventory(asBaseline(inv(before)), inv(now), []).unallowed.map(name), [id], mutation);
  const py = (skip) => inv(verify.scanSource('tests/test_math.py', pyFile({ skip })));
  assert.deepEqual(verify.compareInventory(asBaseline(py(false)), py(true), []).unallowed.map(name), ['tests/test_math.py::test_sub'], '@pytest.mark.skip');
  const rs = (ignore) => inv(verify.scanSource('src/lib.rs', rsFile({ ignore })));
  assert.deepEqual(verify.compareInventory(asBaseline(rs(false)), rs(true), []).unallowed.map(name), ['src/lib.rs::slow'], '#[ignore]');
});

test('compare: added tests and un-skipped tests pass; a test skipped in the baseline stays allowed skipped', () => {
  const t = (id, s = false) => ({ id, file: '', skipped: s });
  const base = { collector: 'node-test', tests: [t('a'), t('b', true), t('c')], failing: [] };
  const r = verify.compareInventory(base, { collector: 'node-test', tests: [t('a'), t('b', true), t('c'), t('d')], failing: [] }, []);
  assert.deepEqual([r.added, r.removed, r.newlySkipped, r.unallowed], [['d'], [], [], []]);
  const unskip = verify.compareInventory(base, { collector: 'node-test', tests: [t('a'), t('b'), t('c')], failing: [] }, []);
  assert.deepEqual(unskip.unallowed, []);
});

test('fingerprints: ID plus a hash of location and normalized message; only new failures fail', () => {
  const id = verify.testId('', 'a > b', 1);
  const at = { id, location: 'a.test.mjs:4:11', message: verify.normalizeMessage('  Expected values to be strictly equal:\n\n  1 !== 2\n      at TestContext (file:///x/a.test.mjs:4:30)\n') };
  const fp = verify.fingerprint(at);
  assert.equal(fp, `${id}@${fp.slice(id.length + 1)}`);
  assert.match(fp.slice(id.length), /^@[0-9a-f]{12}$/);
  assert.equal(verify.fingerprint({ ...at, message: verify.normalizeMessage('Expected values to be strictly equal:\n1 !== 2\n    at Other (file:///y/a.test.mjs:9:9)') }), fp, 'spacing and stack frames do not matter');
  assert.notEqual(verify.fingerprint({ ...at, message: 'another message' }), fp, 'a different failure of the same test is new');
  assert.notEqual(verify.fingerprint({ ...at, location: 'a.test.mjs:5:11' }), fp, 'so is a failure at another place');
  const split = verify.splitFailures(['x@1', 'y@2'], [{ id: 'x', message: 'm' }, { id: 'y', message: 'n' }].map(verify.fingerprint).concat(['x@1']));
  assert.deepEqual(split.preexisting, ['x@1']);
  assert.equal(split.new.length, 2);
});

test('baseline hash: canonical over collector, tests and failing; any edit changes it', () => {
  const t = (id, s = false) => ({ id, file: 'f', skipped: s });
  const b = { collector: 'generic', tests: [t('b'), t('a')], failing: [] };
  const sha = verify.baselineSha(b);
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(verify.baselineSha({ ...b, tests: [t('a'), t('b')] }), sha, 'order does not matter');
  for (const edit of [{ tests: [t('a')] }, { tests: [t('a', true), t('b')] }, { failing: ['a@000000000000'] }, { collector: 'node-test' }]) {
    assert.notEqual(verify.baselineSha({ ...b, ...edit }), sha, JSON.stringify(edit));
  }
});

// ---- review r1 (findings-r1.md) ----

// A parent test with a failing child; `own`: the parent also throws its own error after the child.
const parentTap = ({ a = 1, b = 2, own = false } = {}) => [
  'TAP version 13',
  '# Subtest: parent',
  '    # Subtest: known',
  '    not ok 1 - known',
  '      ---',
  '      duration_ms: 1.2',
  `      location: '${REPO}/p.test.mjs:4:11'`,
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        Expected values to be strictly equal:',
  '        ',
  `        ${a} !== ${b}`,
  '        ',
  "      code: 'ERR_ASSERTION'",
  `      expected: ${b}`,
  `      actual: ${a}`,
  "      operator: 'strictEqual'",
  '      stack: |-',
  `        TestContext.<anonymous> (file://${REPO}/p.test.mjs:4:30)`,
  '      ...',
  '    1..1',
  'not ok 1 - parent',
  '  ---',
  '  duration_ms: 1.9',
  `  location: '${REPO}/p.test.mjs:3:1'`,
  `  failureType: '${own ? 'testCodeFailure' : 'subtestsFailed'}'`,
  `  error: '${own ? 'NEW cleanup failure' : '1 subtest failed'}'`,
  "  code: 'ERR_TEST_FAILURE'",
  '  ...',
  '1..1',
  '# tests 2',
  '# fail 2',
  '',
].join('\n');

const parentSpec = ({ a = 1, b = 2, own = false, failCount = 2 } = {}) => [
  '▶ parent',
  '  ✖ known (1.2ms)',
  '✖ parent (1.9ms)',
  'ℹ tests 2',
  'ℹ suites 0',
  'ℹ pass 0',
  `ℹ fail ${failCount}`,
  'ℹ duration_ms 50',
  '',
  '✖ failing tests:',
  '',
  'test at p.test.mjs:4:11',
  '✖ known (1.2ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  ',
  `  ${a} !== ${b}`,
  '  ',
  `      at TestContext.<anonymous> (file://${REPO}/p.test.mjs:4:30)`,
  ...(own ? ['', 'test at p.test.mjs:3:1', '✖ parent (1.9ms)', '  Error: NEW cleanup failure', `      at TestContext.<anonymous> (file://${REPO}/p.test.mjs:5:9)`] : []),
  '',
].join('\n');

test('r1 #5: a parent\'s own failure is collected next to its pinned child; the reporter\'s failure count must be covered', () => {
  for (const [label, output] of [['TAP', parentTap], ['spec', parentSpec]]) {
    const pinned = parse(output());
    const known = new Set(pinned.failing.map(verify.fingerprint));
    assert.equal(pinned.failing.length, 2, `${label}: the child and the parent (propagated) are both failures`);
    assert.equal(verify.excusable(pinned, known), true, `${label}: the same failures are excused`);
    const now = parse(output({ own: true }));
    assert.equal(verify.excusable(now, known), false, `${label}: the parent's own new failure is not excused`);
  }
  // The reporter counts a failure the collector did not see: never excused.
  const hidden = parse(parentSpec({ failCount: 3 }));
  assert.equal(verify.excusable(hidden, new Set(hidden.failing.map(verify.fingerprint))), false);
});

test('r1 #10: a fingerprint covers the location and the whole assertion message (equal(1,2) and equal(3,4) differ)', () => {
  for (const [label, output] of [['TAP', parentTap], ['spec', parentSpec]]) {
    const one = parse(output({ a: 1, b: 2 })).failing.map(verify.fingerprint);
    const two = parse(output({ a: 3, b: 4 })).failing.map(verify.fingerprint);
    assert.notEqual(one[0], two[0], `${label}: different values, different fingerprint`);
    assert.equal(parse(output({ a: 1, b: 2 })).failing.map(verify.fingerprint)[0], one[0], `${label}: stable`);
  }
  const at = (line) => parse(parentSpec().replace('test at p.test.mjs:4:11', `test at p.test.mjs:${line}:11`)).failing.map(verify.fingerprint)[0];
  assert.notEqual(at(4), at(40), 'the location is part of it');
});

test('r1 #9: IDs are injective: a repeated title next to a literal "x [2]", and a long name next to a title equal to its ID', () => {
  const three = parse('✔ x (0.1ms)\n✔ x (0.1ms)\n✔ x [2] (0.1ms)\nℹ tests 3\n');
  assert.equal(new Set(three.tests.map((t) => t.id)).size, 3, 'three tests, three IDs');
  const two = parse('✔ x (0.1ms)\n✔ x [2] (0.1ms)\nℹ tests 2\n');
  assert.equal(verify.compareInventory(asBaseline(three), two, []).unallowed.length, 1, 'deleting the second x is a removal');
  const long = 'y'.repeat(400);
  const a = parse(`✔ ${long} (0.1ms)\nℹ tests 1\n`).tests[0].id;
  const b = parse(`✔ ${a} (0.1ms)\nℹ tests 1\n`).tests[0].id;
  assert.notEqual(a, b, 'a title equal to a shortened ID is another test');
});

test('r1 #6: generic scan: a skip through any context name, a test commented out inline, focused tests', () => {
  const s = verify.scanSource('test/a.test.js', [
    "test('one', () => {}); /* test('two', () => {}); */",
    "test('three', (context) => { context.skip('later'); return; });",
    "test.only('four', () => {});",
    "fit('five', () => {});",
    "const url = 'http://x'; test('six', () => {}); // test('seven', () => {});",
    "describe.only('eight', () => {});",
  ].join('\n'));
  const title = (id) => JSON.parse(id)[1];
  assert.deepEqual(s.map((t) => [title(t.id), t.skipped, Boolean(t.focused)]), [
    ['one', false, false], ['three', true, false], ['four', false, true], ['five', false, true], ['six', false, false], ['eight', false, true],
  ]);
});

test('r1 #6: profile observe writes node:test gates with the TAP reporter and Jest/Vitest gates with JSON output', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-observe-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cases = [
    [null, 'node --test', 'NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" npm run test'],
    ['pnpm-lock.yaml', 'tsc && node --test dist/', 'NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" pnpm run test'],
    [null, 'jest', 'npm run test -- --json'],
    ['yarn.lock', 'vitest run', 'yarn run test --reporter=json'],
    [null, 'jest && eslint .', 'npm run test'],
    [null, 'node --test --test-reporter=spec', 'npm run test'],
  ];
  cases.forEach(([lock, script, cmd], i) => {
    const dir = join(base, String(i));
    mkdirSync(dir);
    const files = ['package.json', ...(lock ? [lock] : [])];
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: script } }));
    if (lock) writeFileSync(join(dir, lock), '');
    assert.equal(profile.observeFiles(dir, files).gates[0].cmd, cmd, script);
  });
});

// A stack frame of a failing test's YAML block ("ok (file:///tmp/base-x/t.test.mjs:4:32)") reads like a TAP result line
// `ok (<location>)`; a name that is only a location is no test, and a real name that holds a path stays one.
test('node-test TAP: a stack frame named ok in a failure block is no test; a real name holding a path stays', () => {
  const out = (dir) => [
    'TAP version 13',
    '# Subtest: outer flow',
    'not ok 1 - outer flow',
    '  ---',
    '  duration_ms: 1.4',
    "  location: '" + dir + "/a.test.mjs:3:1'",
    '  error: |-',
    '    step failed',
    '  stack: |-',
    '    ok (file://' + dir + '/a.test.mjs:4:32)',
    '    TestContext.<anonymous> (file://' + dir + '/a.test.mjs:5:3)',
    '    ok ' + dir + '/a.test.mjs:4:32',
    '  ...',
    '# Subtest: reads /etc/hosts:1:2 text',
    'ok 2 - reads /etc/hosts:1:2 text',
    '  ---',
    '  duration_ms: 0.1',
    '  ...',
    '1..2',
    '# tests 2',
    '# fail 1',
    '',
  ].join('\n');
  const a = parse(out('/tmp/base-AAA'));
  const b = parse(out('/tmp/base-BBB'));
  assert.deepEqual(ids(a), ['outer flow', 'reads /etc/hosts:1:2 text']);
  assert.deepEqual(ids(a), ids(b));
});

test('node-test TAP: lines inside a YAML diagnostic block are never results or subtests', () => {
  const out = [
    'TAP version 13',
    '# Subtest: real one',
    'not ok 1 - real one',
    '  ---',
    '  duration_ms: 1.4',
    '  error: |-',
    '    stdout of an inner run:',
    '    # Subtest: inner',
    '    ok 3 - x',
    '    not ok 4 - y',
    '    ok handler',
    '  ...',
    '# Subtest: real two',
    'ok 2 - real two',
    '  ---',
    '  duration_ms: 0.1',
    '  ...',
    '1..2',
    '# tests 2',
    '# fail 1',
    '',
  ].join('\n');
  assert.deepEqual(ids(parse(out)), ['real one', 'real two']);
});

test('node-test TAP: a real test name that holds a path-like text is kept', () => {
  const out = ['TAP version 13', 'ok 1 - (input=/tmp/a:1:2)', '1..1', '# tests 1', '# fail 0', ''].join('\n');
  assert.deepEqual(ids(parse(out)), ['(input=/tmp/a:1:2)']);
});
