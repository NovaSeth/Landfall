// The hard boundaries of spec §7.13 (SD-29, SEC-10) as generated files run them: the pre-push hook scans the range of
// every pushed ref with `secrets --range` before the gates and blocks the push on any exit but 0 (1 findings, 8 the
// scan could not run, 127 the CLI is missing); the CI workflow scans the pull request's commits on pull_request and
// the tree on push. The hook and the workflow are rendered by lib/gen and run for real: pushes to a bare remote, the
// CI step's script under bash -e. The pre-push cases are ported from the 1.x tests/secrets.test.mjs (v1.5.1).
// Every synthetic value is assembled at run time; its source line carries the SYNTH marker (SEC-11).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { parseYaml } from './lib/yaml-subset.mjs';

// git, the hook and the CLI it runs get a throwaway HOME and global config (S1).
isolateProcessEnv();
// The same git, found in its own exec path first: on macOS /usr/bin/git is an xcrun shim that adds a lookup to each of
// the many git calls here (and can fail under load); elsewhere this is the binary PATH already finds.
const GIT_DIR = spawnSync('git', ['--exec-path'], { encoding: 'utf8', env: process.env }).stdout.trim();
if (GIT_DIR && existsSync(join(GIT_DIR, 'git'))) process.env.PATH = `${GIT_DIR}${delimiter}${process.env.PATH}`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const gen = await import(pathToFileURL(join(pluginDir, 'lib', 'gen', 'index.mjs')).href);
const target = (id) => gen.TARGETS.find((x) => x.id === id);

const ghToken = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'; // SYNTH
const SPEC = `github:example-org/example-repo#${names.plugin}--v2.0.0`;

const scratch = (t, prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const git = (d, ...a) => {
  const r = spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function repo(t) {
  const d = scratch(t, 'secrets-hook-');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'commit.gpgsign', 'false');
  return d;
}
const put = (d, file, content) => {
  mkdirSync(dirname(join(d, file)), { recursive: true });
  writeFileSync(join(d, file), content);
};
const commit = (d, file, content) => {
  if (content === null) rmSync(join(d, file)); else put(d, file, content);
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', `change ${file}`);
};
const out = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const noLeak = (r, ...values) => {
  for (const v of values) assert.ok(!(r.stdout + r.stderr).includes(v), `a secret value in the output: ${v.slice(0, 4)}…`);
};

// A PATH where the plugin CLI is found by its bin name, as a generated file without a package spec calls it; with npx,
// also a stand-in for `npx --yes --package <spec> <bin> …` that runs that bin (no network in tests).
function cliPath(t, { npx = false } = {}) {
  const bin = scratch(t, 'secrets-bin-');
  symlinkSync(LAUNCHER, join(bin, names.bin));
  if (npx) {
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\n[ "$1" = --yes ] && [ "$2" = --package ] && [ "$3" = '${SPEC}' ] || exit 97\nshift 3\nexec "$@"\n`);
    chmodSync(join(bin, 'npx'), 0o755);
  }
  return `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`;
}

// A clone with a bare remote whose pre-push hook is the generated one (core.hooksPath), as after `gen apply`.
function pushRepo(t, { gates = [] } = {}) {
  const remote = scratch(t, 'secrets-remote-');
  git(remote, 'init', '-q', '--bare');
  const d = repo(t);
  const hooks = scratch(t, 'secrets-hooks-');
  writeFileSync(join(hooks, 'pre-push'), gen.render(target('pre-push'), { ...gen.DEFAULT_OPTIONS, gates }, names));
  chmodSync(join(hooks, 'pre-push'), 0o755);
  git(d, 'remote', 'add', 'origin', remote);
  git(d, 'config', 'core.hooksPath', hooks);
  commit(d, 'src/a.ts', 'export const x = 1;\n');
  return { d, remote, PATH: cliPath(t) };
}
const push = (ctx, args, env = {}) => spawnSync('git', ['-C', ctx.d, 'push', '-q', 'origin', ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: ctx.PATH, ...env } });

test('pre-push: a secret added and removed by the next commit blocks the push; a clean push passes', (t) => {
  const ctx = pushRepo(t);
  let r = push(ctx, ['main']);
  assert.equal(r.status, 0, `a clean push: ${out(r)}`);

  commit(ctx.d, 'src/b.ts', `const t = "${ghToken}";\n`);
  const added = git(ctx.d, 'rev-parse', 'HEAD').slice(0, 12);
  commit(ctx.d, 'src/b.ts', null);
  r = push(ctx, ['main']);
  assert.notEqual(r.status, 0, `the secret is in the history of the range: ${out(r)}`);
  assert.match(r.stderr, /secrets scan of refs\/heads\/main exited 1.*push blocked/);
  assert.match(r.stdout + r.stderr, new RegExp(`${added}:src/b\\.ts:1: github-token`));
  noLeak(r, ghToken, ghToken.slice(4, 14));
  assert.notEqual(git(ctx.remote, 'rev-parse', 'main'), git(ctx.d, 'rev-parse', 'main'), 'the remote is unchanged');

  git(ctx.d, 'reset', '-q', '--hard', 'origin/main');
  commit(ctx.d, 'src/c.ts', 'export const y = 2;\n');
  r = push(ctx, ['main']);
  assert.equal(r.status, 0, out(r));
});

test('pre-push: a secret committed and fixed only in the working tree blocks the push', (t) => {
  const ctx = pushRepo(t);
  assert.equal(push(ctx, ['main']).status, 0);
  commit(ctx.d, 'src/b.ts', `const t = "${ghToken}";\n`);
  put(ctx.d, 'src/b.ts', 'ok\n');
  const r = push(ctx, ['main']);
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stdout + r.stderr, /src\/b\.ts:1/);
});

test('pre-push: a new branch scans only the commits on no remote branch; deleting a branch passes', (t) => {
  const ctx = pushRepo(t);
  commit(ctx.d, 'old.ts', `const t = "${ghToken}";\n`);
  assert.equal(push(ctx, ['--no-verify', 'main']).status, 0, 'history the remote held before the hook was enabled');
  git(ctx.d, 'checkout', '-qb', 'feat');
  commit(ctx.d, 'apps/web/.env', 'PORT=1\n');
  let r = push(ctx, ['feat']);
  assert.notEqual(r.status, 0, `an env file added in the new branch: ${out(r)}`);
  assert.match(r.stdout + r.stderr, /apps\/web\/\.env: key-file/);
  git(ctx.d, 'reset', '-q', '--hard', 'main');
  commit(ctx.d, 'src/d.ts', 'export const z = 3;\n');
  r = push(ctx, ['feat']);
  assert.equal(r.status, 0, `the key already on the remote is not in the new branch's range: ${out(r)}`);
  r = push(ctx, ['--delete', 'feat']);
  assert.equal(r.status, 0, out(r));
});

test('pre-push: the scan runs before the gates; a scan that cannot run (8) or a missing CLI blocks the push', (t) => {
  const marks = join(scratch(t, 'secrets-marks-'), 'gate');
  const ctx = pushRepo(t, { gates: [{ name: 'mark', cmd: 'echo ran >> "$MARKS"' }] });
  const ran = () => (existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0);
  let r = push(ctx, ['main'], { MARKS: marks });
  assert.equal(r.status, 0, out(r));
  assert.equal(ran(), 1, 'the gate ran once');

  commit(ctx.d, 'src/b.ts', `const t = "${ghToken}";\n`);
  r = push(ctx, ['main'], { MARKS: marks });
  assert.notEqual(r.status, 0, out(r));
  assert.equal(ran(), 1, 'blocked before the gates run');
  git(ctx.d, 'reset', '-q', '--hard', 'origin/main');

  commit(ctx.d, 'src/c.ts', 'export const y = 2;\n');
  put(ctx.d, `${names.stateDir}/secrets-patterns.txt`, 'broken_[\n');
  r = push(ctx, ['main'], { MARKS: marks });
  assert.notEqual(r.status, 0, `an invalid project pattern makes the scan invalid: ${out(r)}`);
  assert.match(r.stderr, /exited 8/);
  rmSync(join(ctx.d, names.stateDir), { recursive: true });

  r = push(ctx, ['main'], { MARKS: marks, PATH: [GIT_DIR, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) });
  assert.notEqual(r.status, 0, `the CLI is not on PATH: ${out(r)}`);
  assert.match(r.stderr, /exited 127/);
  assert.equal(ran(), 1, 'no gate ran after a failed scan');

  r = push(ctx, ['main'], { MARKS: marks });
  assert.equal(r.status, 0, out(r));
  assert.equal(ran(), 2);
});

// The CI workflow for each combination of gates, branch and package spec; the plugin CLI runs in CI only through npx
// with a package spec (SD-21), so the secrets step exists exactly when one is given.
const COMBINATIONS = [[], [{ name: 'test', cmd: 'npm test' }]].flatMap((gates) => ['main', 'release/v2.x'].flatMap((branch) => [undefined, SPEC].map((pkg) => ({ ...gen.DEFAULT_OPTIONS, gates, branch, ...(pkg ? { package: pkg } : {}) }))));
const scanStep = (doc) => doc.jobs.process.steps.filter((s) => s.name === 'secrets scan');

test('CI workflow: a secrets scan step with a package spec, after a full-history checkout; strict YAML for every combination', () => {
  for (const o of COMBINATIONS) {
    const doc = parseYaml(gen.render(target('ci'), o, names));
    const at = `gates=${o.gates.length} branch=${o.branch} package=${o.package ?? '-'}`;
    const steps = scanStep(doc);
    assert.equal(steps.length, o.package ? 1 : 0, at);
    const checkout = doc.jobs.process.steps[0];
    assert.equal(checkout.with['fetch-depth'], o.package ? 0 : undefined, `${at}: the range needs the history`);
    if (!o.package) continue;
    const [step] = steps;
    assert.deepEqual(step.env, { EVENT: '${{ github.event_name }}', BASE_SHA: '${{ github.event.pull_request.base.sha }}', HEAD_SHA: '${{ github.event.pull_request.head.sha }}' }, at);
    const cli = `npx --yes --package '${o.package}' ${names.bin} secrets`;
    assert.ok(step.run.includes(`${cli} --range "$BASE_SHA..$HEAD_SHA"\n`) && step.run.includes(`${cli}\n`), `${at}\n${step.run}`);
    assert.ok(!/\$\{\{/.test(step.run), `${at}: no expression in the script (values come through env)`);
    const order = doc.jobs.process.steps.map((s) => s.name ?? 'checkout');
    assert.ok(order.indexOf('secrets scan') > 0, `${at}: after the checkout`);
  }
});

test('CI step: pull_request scans the commits of the pull request, push the tree; a finding or an invalid scan fails it', (t) => {
  const doc = parseYaml(gen.render(target('ci'), { ...gen.DEFAULT_OPTIONS, package: SPEC }, names));
  const file = join(scratch(t, 'secrets-step-'), 'step.sh');
  writeFileSync(file, scanStep(doc)[0].run);
  const d = repo(t);
  const PATH = cliPath(t, { npx: true });
  const step = (env) => spawnSync('bash', ['-e', file], { cwd: d, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH, ...env } }); // GitHub runs `run:` with bash -e
  commit(d, 'a.ts', 'ok\n');
  commit(d, 'old.ts', `const t = "${ghToken}";\n`);
  commit(d, 'old.ts', null);
  const base = git(d, 'rev-parse', 'HEAD');
  commit(d, 'b.ts', 'clean\n');
  const pr = (head) => ({ EVENT: 'pull_request', BASE_SHA: base, HEAD_SHA: head });
  let r = step(pr(git(d, 'rev-parse', 'HEAD')));
  assert.equal(r.status, 0, `the key before the base is outside the pull request: ${out(r)}`);
  commit(d, 'c.ts', `const t = "${ghToken}";\n`);
  commit(d, 'c.ts', null);
  r = step(pr(git(d, 'rev-parse', 'HEAD')));
  assert.equal(r.status, 1, `a key added and removed in the pull request: ${out(r)}`);
  noLeak(r, ghToken);
  r = step({ EVENT: 'push', BASE_SHA: '', HEAD_SHA: '' });
  assert.equal(r.status, 0, `push: the tree is clean: ${out(r)}`);
  put(d, 'd.ts', `const t = "${ghToken}";\n`);
  r = step({ EVENT: 'push', BASE_SHA: '', HEAD_SHA: '' });
  assert.equal(r.status, 1, `push: a key in the tree: ${out(r)}`);
  r = step(pr('0'.repeat(40)));
  assert.equal(r.status, 8, `a head the clone does not have: ${out(r)}`);
});
