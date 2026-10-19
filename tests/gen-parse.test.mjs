// Generated configuration is parsed, not compared as text (spec §7.14 step 5, REV-56): every target renders for
// every combination of generator options, and each result goes through its tool's grammar: the CI workflow through
// a strict YAML subset parser (tests/lib/yaml-subset.mjs) with a structural check of the GitHub Actions shape,
// the pre-push hook through `sh -n` and `bash -n`, CODEOWNERS line by line, the PR template's code spans. Option
// values survive the round trip exactly (gate names and commands come back from the parsed YAML unchanged).
// Behaviour: the generated CI side-file step and the pre-push hook run in a temporary repository and fail exactly
// when a generated side file is tracked (spec §7.14a). No JSON or TOML target exists among the five templates;
// the JSON state document of the generator is parsed in tests/gen-property.test.mjs, the AGENTS.md block in
// tests/gen-agents.test.mjs.
// This file never spells the codename: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { YamlError, parseYaml } from './lib/yaml-subset.mjs';

// git, sh and bash run with a throwaway HOME and global config, without the calling session.
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function locate() {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return { pluginDir: join(plugins, hits[0]), names: JSON.parse(readFileSync(join(plugins, hits[0], 'lib', 'name.json'), 'utf8')) };
}
const { pluginDir, names } = locate();
const gen = await import(pathToFileURL(join(pluginDir, 'lib', 'gen', 'index.mjs')).href);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: process.env, timeout: 30000, ...opts });
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const scratch = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const target = (id) => gen.TARGETS.find((x) => x.id === id);
const SIDE = gen.sideSuffix(names);

const GATE_SETS = [
  [],
  [{ name: 'test', cmd: 'npm test' }],
  [
    { name: 'unit: "fast" \\ slow', cmd: 'npm test -- --grep "a: b" # not a comment' },
    { name: "lint 'strict' #1", cmd: "printf '%s\\n' \"$HOME\" | tr a-z A-Z && echo 'it''s'" },
    { name: 'types', cmd: 'node -e "console.log(`x`)" && echo ``` && echo ${{ github.sha }}' },
  ],
];
const OWNER_SETS = [[], ['@org/platform-team'], ['@alice', 'bob@example.com']];
const BRANCHES = ['main', 'release/v2.x'];
// The npx package spec of the plugin CLI for CI steps (SD-21: the release tag <plugin>--v<version>); absent → no step.
const PACKAGES = [undefined, `github:example-org/example-repo#${names.plugin}--v2.0.0`];
const COMBINATIONS = GATE_SETS.flatMap((gates) => OWNER_SETS.flatMap((owners) => BRANCHES.flatMap((branch) => PACKAGES.map((pkg) => ({ gates, owners, branch, ...(pkg ? { package: pkg } : {}) })))));
const label = (o) => `gates=${o.gates.length} owners=${o.owners.length} branch=${o.branch} package=${o.package ?? '-'}`;
const PLACEHOLDER = /(?<!\$)\{\{[#^/]?[A-Za-z][A-Za-z0-9]*\}\}/;
const FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;

test('the generator knows exactly the five targets, each with one template under templates/{ci,githooks,codeowners,pr,agents-md}', () => {
  assert.deepEqual(gen.TARGETS.map((x) => x.id), ['ci', 'pre-push', 'codeowners', 'pr-template', 'agents-md']);
  assert.deepEqual(gen.TARGETS.map((x) => x.path(names)), [`.github/workflows/${names.codename}.yml`, '.githooks/pre-push', 'CODEOWNERS', '.github/pull_request_template.md', 'AGENTS.md']);
  for (const dir of ['ci', 'githooks', 'codeowners', 'pr', 'agents-md']) {
    const files = readdirSync(join(pluginDir, 'templates', dir));
    assert.equal(files.length, 1, `templates/${dir}: one template`);
    assert.ok(gen.TARGETS.some((x) => x.template === `${dir}/${files[0]}`), `templates/${dir}/${files[0]} belongs to a target`);
  }
  assert.equal(target('pre-push').fileMode, 0o755, 'the hook is executable');
  assert.equal(target('codeowners').mode, 'block', 'CODEOWNERS is a managed block');
  assert.deepEqual(gen.checkOptions(gen.DEFAULT_OPTIONS), []);
  for (const o of COMBINATIONS) assert.deepEqual(gen.checkOptions(o), [], label(o));
});

test('every target renders for every option combination: no placeholder left, no control character, final newline', () => {
  for (const o of COMBINATIONS) {
    for (const t of gen.TARGETS) {
      const text = gen.render(t, o, names);
      assert.doesNotMatch(text, PLACEHOLDER, `${t.id} ${label(o)}`);
      assert.doesNotMatch(text, FORBIDDEN, `${t.id} ${label(o)}`);
      assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${t.id} ${label(o)}: one final newline`);
    }
  }
});

test('CI workflow: parses as strict YAML for every combination and has the GitHub Actions shape; values round-trip', () => {
  for (const o of COMBINATIONS) {
    const doc = parseYaml(gen.render(target('ci'), o, names));
    const at = label(o);
    assert.equal(doc.name, names.codename, at);
    assert.deepEqual(doc.on, { pull_request: null, push: { branches: [o.branch] } }, at);
    assert.deepEqual(doc.permissions, { contents: 'read' }, `${at}: least-privilege token`);
    assert.ok(typeof doc.concurrency?.group === 'string', at);
    const jobs = Object.keys(doc.jobs);
    assert.deepEqual(jobs, o.gates.length ? ['process', 'gates', 'result'] : ['process', 'result'], at);
    assert.deepEqual(doc.jobs.result.needs, jobs.filter((j) => j !== 'result'), `${at}: result needs every other job`);
    for (const [id, job] of Object.entries(doc.jobs)) {
      assert.equal(job['runs-on'], 'ubuntu-latest', `${at} ${id}`);
      assert.ok(Array.isArray(job.steps) && job.steps.length > 0, `${at} ${id}: steps`);
      for (const step of job.steps) {
        assert.ok((step.uses === undefined) !== (step.run === undefined), `${at} ${id}: a step has uses or run`);
        if (step.uses !== undefined) {
          assert.match(step.uses, PINNED, `${at} ${id}: action pinned to a commit SHA`);
          // The process job runs the secrets scan of a pull request's commits (SD-29): its checkout fetches the history.
          const history = id === 'process' && o.package ? { 'fetch-depth': 0 } : {};
          assert.deepEqual(step.with, { 'persist-credentials': false, ...history }, `${at} ${id}: checkout keeps no token`);
        }
      }
    }
    const side = doc.jobs.process.steps.find((s) => s.name === 'no generated side file is tracked');
    assert.ok(side && side.run.includes(`'*${SIDE}'`), `${at}: side-file step`);
    const gates = (doc.jobs.gates?.steps ?? []).filter((s) => s.run !== undefined);
    assert.deepEqual(gates.map((s) => [s.name, s.run]), o.gates.map((g) => [g.name, `${g.cmd}\n`]), `${at}: gate names and commands round-trip`);
    // The package's default bin is the 1.x installer: a step that runs the plugin CLI through npx names the package
    // and the bin explicitly (SD-21), with the bin from lib/name.json. Gate commands are the user's and not checked.
    const own = Object.entries(doc.jobs).flatMap(([id, job]) => (id === 'gates' ? [] : job.steps)).filter((st) => st.run !== undefined);
    const npx = own.flatMap((st) => st.run.split('\n')).filter((l) => /\bnpx\b/.test(l));
    for (const line of npx) {
      const m = /^npx --yes --package '([^']+)' (\S+) (\S.*)$/.exec(line.trim());
      assert.ok(m, `${at}: explicit npx form: ${line}`);
      assert.deepEqual([m[1], m[2]], [o.package, names.bin], `${at}: package spec and bin`);
    }
    const decisions = doc.jobs.process.steps.filter((st) => st.run === `npx --yes --package '${o.package}' ${names.bin} decisions check\n`);
    assert.equal(decisions.length, o.package ? 1 : 0, `${at}: the decisions check step (SD-21) exactly when a package spec is given`);
    if (!o.package) assert.deepEqual(npx, [], `${at}: no npx without a package spec`);
  }
});

test('pre-push hook: sh -n and bash -n accept it for every combination; shebang and header document the exit codes', () => {
  const t = target('pre-push');
  for (const o of COMBINATIONS) {
    const text = gen.render(t, o, names);
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text.split('\n').slice(0, 12).join('\n'), /^# Exit codes: 0 .*1 /m);
    for (const shell of ['sh', 'bash']) {
      const r = run(shell, ['-n'], { input: text });
      assert.equal(r.status, 0, `${shell} -n ${label(o)}\n${out(r)}`);
    }
  }
});

test('CODEOWNERS block: every line is a comment or "<pattern> <owner…>" with valid owners; markers wrap the block', () => {
  const t = target('codeowners');
  const OWNER = /^(@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?|[^@\s]+@[^@\s]+\.[A-Za-z]{2,})$/;
  const { begin, end } = gen.blockMarkers(t, names);
  for (const o of COMBINATIONS) {
    const block = gen.render(t, o, names);
    const file = gen.wrapBlock(t, names, block);
    assert.equal(file, `${begin}\n${block}${end}\n`);
    const rules = [];
    for (const line of file.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const [pattern, ...owners] = line.trim().split(/\s+/);
      assert.ok(pattern && owners.length > 0, `${label(o)}: "${line}" names owners`);
      for (const owner of owners) assert.match(owner, OWNER, label(o));
      rules.push([pattern, owners]);
    }
    assert.deepEqual(rules, o.owners.length ? [['*', o.owners]] : [], label(o));
  }
});

test('PR template: each gate command comes back from its code span unchanged', () => {
  const t = target('pr-template');
  for (const o of COMBINATIONS) {
    const text = gen.render(t, o, names);
    const spans = [...text.matchAll(/^- \[ \] (`+)( ?)(.*?)\2\1 passes$/gm)].map((m) => m[3]);
    assert.deepEqual(spans, o.gates.map((g) => g.cmd), label(o));
    assert.ok(text.includes(SIDE), `${label(o)}: names the side-file suffix`);
  }
});

test('options: invalid values are rejected before anything renders', () => {
  const bad = [
    { gates: [{ name: 'x ${{ secrets.T }}', cmd: 'true' }] },
    { gates: [{ name: 'x', cmd: 'line one\nline two' }] },
    { gates: [{ name: 'x', cmd: ' leading space' }] },
    { gates: [{ name: '', cmd: 'true' }] },
    { gates: [{ name: 'x', cmd: 'true', extra: 1 }] },
    { gates: Array.from({ length: 21 }, (_, i) => ({ name: `g${i}`, cmd: 'true' })) },
    { owners: ['alice'] },
    { owners: ['@'] },
    { branch: 'a..b' },
    { branch: '-x' },
    { branch: 'x\u202e' },
    { package: 'github:org/repo#tag; rm -rf /' },
    { package: "github:org/repo'x" },
    { package: '../local-tarball.tgz' },
    { unknown: true },
  ];
  for (const partial of bad) {
    const o = { ...gen.DEFAULT_OPTIONS, ...partial };
    assert.ok(gen.checkOptions(o).length > 0, JSON.stringify(partial));
    assert.throws(() => gen.render(target('ci'), o, names), /options/, JSON.stringify(partial));
  }
});

function repo(t) {
  const dir = scratch(t, 'gen-parse-repo-');
  for (const args of [['init', '-q'], ['config', 'commit.gpgsign', 'false']]) assert.equal(run('git', args, { cwd: dir }).status, 0);
  return dir;
}
const git = (cwd, ...args) => {
  const r = run('git', args, { cwd });
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${out(r)}`);
  return r.stdout.trim();
};
const commitFiles = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'files');
  return git(dir, 'rev-parse', 'HEAD');
};

test('CI side-file step (spec §7.14a): passes with no tracked side file, fails when one is tracked, ignores untracked ones', (t) => {
  const doc = parseYaml(gen.render(target('ci'), gen.DEFAULT_OPTIONS, names));
  const script = doc.jobs.process.steps.find((s) => s.name === 'no generated side file is tracked').run;
  const dir = repo(t);
  const file = join(scratch(t, 'gen-parse-step-'), 'step.sh');
  writeFileSync(file, script);
  const step = () => run('bash', ['-e', file], { cwd: dir }); // GitHub runs `run:` with bash -e
  commitFiles(dir, { 'README.md': 'x\n' });
  assert.equal(step().status, 0, out(step()));
  writeFileSync(join(dir, `CODEOWNERS${SIDE}`), 'untracked\n');
  assert.equal(step().status, 0, 'an untracked side file is no failure');
  commitFiles(dir, { [`.github/workflows/ci.yml${SIDE}`]: 'tracked\n' });
  const r = step();
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`\\.github/workflows/ci\\.yml${SIDE.replace(/[.-]/g, '\\$&')}`));
  assert.match(r.stdout, /::error::/);
});

test('pre-push hook: blocks a pushed commit that tracks a side file and a failing gate; runs gates only when commits are pushed', (t) => {
  const dir = repo(t);
  const marks = scratch(t, 'gen-parse-marks-');
  // Quotes in a gate name and command must reach the shell exactly (the name is printed, the command writes "it's").
  const options = { ...gen.DEFAULT_OPTIONS, gates: [{ name: "first 'gate'", cmd: `printf '%s\\n' "it's" >> "$MARKS/first"` }, { name: 'second', cmd: 'test -z "$FAIL_SECOND"' }] };
  const hook = join(scratch(t, 'gen-parse-hook-'), 'pre-push');
  writeFileSync(hook, gen.render(target('pre-push'), options, names));
  chmodSync(hook, 0o755);
  const zeros = '0'.repeat(40);
  // The hook scans each pushed range with the plugin CLI, found by its bin name (no package spec in these options).
  const bin = scratch(t, 'gen-parse-bin-');
  symlinkSync(join(pluginDir, 'bin', names.bin), join(bin, names.bin));
  const PATH = `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`;
  const push = (lines, extraEnv = {}) => run(hook, ['origin', 'https://example.invalid/repo.git'], { cwd: dir, input: lines.map((l) => `${l}\n`).join(''), env: { ...process.env, PATH, MARKS: marks, ...extraEnv } });
  const ran = () => {
    const lines = existsSync(join(marks, 'first')) ? readFileSync(join(marks, 'first'), 'utf8').split('\n').filter(Boolean) : [];
    assert.ok(lines.every((l) => l === "it's"), `the gate command ran unchanged: ${JSON.stringify(lines)}`);
    return lines.length;
  };

  const clean = commitFiles(dir, { 'README.md': 'x\n' });
  let r = push([`refs/heads/main ${clean} refs/heads/main ${zeros}`]);
  assert.equal(r.status, 0, out(r));
  assert.equal(ran(), 1, 'gates ran once');
  assert.match(r.stderr, /^pre-push: gate first 'gate'$/m, 'the gate name reaches the shell unchanged');

  r = push([`refs/heads/main ${clean} refs/heads/main ${zeros}`], { FAIL_SECOND: '1' });
  assert.equal(r.status, 1, `a failing gate blocks the push\n${out(r)}`);
  assert.match(r.stderr, /gate second failed/);

  r = push([`(delete) ${zeros} refs/heads/old ${clean}`]);
  assert.equal(r.status, 0, out(r));
  assert.equal(ran(), 2, 'a branch deletion runs no gate');

  const dirty = commitFiles(dir, { [`CODEOWNERS${SIDE}`]: 'tracked\n' });
  r = push([`refs/heads/main ${dirty} refs/heads/main ${clean}`]);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, new RegExp(`CODEOWNERS${SIDE.replace(/[.-]/g, '\\$&')}`));
  assert.equal(ran(), 2, 'blocked before the gates run');
});

test('the YAML subset parser is strict: it rejects what it cannot read exactly (REV-45: a parser that accepts all proves nothing)', () => {
  assert.deepEqual(parseYaml('a: 1\nb:\n  - x\n  - "y: z"\n  - k: v\n    l: [m, "n"]\nc: |\n  one\n   two\nd: |-\n  e\non:\n  push:\n'), {
    a: 1, b: ['x', 'y: z', { k: 'v', l: ['m', 'n'] }], c: 'one\n two\n', d: 'e', on: { push: null },
  });
  assert.deepEqual(parseYaml("s: 'it''s' # c\nt: \"q \\\" \\\\ q\"\nu: true\nv: ~\nw: a#b\n"), { s: "it's", t: 'q " \\ q', u: true, v: null, w: 'a#b' });
  for (const bad of ['a:\n\t- x\n', 'a: 1\na: 2\n', 'a: yes\n', 'a: on\n', 'a: {b: 1}\n', 'a: &x 1\n', 'a: *x\n', 'a: !t 1\n', 'a:\n  b: 1\n   c: 2\n',
    'a: "x\\q"\n', 'a: "open\n', 'a: b: c\n', 'a: >\n  x\n', '---\na: 1\n', 'a: 1\r\n', 'a: [x, {y}]\n', 'a: "x" y\n', '  a: 1\n', 'a: c:\n']) {
    assert.throws(() => parseYaml(bad), YamlError, JSON.stringify(bad));
  }
});
