// `gen apply` writes only the paths its targets declare, never inside .git (audit of 2.4.0, E1), and the CI
// workflow takes no expression in a gate command and no mutable ref but the release tag or a commit (G3).
// The manifest of a cloned repository is data: its paths are checked against the targets, never trusted alone.
// This file never spells the codename: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
const pluginDir = join(plugins, hits[0]);
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const gen = await import(pathToFileURL(join(pluginDir, 'lib', 'gen', 'index.mjs')).href);
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const REAL = (id) => gen.TARGETS.find((x) => x.id === id);
const AT = '2026-01-01T00:00:00.000Z';

const cli = (args, cwd) => spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', timeout: 60000, env: process.env, cwd });
const show = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

function repoWith(t, { flags = {}, manifest = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gen-paths-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, env: process.env }).status, 0);
  const store = gen.openStore(join(dir, names.stateDir), names);
  store.write('state', null, { codename: names.codename, createdWith: PLUGIN_VERSION, activatedAt: AT });
  if (Object.keys(flags).length) store.write('config', null, { flags });
  if (manifest) store.write('generated', null, { files: manifest });
  return { dir, store };
}
const entry = (target) => ({ target, template: 'x', templateVersion: PLUGIN_VERSION, baseSha256: null, generatedAt: AT, side: null, base: null });
const envelope = (r) => JSON.parse(r.stdout.trim().split('\n').at(-1));

test('E1: a manifest path inside .git (the reproduction) is refused; nothing is written', (t) => {
  const hook = '.git/hooks/reference-transaction';
  const { dir } = repoWith(t, { manifest: { [hook]: entry('pre-push') } });
  const r = cli(['gen', 'apply', '--yes', '--json'], dir);
  assert.equal(r.status, 1, show(r));
  const e = envelope(r);
  assert.deepEqual(e.errors.map((x) => x.code), ['manifest-path-refused'], show(r));
  assert.ok(e.errors[0].message.includes(hook), e.errors[0].message);
  assert.ok(!existsSync(join(dir, hook)), 'no hook appeared');
  // Naming a target does not help, nor does a dry run.
  for (const args of [['gen', 'apply', 'pre-push', '--yes', '--json'], ['gen', 'apply', 'ci', '--yes', '--json'], ['gen', 'plan', '--json']]) {
    const x = cli(args, dir);
    assert.equal(x.status, 1, show(x));
    assert.ok(!existsSync(join(dir, hook)));
  }
});

test('E1: a manifest path that is not a path of its target is refused (also a bad one of another target)', (t) => {
  for (const path of ['docs/evil.md', '.githooks/other', '.GIT/hooks/x', 'a/.Git/x', '.git', 'sub/.git']) {
    const { dir } = repoWith(t, { flags: { 'ci-gate': 'on' }, manifest: { [path]: entry('pre-push') } });
    const r = cli(['gen', 'apply', 'ci', '--yes', '--json'], dir);
    assert.equal(r.status, 1, `${path}\n${show(r)}`);
    assert.deepEqual(envelope(r).errors.map((x) => x.code), ['manifest-path-refused'], path);
    if (path !== '.git') assert.ok(!existsSync(join(dir, ...path.split('/'))), path);
    assert.ok(!existsSync(join(dir, '.github')), 'nothing else was written either');
  }
});

test('E1: applyGen refuses an item path with a .git component; targetItems refuses a manifest path its target does not declare', (t) => {
  const { dir, store } = repoWith(t);
  const run = (target, path) => gen.applyGen({ root: dir, store, names, version: PLUGIN_VERSION, items: [{ target, path, theirs: 'x\n' }], now: () => AT });
  const ci = REAL('ci');
  for (const path of ['.git/hooks/reference-transaction', '.GIT/config', 'x/.git', '/etc/x', '../x', 'a\\b', 'a\0b', '']) {
    assert.throws(() => run(ci, path), (err) => err.code === 'manifest-path-refused' && err.message.includes(JSON.stringify(path).slice(1, -1).slice(0, 5)), path);
  }
  assert.ok(!existsSync(join(dir, '.git', 'hooks', 'reference-transaction')));
  assert.equal(run(ci, ci.path(names)).ok, true);
  // The manifest: a path the target declares (CODEOWNERS also its locations) is accepted, any other is refused.
  const items = (path, id) => {
    store.write('generated', null, { files: { [path]: entry(id) } });
    return gen.targetItems({ root: dir, store, names, options: gen.DEFAULT_OPTIONS, targets: [REAL(id)] });
  };
  assert.equal(items('docs/CODEOWNERS', 'codeowners')[0].path, 'docs/CODEOWNERS');
  assert.throws(() => items('docs/x', 'codeowners'), (err) => err.code === 'manifest-path-refused' && err.exit === 'FAIL');
  assert.throws(() => items('.git/hooks/pre-commit', 'pre-push'), (err) => err.code === 'manifest-path-refused');
});

test('E1: a parent directory that is a symbolic link out of the repository stops the target', (t) => {
  const { dir } = repoWith(t, { flags: { 'ci-gate': 'on' } });
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'gen-paths-out-')));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  symlinkSync(out, join(dir, '.github'));
  const r = cli(['gen', 'apply', 'ci', '--yes', '--json'], dir);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(envelope(r).errors.map((x) => x.code), ['manifest-path-refused']);
  assert.deepEqual(readdirSync(out), [], 'nothing was written through the link');
});

test('E1: a normal apply still works and records the path of the target', (t) => {
  const { dir, store } = repoWith(t, { flags: { 'ci-gate': 'on' } });
  const r = cli(['gen', 'apply', '--yes', '--json'], dir);
  assert.equal(r.status, 0, show(r));
  assert.deepEqual(Object.keys(store.read('generated', null).files), [REAL('ci').path(names)]);
  assert.equal(cli(['gen', 'apply', '--yes', '--json'], dir).status, 0);
});

test('G3: a gate command with a GitHub Actions expression is refused when the workflow renders, naming the gate', () => {
  const options = { ...gen.DEFAULT_OPTIONS, gates: [{ name: 'title-check', cmd: 'echo ${{ github.event.pull_request.title }}' }] };
  assert.ok(gen.checkOptions(options).length > 0);
  assert.throws(() => gen.render(REAL('ci'), options, names), /title-check/);
  assert.doesNotThrow(() => gen.render(REAL('ci'), { ...options, gates: [{ name: 'title-check', cmd: 'echo "$TITLE" $GITHUB_SHA' }] }, names));
});

test('G3: the package ref is the release tag or a 40-hex commit; anything else is refused', () => {
  const sha = 'a'.repeat(40);
  const spec = (ref) => `${names.repository}#${ref}`;
  const ok = (pkg) => gen.checkOptions({ ...gen.DEFAULT_OPTIONS, package: pkg }).length === 0;
  assert.ok(ok(gen.packageSpec(names, '2.4.0')));
  assert.equal(gen.packageSpec(names, '2.4.0'), spec(`${names.plugin}--v2.4.0`), 'the default stays');
  assert.ok(ok(gen.packageSpec(names, '2.4.0', sha)));
  assert.equal(gen.packageSpec(names, '2.4.0', sha), spec(sha));
  for (const ref of ['main', 'v2.4.0', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${names.plugin}--v2`, `${names.plugin}--v2.4.0/x`, 'feature/x']) {
    assert.ok(!ok(spec(ref)), ref);
  }
  assert.throws(() => gen.packageSpec(names, '2.4.0', 'abc'), /commit/);
  const out = gen.render(REAL('ci'), { ...gen.DEFAULT_OPTIONS, package: gen.packageSpec(names, '2.4.0', sha) }, names);
  assert.ok(out.includes(`'${names.repository}#${sha}'`), 'the npx spec carries #<sha>');
  assert.throws(() => gen.render(REAL('ci'), { ...gen.DEFAULT_OPTIONS, package: spec('main') }, names), /options/);
});

test('F1 (review): a manifest target that is neither named nor enabled by default is refused, also an unknown one; nothing is written', (t) => {
  const hook = REAL('pre-push').path(names);
  for (const [id, path] of [['pre-push', hook], ['no-such-target', 'docs/x.md']]) {
    for (const args of [['gen', 'apply', '--yes', '--json'], ['gen', 'apply', 'ci', '--yes', '--json']]) {
      const { dir } = repoWith(t, { flags: { 'ci-gate': 'on' }, manifest: { [path]: entry(id) } });
      const r = cli(args, dir);
      assert.equal(r.status, 1, `${id} ${args.join(' ')}\n${show(r)}`);
      assert.deepEqual(envelope(r).errors.map((x) => x.code), ['manifest-path-refused'], show(r));
      assert.ok(!existsSync(join(dir, ...hook.split('/'))), 'no hook');
      assert.ok(!existsSync(join(dir, '.github')), 'nothing else written');
    }
  }
  // Named, or enabled by default: accepted.
  const named = repoWith(t, { manifest: { [hook]: entry('pre-push') } });
  assert.equal(cli(['gen', 'apply', 'pre-push', '--yes', '--json'], named.dir).status, 0);
  const on = repoWith(t, { flags: { 'pre-push': 'on' }, manifest: { [hook]: entry('pre-push') } });
  assert.equal(cli(['gen', 'apply', '--yes', '--json'], on.dir).status, 0);
});

test('F2 (review): an escaping symbolic link stops the whole run; a safe target of the same run is not written either', (t) => {
  const { dir, store } = repoWith(t, { flags: { 'ci-gate': 'on', 'pre-push': 'on' } });
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'gen-paths-out-')));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  symlinkSync(out, join(dir, '.github'));
  const r = cli(['gen', 'apply', 'ci', 'pre-push', '--yes', '--json'], dir);
  assert.equal(r.status, 1, show(r));
  assert.ok(envelope(r).errors.some((x) => x.code === 'manifest-path-refused'), show(r));
  assert.ok(!existsSync(join(dir, '.githooks', 'pre-push')), 'the safe target was not written');
  assert.deepEqual(readdirSync(out), []);
  assert.equal(store.read('generated', null), null, 'the record was not touched');
  // The library: the same, in one call.
  const items = gen.targetItems({ root: dir, store, names, options: gen.DEFAULT_OPTIONS, targets: [REAL('ci'), REAL('pre-push')] });
  const rep = gen.applyGen({ root: dir, store, names, version: PLUGIN_VERSION, items, now: () => AT });
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.written, []);
  assert.ok(!existsSync(join(dir, '.githooks', 'pre-push')));
});

test('F3 (review): --commit <40-hex> pins the npx spec of the generated workflow; a bad value is a usage error', (t) => {
  const sha = 'b'.repeat(40);
  const { dir } = repoWith(t, { flags: { 'ci-gate': 'on' } });
  for (const bad of ['main', 'abc', 'B'.repeat(40), 'b'.repeat(41)]) {
    const x = cli(['gen', 'apply', 'ci', '--commit', bad, '--dry-run', '--json'], dir);
    assert.equal(x.status, 2, `${bad}\n${show(x)}`);
    assert.ok(!existsSync(join(dir, '.github')));
  }
  assert.equal(cli(['gen', 'plan', 'ci', '--commit', sha, '--json'], dir).status, 0);
  const r = cli(['gen', 'apply', 'ci', '--commit', sha, '--yes', '--json'], dir);
  assert.equal(r.status, 0, show(r));
  const wf = readFileSync(join(dir, REAL('ci').path(names)), 'utf8');
  assert.ok(wf.includes(`${names.repository}#${sha}`), 'the workflow carries #<sha>');
  assert.ok(!wf.includes(`#${names.plugin}--v`));
});
