// Code health in verify (T-MG-188): each changed source file is judged against its version at the task base (no
// baseline, no bootstrap). Growth past the hard limits fails verify (a file over 800 lines that grew, a new or grown
// function over 120 lines); growth past the soft limits warns (a file crossing 500 lines, a function over 80); a file
// that shrinks is never flagged; tests and generated files are exempt. One `code health:` line in verify's output.
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
  return join(plugins, readdirSync(plugins).find((d) => existsSync(join(plugins, d, 'lib', 'name.json'))));
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { healthOf, healthLine } = await lib('verify/health.mjs');
const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));

const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const fn = (name, n) => `export function ${name}(a) {\n${'  a += 1;\n'.repeat(n - 2)}}\n`;
const levels = (files) => healthOf(files).map((o) => `${o.level} ${o.path}${o.name ? ` ${o.name}` : ''}`);

test('a file growing past the hard limit fails; crossing the soft limit warns; shrinking passes silently', () => {
  assert.deepEqual(levels([{ path: 'src/a.mjs', before: lines(790), after: lines(810) }]), ['fail src/a.mjs']);
  assert.deepEqual(levels([{ path: 'src/b.py', before: lines(450), after: lines(520) }]), ['warn src/b.py']);
  assert.deepEqual(levels([{ path: 'src/c.mjs', before: lines(900), after: lines(880) }]), []);
  assert.deepEqual(levels([{ path: 'src/d.go', before: null, after: lines(801) }]), ['fail src/d.go'], 'a new file over 800 grew from nothing');
});

test('tests, generated files and non-source files are exempt', () => {
  assert.deepEqual(levels([
    { path: 'tests/big.test.mjs', before: lines(790), after: lines(900) },
    { path: 'src/x.test.ts', before: null, after: lines(900) },
    { path: 'package-lock.json', before: null, after: lines(900) },
    { path: 'docs/guide.md', before: null, after: lines(900) },
  ]), []);
  const light = (p) => p.startsWith('gen/');
  assert.deepEqual(healthOf([{ path: 'gen/hooks.mjs', before: null, after: lines(900) }], undefined, light), [], "the owner's light paths hold generated files (D-MG-31)");
});

test('a new function over 120 lines fails, one over 80 warns; a function that did not grow is not flagged', () => {
  assert.deepEqual(levels([{ path: 'src/f.mjs', before: '', after: fn('huge', 130) }]), ['fail src/f.mjs huge']);
  assert.deepEqual(levels([{ path: 'src/f.mjs', before: '', after: fn('long', 85) }]), ['warn src/f.mjs long']);
  assert.deepEqual(levels([{ path: 'src/f.mjs', before: fn('old', 130), after: `${fn('old', 130)}export const y = 1;\n` }]), []);
  assert.deepEqual(levels([{ path: 'src/f.mjs', before: fn('old', 125), after: fn('old', 126) }]), ['fail src/f.mjs old'], 'a grown function over 120');
  const arrow = `export const run = async ({ a = {}, b }) => {\n${'  b();\n'.repeat(90)}};\n`;
  assert.deepEqual(levels([{ path: 'src/g.ts', before: null, after: arrow }]), ['warn src/g.ts run'], 'braces inside the parameters do not end the body');
});

test('healthLine names every offender and the module to split', () => {
  const line = healthLine(healthOf([{ path: 'src/a.mjs', before: lines(790), after: lines(810) }]));
  assert.match(line, /^code health: /);
  assert.match(line, /src\/a\.mjs 810 lines \(was 790/);
  assert.match(line, /split or refactor src\/a\.mjs/);
  assert.equal(healthLine([]), null);
});

function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-health-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  mkdirSync(join(base, 'home'));
  const env = { ...ISO.env, HOME: join(base, 'home') };
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  write('calc.test.mjs', "import { test } from 'node:test';\ntest('adds', () => {});\n");
  write('src/a.mjs', lines(790));
  write('src/b.mjs', lines(450));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: '2026-11-05T00:00:00.000Z' });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: '2026-11-05T00:00:00.000Z' }).handle;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }] });
  const id = state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'standard', classHistory: [], status: 'dispatched', round: 0, events: [], base: head, branch: null }),
  });
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  return { dir, env, id, git, write };
}

async function cli(args, { dir, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main(args, { io });
  return { code, text: out.join('') };
}

test('verify prints one code health line and fails with code-health only for growth past a hard limit', async (t) => {
  const r = repo(t);
  r.write('src/a.mjs', lines(810));
  r.write('src/b.mjs', lines(520));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'grow');
  const json = await cli(['verify', r.id, '--ci', '--yes', '--json'], r);
  const env = JSON.parse(json.text);
  const health = env.errors.filter((e) => e.code === 'code-health');
  assert.equal(health.length, 1, json.text);
  assert.match(health[0].message, /src\/a\.mjs 810 lines/);
  assert.equal(json.code, 1);
  const text = await cli(['verify', r.id, '--ci', '--yes'], r);
  const shown = text.text.split('\n').filter((l) => l.startsWith('code health:'));
  assert.equal(shown.length, 1, text.text);
  assert.match(shown[0], /fail src\/a\.mjs 810 lines.*warn src\/b\.mjs 520 lines/);
});

test('a change that only warns adds no code-health error', async (t) => {
  const r = repo(t);
  r.write('src/b.mjs', lines(520));
  r.write('src/a.mjs', lines(700));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'grow b, shrink a');
  const env = JSON.parse((await cli(['verify', r.id, '--ci', '--yes', '--json'], r)).text);
  assert.deepEqual(env.errors.filter((e) => e.code === 'code-health'), []);
  assert.deepEqual(env.data.health.map((o) => `${o.level} ${o.path}`), ['warn src/b.mjs']);
});

test('the implementer brief template names the code health check in its gate', () => {
  const brief = readFileSync(join(pluginDir, 'templates', 'task', 'brief.md'), 'utf8');
  assert.equal(brief.split('\n').filter((l) => /code health/.test(l)).length, 1);
});
