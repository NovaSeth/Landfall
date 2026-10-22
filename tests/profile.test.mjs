// Project profile (spec §7.3, §7.4a, §5.1, SD-12, N3): facts under the keys fixed in lib/profile/keys.mjs, each
// with value, source (said | observed | default), evidence, confidence and time; the observation scan of
// repository signals (≤ 2 s on a 10k-file fixture, cached by HEAD); the question bank (asks only what changes the
// process, capped at 3 on activation and 1 per later session); `said` facts outrank observation; the update
// triggers; `<bin> profile show|observe|set` through the real command table in throwaway repositories and HOME.
// Method pack activation (lib/method activePacks) reads exactly the profile keys.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
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
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const profile = await lib('profile/index.mjs');
const { DEFAULT_RISK_PATHS } = await lib('router/index.mjs');
const { KINDS } = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS, EXIT } = await lib('cli/commands.mjs');
const { activePacks, openMethod } = await lib('method/index.mjs');
const AT = '2026-10-15T05:42:00.000Z';
const DAY = 86400000;
const OLD = '2026-01-01T00:00:00.000Z'; // a said fact far more than 14 days before any run of this file
const PACKS = openMethod().index.packs;

// ---- fixtures ----

const put = (dir, rel, value) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};
function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, env: ISO.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(dir, message = 'change') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
// A throwaway repository; active: the state directory holds state.json and the .gitignore activation writes.
function repo(t, { active = true, files = {} } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'profile-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  const store = join(dir, names.stateDir);
  if (active) {
    put(store, 'state.json', { schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
    put(store, '.gitignore', 'local/\n');
  }
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
  return { base, dir, store };
}
const readProfile = (store) => JSON.parse(readFileSync(join(store, 'profile.json'), 'utf8'));
// Every file under dir except .git, with content hashes.
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (!rel && name === '.git') continue;
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}
async function cli(args, { dir, tty = false, yes = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env: ISO.env, cwd: dir };
  const code = await main([...args, ...(yes ? ['--yes'] : []), '--json'], { io });
  assert.equal(err.join(''), '', '--json keeps stderr empty');
  const env = JSON.parse(out.join(''));
  assert.equal(env.code, code);
  return { code, env, data: env.data, error: env.errors[0]?.code };
}
const said = (value, at = AT, evidence = 'the user said so') => ({ value, source: 'said', evidence, confidence: 1, at });

// A web project: npm scripts (pnpm), TypeScript, UI files, migrations, GitHub Actions, two other harnesses,
// a CLI entry and package exports (public API), an auth directory.
const WEB = {
  'package.json': {
    name: 'web-app',
    bin: { tool: './bin/tool.js' },
    exports: { '.': './lib/index.js', './sub/*': './lib/sub/*.js' },
    scripts: { dev: 'vite', build: 'tsc -p .', test: 'node --test', typecheck: 'tsc --noEmit', lint: 'eslint .' },
    devDependencies: { typescript: '5.6.0' },
  },
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'tsconfig.json': '{}\n',
  'bin/tool.js': '#!/usr/bin/env node\n',
  'lib/index.js': 'export {};\n',
  'src/App.tsx': 'export const App = () => null;\n',
  'src/auth/login.ts': 'export {};\n',
  'db/migrations/001_init.sql': 'create table t (id int);\n',
  '.github/workflows/ci.yml': 'on: push\n',
  'AGENTS.md': '# Agents\n',
  '.cursor/rules.md': 'rules\n',
  'docs/templates/page.md': 'not a UI template\n',
};

// ---- keys ----

test('the profile keys are the spec §7.3 list, fixed in keys.mjs; the deployment fact is deployedToUsers (§7.4a)', () => {
  assert.deepEqual(profile.KEYS, ['goal', 'productKind', 'phase', 'people', 'ui', 'backend', 'dataSensitivity', 'deployedToUsers', 'deadline', 'stack', 'ci', 'otherHarnesses', 'riskGlobs', 'reviewFocus', 'gates', 'riskPaths']);
  assert.ok(!profile.KEYS.includes('deployed'), '`deployed` is not a key (§7.4a)');
  const F = profile.FACT_KEYS;
  assert.deepEqual(Object.keys(F), profile.KEYS.filter((k) => k !== 'gates' && k !== 'riskPaths'), 'gates and riskPaths are profile fields of their own (§5.1)');
  assert.deepEqual([F.riskGlobs.type, F.reviewFocus.type], ['globs', 'notes'], 'the said risk globs and the review focus (retro 2026-10)');
  assert.deepEqual(profile.parseValue('riskGlobs', 'client/src/ai/**, server/src/{hosts,webhooks}.ts'), ['client/src/ai/**', 'server/src/{hosts,webhooks}.ts']);
  assert.deepEqual(profile.parseValue('reviewFocus', 'maskedIds and hiddenIds in private mode, LAN-only webhooks'), ['maskedIds and hiddenIds in private mode', 'LAN-only webhooks']);
  for (const [k, raw] of [['riskGlobs', 'a b/**'], ['riskGlobs', ''], ['reviewFocus', ''], ['riskGlobs', 'x/**, x/**']]) {
    assert.throws(() => profile.parseValue(k, raw), (e) => e.exit === 'USAGE' && e.code === 'invalid-value', `${k}=${raw}`);
  }
  assert.deepEqual(F.productKind.of, ['library', 'cli', 'web', 'mobile', 'service', 'data', 'other']);
  assert.deepEqual(F.phase.of, ['idea', 'building', 'live']);
  assert.deepEqual(F.people.of, ['solo', 'small-team', 'large-team']);
  assert.deepEqual(F.dataSensitivity.of, ['none', 'personal', 'payment', 'health']);
  for (const k of ['ui', 'backend', 'deployedToUsers']) assert.equal(F[k].type, 'bool', k);
  for (const k of ['stack', 'otherHarnesses']) assert.equal(F[k].type, 'list', k);
  assert.equal(F.deadline.type, 'date');
  // Typed values from command-line text.
  assert.equal(profile.parseValue('deployedToUsers', 'yes'), true);
  assert.equal(profile.parseValue('ui', 'false'), false);
  assert.deepEqual(profile.parseValue('stack', 'Node, TypeScript'), ['node', 'typescript']);
  assert.equal(profile.parseValue('deadline', '2026-12-01'), '2026-12-01');
  for (const [k, raw] of [['deadline', '2026-02-30'], ['deadline', 'soon'], ['ui', 'maybe'], ['phase', 'done'], ['goal', ''], ['goal', 'x'.repeat(201)], ['stack', 'a,,b'], ['ci', 'Git Hub']]) {
    assert.throws(() => profile.parseValue(k, raw), (e) => e.exit === 'USAGE' && e.code === 'invalid-value' && e.hint.length > 0, `${k}=${raw}`);
  }
  assert.throws(() => profile.parseValue('deployed', 'true'), (e) => e.exit === 'USAGE' && e.code === 'unknown-key');
});

test('method pack activation (activePacks) reads exactly the profile keys, with values those keys accept', () => {
  const ENGINE_SIGNALS = ['incidents30', 'tier']; // spec §7.4 engine signals, not profile facts
  const used = [...new Set(Object.values(PACKS).flatMap((p) => p.any.map((c) => c.key)))].sort();
  const fromProfile = used.filter((k) => !ENGINE_SIGNALS.includes(k));
  assert.deepEqual(fromProfile, ['backend', 'dataSensitivity', 'deployedToUsers', 'phase', 'ui']);
  for (const k of fromProfile) assert.ok(Object.hasOwn(profile.FACT_KEYS, k), `${k} is a profile key`);
  for (const k of ENGINE_SIGNALS) assert.ok(!profile.KEYS.includes(k), `${k} is not a profile key`);
  for (const [name, pack] of Object.entries(PACKS)) {
    for (const c of pack.any.filter((x) => !ENGINE_SIGNALS.includes(x.key))) {
      const values = 'is' in c ? [c.is] : [...c.in, ...(c.off ?? [])];
      for (const v of values) assert.ok(profile.validValue(c.key, v), `${name}: ${c.key} accepts ${JSON.stringify(v)}`);
    }
  }
  // Facts → pack inputs: values only, each key as stored.
  const doc = { facts: { deployedToUsers: said(true), ui: said(true), dataSensitivity: said('payment'), phase: said('idea'), backend: said(false), goal: said('a shop') } };
  assert.deepEqual(profile.factValues(doc), { deployedToUsers: true, ui: true, dataSensitivity: 'payment', phase: 'idea', backend: false, goal: 'a shop' });
  assert.deepEqual(activePacks(PACKS, profile.factValues(doc)).sort(), ['design-system', 'discovery', 'release', 'runbooks', 'security']);
  assert.deepEqual(activePacks(PACKS, profile.factValues({ facts: {} })), []);
});

// ---- observation ----

test('observe: manifests give stack and gate candidates; files give UI, backend, CI, harnesses; risk globs include the public API', (t) => {
  const { dir } = repo(t, { active: false, files: WEB });
  commit(dir);
  const o = profile.observe(dir, { env: ISO.env });
  assert.deepEqual(o.facts.stack, { value: ['node', 'typescript'], evidence: 'package.json, tsconfig.json', confidence: 0.9 });
  assert.deepEqual(o.facts.ui, { value: true, evidence: 'src/App.tsx', confidence: 0.7 });
  assert.deepEqual(o.facts.backend, { value: true, evidence: 'db/migrations/001_init.sql', confidence: 0.7 });
  assert.deepEqual(o.facts.ci, { value: 'github-actions', evidence: '.github/workflows/ci.yml', confidence: 0.9 });
  assert.deepEqual(o.facts.otherHarnesses, { value: ['agents-md', 'cursor'], evidence: '.cursor/, AGENTS.md', confidence: 0.9 });
  assert.deepEqual(Object.keys(o.facts).sort(), ['backend', 'ci', 'otherHarnesses', 'stack', 'ui'], 'only what the repository shows');
  assert.deepEqual(o.gates, [
    { name: 'test', cmd: 'NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" pnpm run test', timeoutS: 1800, kind: 'test' }, // node:test reports TAP to verify
    { name: 'lint', cmd: 'pnpm run lint', timeoutS: 1800, kind: 'lint' },
    { name: 'typecheck', cmd: 'pnpm run typecheck', timeoutS: 1800, kind: 'typecheck' },
    { name: 'build', cmd: 'pnpm run build', timeoutS: 1800, kind: 'build' },
  ]);
  assert.deepEqual(o.riskPaths, [...DEFAULT_RISK_PATHS, 'bin/**', 'lib/**', 'lib/sub/**'], 'the router defaults (one list, INT-1) plus the entry points');
  assert.equal(profile.DEFAULT_RISK_GLOBS, undefined, 'the profile keeps no default list of its own');
  assert.equal(o.files, Object.keys(WEB).length);
});

test('observe: go, rust, python and make gates; npm placeholder test skipped; templates, prisma and GitLab CI recognised', (t) => {
  const { dir } = repo(t, {
    active: false,
    files: {
      'package.json': { name: 'x', scripts: { test: 'echo "Error: no test specified" && exit 1' } },
      'go.mod': 'module example.com/x\n',
      'Cargo.toml': '[package]\nname = "x"\n',
      'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      Makefile: 'build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n',
      'web/templates/index.html': '<html></html>\n',
      'prisma/schema.prisma': 'datasource db {}\n',
      '.gitlab-ci.yml': 'test:\n  script: make test\n',
      'GEMINI.md': '# Gemini\n',
    },
  });
  const o = profile.observe(dir, { env: ISO.env }); // untracked files count too (a repository without commits)
  assert.deepEqual(o.facts.stack.value, ['go', 'node', 'python', 'rust']);
  assert.deepEqual(o.gates.map((g) => [g.name, g.cmd, g.kind]), [
    ['make-test', 'make test', 'test'], ['pytest', 'pytest', 'test'], ['go-test', 'go test ./...', 'test'], ['cargo-test', 'cargo test', 'test'],
  ]);
  assert.deepEqual([o.facts.ui.value, o.facts.ui.evidence], [true, 'web/templates/index.html']);
  assert.deepEqual([o.facts.backend.value, o.facts.backend.evidence], [true, 'prisma/schema.prisma']);
  assert.equal(o.facts.ci.value, 'gitlab-ci');
  assert.deepEqual(o.facts.otherHarnesses.value, ['gemini']);
});

test('observe: an empty repository shows no CI and no harness; unreadable manifests are skipped, never followed', (t) => {
  const { dir, base } = repo(t, { active: false });
  const empty = profile.observe(dir, { env: ISO.env });
  assert.deepEqual(empty.facts, {
    ci: { value: 'none', evidence: 'no CI configuration among 0 files', confidence: 0.9 },
    otherHarnesses: { value: [], evidence: 'none found', confidence: 0.9 },
  });
  assert.deepEqual([empty.gates, empty.riskPaths], [[], DEFAULT_RISK_PATHS]);
  // A manifest that links outside the repository is never read; a broken one gives the stack but no gates.
  put(base, 'outside/package.json', { scripts: { test: 'steal' } });
  symlinkSync(join(base, 'outside', 'package.json'), join(dir, 'package.json'));
  put(dir, 'go.mod', 'module x\n');
  put(dir, 'Makefile', `test:\n${'\t# filler\n'.repeat(60000)}`); // larger than the read limit
  const linked = profile.observe(dir, { env: ISO.env });
  assert.deepEqual(linked.gates.map((g) => g.cmd), ['go test ./...'], 'no gate from a linked or oversized manifest');
  rmSync(join(dir, 'package.json'));
  put(dir, 'package.json', '{ not json');
  const broken = profile.observe(dir, { env: ISO.env });
  assert.deepEqual(broken.facts.stack.value, ['go', 'node']);
  assert.deepEqual(broken.gates.map((g) => g.cmd), ['go test ./...']);
});

test('observe: repository content cannot break the profile: odd file names, odd or deeply nested exports, a corrupt scan cache', async (t) => {
  const bin = JSON.stringify({ a: './bin\u202e/x.js', b: `./${'d'.repeat(130)}/x.js`, c: '../outside/x.js' });
  const nested = `${'{"a":'.repeat(20000)}"./deep/x.js"${'}'.repeat(20000)}`; // JSON.parse reads it; recursion would not
  const { dir, store } = repo(t, {
    files: {
      'package.json': `{"name":"x","bin":${bin},"exports":${nested}}\n`,
      'src/odd\tname\u202e.tsx': 'x\n',
      'db/new\nline/migrations/1.sql': 'x\n',
    },
  });
  commit(dir);
  const r = await cli(['profile', 'observe'], { dir });
  assert.equal(r.code, 0, JSON.stringify(r.env));
  const p = readProfile(store);
  assert.equal(p.facts.ui.value, true);
  for (const f of [p.facts.ui, p.facts.backend]) assert.doesNotMatch(f.evidence, /[\u0000-\u001f\u202e]/, 'evidence holds no control or bidi character');
  assert.deepEqual(p.riskPaths, DEFAULT_RISK_PATHS, 'no glob from an odd, too long, escaping or too deeply nested entry');
  // A corrupt local cache is a miss, never a failure; it is written again.
  put(store, 'local/scan-cache.json', '{ broken');
  const again = await cli(['profile', 'observe'], { dir });
  assert.deepEqual([again.code, again.data.cached], [0, false], JSON.stringify(again.env));
  assert.equal(JSON.parse(readFileSync(join(store, 'local', 'scan-cache.json'), 'utf8')).head, again.data.head);
  // A cache written by a newer plugin is neither read nor replaced.
  const newer = { schema: 99, future: true };
  put(store, 'local/scan-cache.json', newer);
  const third = await cli(['profile', 'observe'], { dir });
  assert.deepEqual([third.code, third.data.cached], [0, false], JSON.stringify(third.env));
  assert.deepEqual(JSON.parse(readFileSync(join(store, 'local', 'scan-cache.json'), 'utf8')), newer);
});

test('profile observe: ≤ 2 s on a 10k-file repository; writes profile.json and the scan cache; a second run at the same HEAD uses the cache', async (t) => {
  const { dir, store } = repo(t, { files: WEB });
  for (let d = 0; d < 100; d++) {
    mkdirSync(join(dir, 'src', `m${d}`), { recursive: true });
    for (let f = 0; f < 100; f++) writeFileSync(join(dir, 'src', `m${d}`, `f${f}.${f % 10 === 0 ? 'tsx' : 'ts'}`), `export const v${f} = ${f};\n`);
  }
  const head = commit(dir, 'ten thousand files');
  const started = performance.now();
  const r = await cli(['profile', 'observe'], { dir });
  const elapsed = performance.now() - started;
  assert.equal(r.code, 0, JSON.stringify(r.env));
  assert.ok(r.data.files >= 10000, `scanned ${r.data.files} files`);
  assert.ok(elapsed <= 2000, `profile observe took ${Math.round(elapsed)} ms on ${r.data.files} files (limit 2000 ms)`);
  assert.deepEqual([r.data.active, r.data.written, r.data.cached, r.data.head], [true, true, false, head]);
  const p = readProfile(store);
  assert.equal(p.schema, profile.PROFILE_KINDS.profile.version);
  assert.equal(p.facts.ui.source, 'observed');
  assert.equal(p.lastScan.head, head);
  assert.ok(Math.abs(Date.parse(p.lastScan.at) - Date.now()) < 60000, 'lastScan.at is now');
  const cache = JSON.parse(readFileSync(join(store, 'local', 'scan-cache.json'), 'utf8'));
  assert.deepEqual([cache.head, cache.observation.files], [head, r.data.files]);
  const again = await cli(['profile', 'observe'], { dir });
  assert.deepEqual([again.code, again.data.cached, again.data.files], [0, true, r.data.files]);
  assert.deepEqual(again.data.observation, r.data.observation, 'the cached observation is the same');
});

test('profile observe in an inactive repository writes nothing (zero footprint) and still reports the observation', async (t) => {
  const { dir, store } = repo(t, { active: false, files: WEB });
  commit(dir);
  const before = snapshot(dir);
  const r = await cli(['profile', 'observe'], { dir });
  assert.equal(r.code, 0, JSON.stringify(r.env));
  assert.deepEqual([r.data.active, r.data.written], [false, false]);
  assert.equal(r.data.observation.facts.ui.value, true);
  assert.deepEqual(snapshot(dir), before, 'no file created or changed');
  assert.equal(existsSync(store), false);
  const show = await cli(['profile', 'show'], { dir });
  assert.deepEqual([show.code, show.data.active, show.data.profile], [0, false, null]);
  const set = await cli(['profile', 'set', 'ui', 'true', '--source', 'said', '--evidence', 'it has screens'], { dir });
  assert.deepEqual([set.code, set.env.exit, set.error], [7, 'REFUSED', 'inactive']);
  assert.deepEqual(snapshot(dir), before);
});

test('profile observe outside a git repository exits 8 ENV', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'profile-norepo-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...ISO.env, GIT_CEILING_DIRECTORIES: base };
  const out = [];
  const code = await main(['profile', 'observe', '--yes', '--json'], { io: { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd: base } });
  assert.deepEqual([code, JSON.parse(out.join('')).errors[0].code], [EXIT.ENV, 'not-a-repo']);
});

// ---- said facts ----

test('profile set records a said fact with its source, the quote as evidence, confidence and time; show lists it', async (t) => {
  const { dir, store } = repo(t);
  const quote = 'We launched last month and people pay for it';
  const r = await cli(['profile', 'set', 'deployedToUsers', 'yes', '--source', 'said', '--evidence', quote], { dir });
  assert.equal(r.code, 0, JSON.stringify(r.env));
  const fact = readProfile(store).facts.deployedToUsers;
  assert.deepEqual({ ...fact, at: undefined }, { value: true, source: 'said', evidence: quote, confidence: 1, at: undefined });
  assert.ok(Math.abs(Date.parse(fact.at) - Date.now()) < 60000, 'at is now');
  assert.deepEqual(r.data.fact, fact);
  // Pack activation reads it under exactly this key.
  assert.deepEqual(activePacks(PACKS, profile.factValues(readProfile(store))).sort(), ['release', 'runbooks']);
  const show = await cli(['profile', 'show'], { dir });
  assert.equal(show.code, 0);
  assert.deepEqual(show.data.profile.facts.deployedToUsers, fact);
  // Human text names the source and the quote.
  const out = [];
  await main(['profile', 'show'], { io: { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env: ISO.env, cwd: dir } });
  assert.match(out.join(''), /deployedToUsers\s+true\s+said: "We launched last month/);
  // Saying it again moves the time; an observed value never replaces a different said one.
  const observed = await cli(['profile', 'set', 'deployedToUsers', 'no', '--source', 'observed', '--evidence', 'deploy/README.md:3'], { dir });
  assert.deepEqual([observed.code, observed.error], [EXIT.FAIL, 'said-outranks']);
  assert.deepEqual(readProfile(store).facts.deployedToUsers, fact, 'unchanged');
  const ui = await cli(['profile', 'set', 'ui', 'true', '--source', 'observed', '--evidence', 'src/App.tsx:1'], { dir });
  assert.equal(ui.code, 0);
  assert.deepEqual({ ...readProfile(store).facts.ui, at: 0 }, { value: true, source: 'observed', evidence: 'src/App.tsx:1', confidence: 0.9, at: 0 });
});

test('profile set refuses bad input with exit 2 and writes nothing; it needs consent without a terminal', async (t) => {
  const { dir, store } = repo(t);
  const ok = ['ui', 'true', '--source', 'said', '--evidence', 'it has screens'];
  const cases = [
    [['deployed', 'true', '--source', 'said', '--evidence', 'x'], 'unknown-key'],
    [['gates', 'npm test', '--source', 'said', '--evidence', 'x'], 'not-settable'],
    [['riskPaths', 'src/**', '--source', 'said', '--evidence', 'x'], 'not-settable'],
    [['phase', 'finished', '--source', 'said', '--evidence', 'x'], 'invalid-value'],
    [['ui', 'true', '--evidence', 'x'], 'missing-source'],
    [['ui', 'true', '--source', 'default', '--evidence', 'x'], 'invalid-source'],
    [['ui', 'true', '--source', 'said'], 'missing-evidence'],
    [['ui', 'true', '--source', 'said', '--evidence', ' '], 'missing-evidence'],
    [['ui', 'true', '--source', 'said', '--evidence', 'x'.repeat(301)], 'limit-exceeded'],
    [['goal', 'a\u202egoal', '--source', 'said', '--evidence', 'x'], 'invalid-value'],
  ];
  for (const [args, code] of cases) {
    const r = await cli(['profile', 'set', ...args], { dir });
    assert.deepEqual([r.code, r.error], [EXIT.USAGE, code], args.join(' '));
    assert.ok(r.env.errors[0].hint.length > 0, `${code}: hint`);
  }
  assert.equal(existsSync(join(store, 'profile.json')), false, 'nothing written');
  const refused = await cli(['profile', 'set', ...ok], { dir, yes: false });
  assert.deepEqual([refused.code, refused.error], [EXIT.REFUSED, 'consent-required']);
  assert.equal((await cli(['profile', 'set', ...ok], { dir, yes: false, tty: true })).code, 0, 'a terminal is consent');
  // A store with a newer schema refuses the write (exit 7) and keeps the file.
  const newer = { ...readProfile(store), schema: 99 };
  put(store, 'profile.json', newer);
  const r = await cli(['profile', 'set', 'phase', 'live', '--source', 'said', '--evidence', 'x'], { dir });
  assert.deepEqual([r.code, r.error], [EXIT.REFUSED, 'schema-newer']);
  assert.deepEqual(readProfile(store), newer);
});

// ---- merge: said outranks observed ----

test('observe never overwrites a said fact; it replaces observed and default facts and drops observations that are gone', async (t) => {
  const { dir, store } = repo(t, { files: WEB });
  commit(dir);
  put(store, 'profile.json', {
    schema: 1,
    facts: { ui: said(false, OLD), ci: { value: 'jenkins', source: 'default', evidence: 'imported from 1.x config', confidence: 0.3, at: AT }, phase: { value: 'building', source: 'default', evidence: 'default', confidence: 0.3, at: AT } },
    gates: [], riskPaths: [], lastScan: null,
  });
  const first = await cli(['profile', 'observe'], { dir });
  assert.equal(first.code, 0, JSON.stringify(first.env));
  let p = readProfile(store);
  assert.deepEqual(p.facts.ui, said(false, OLD), 'said wins over the observation');
  assert.deepEqual([p.facts.ci.value, p.facts.ci.source], ['github-actions', 'observed']);
  assert.deepEqual(p.facts.phase.source, 'default', 'a key the scan does not observe keeps its value');
  assert.deepEqual([p.facts.backend.value, p.facts.backend.source, p.facts.backend.evidence], [true, 'observed', 'db/migrations/001_init.sql']);
  assert.deepEqual(first.data.conflicts.map((c) => [c.key, c.said, c.observed, c.askable]), [['ui', false, true, true]], 'said long ago (OLD): askable');
  // Migrations removed: the observed backend fact goes; an unchanged observation keeps its time.
  const backendAt = p.facts.stack.at;
  rmSync(join(dir, 'db'), { recursive: true });
  commit(dir, 'no database');
  const second = await cli(['profile', 'observe'], { dir });
  p = readProfile(store);
  assert.equal(p.facts.backend, undefined);
  assert.deepEqual(second.data.removed, ['backend']);
  assert.equal(p.facts.stack.at, backendAt, 'unchanged observation: same time, no churn');
});

test('merge: a contradicting observation becomes askable once it is ≥ 14 days newer than the said fact', () => {
  const saidAt = '2026-10-01T00:00:00.000Z';
  const doc = { schema: 1, facts: { ui: said(false, saidAt), stack: said(['typescript', 'node'], saidAt) }, gates: [], riskPaths: [], lastScan: null };
  const observation = { facts: { ui: { value: true, evidence: 'src/App.tsx', confidence: 0.7 }, stack: { value: ['node', 'typescript'], evidence: 'package.json', confidence: 0.9 } }, gates: [], riskPaths: [], files: 2 };
  const at = (ms) => new Date(Date.parse(saidAt) + ms).toISOString();
  const early = profile.merge(doc, observation, { now: at(14 * DAY - 60000), head: null });
  assert.deepEqual(early.conflicts.map((c) => [c.key, c.askable]), [['ui', false]], 'a list in another order is the same value');
  assert.deepEqual(early.profile.facts.ui, doc.facts.ui);
  const late = profile.merge(doc, observation, { now: at(14 * DAY), head: null });
  assert.deepEqual(late.conflicts.map((c) => [c.key, c.askable]), [['ui', true]]);
  // Asked and answered again: the said fact is new, the conflict waits another 14 days.
  const answered = { ...doc, facts: { ...doc.facts, ui: said(false, at(14 * DAY)) } };
  assert.equal(profile.merge(answered, observation, { now: at(20 * DAY), head: null }).conflicts[0].askable, false);
  assert.deepEqual(doc.facts.ui, said(false, saidAt), 'merge does not change its input');
});

test('gates: the first scan after activation sets them; later scans only report candidates (a gate change is a decision)', async (t) => {
  const { dir, store } = repo(t, { files: WEB });
  commit(dir);
  const first = await cli(['profile', 'observe'], { dir });
  assert.equal(first.data.gates.applied, true);
  assert.equal(first.data.files, Object.keys(WEB).length, 'the committed state files are not project files');
  const gates = readProfile(store).gates;
  assert.deepEqual(gates.map((g) => g.name), ['test', 'lint', 'typecheck', 'build']);
  put(dir, 'package.json', { name: 'web-app', scripts: { test: 'node --test' } });
  commit(dir, 'drop lint');
  const second = await cli(['profile', 'observe'], { dir });
  assert.equal(second.code, 0);
  assert.deepEqual(readProfile(store).gates, gates, 'gates unchanged: weakening a gate weakens the oracle');
  assert.deepEqual([second.data.gates.applied, second.data.gates.differ], [false, true]);
  assert.deepEqual(second.data.gates.candidates.map((g) => g.name), ['test']);
});

// ---- question bank ----

test('question bank: each question names the capability it decides and the observation that would answer it; deadline is never asked', () => {
  assert.deepEqual(profile.QUESTIONS.map((q) => [q.id, q.key]), [['Q-people', 'people'], ['Q-data', 'dataSensitivity'], ['Q-live', 'deployedToUsers']]);
  for (const q of profile.QUESTIONS) {
    assert.ok(q.text.endsWith('?'), q.id);
    assert.ok(Array.isArray(q.decides) && q.decides.length > 0, `${q.id}: decides`);
    assert.ok(typeof q.observation === 'string' && q.observation.length > 0, `${q.id}: observation`);
    for (const v of Object.values(q.answers)) assert.ok(profile.validValue(q.key, v), `${q.id}: answer ${v}`);
  }
  assert.deepEqual(profile.QUESTION_CAPS, { activation: 3, session: 1 });
  assert.ok(!profile.QUESTIONS.some((q) => q.key === 'deadline'));
});

test('question bank: capped at 3 on activation and 1 per later session; never asks what is answered, observed or does not change the process', () => {
  const empty = { schema: 1, facts: {}, gates: [], riskPaths: [], lastScan: null };
  const ids = (doc, opts) => profile.pendingQuestions(doc, { packs: PACKS, signals: { tier: 'L0' }, ...opts }).map((q) => q.id);
  assert.deepEqual(ids(empty, { moment: 'activation' }), ['Q-people', 'Q-data', 'Q-live']);
  assert.deepEqual(ids(empty, { moment: 'activation', asked: 2 }), ['Q-people']);
  assert.deepEqual(ids(empty, { moment: 'activation', asked: 3 }), []);
  assert.deepEqual(ids(empty, { moment: 'session' }), ['Q-people']);
  assert.deepEqual(ids(empty, { moment: 'session', asked: 1 }), []);
  assert.throws(() => ids(empty, { moment: 'later' }), /moment/);
  // Answered (said) or observed: never asked again; a default value is no answer.
  const answered = { ...empty, facts: { people: said('solo'), deployedToUsers: { value: false, source: 'observed', evidence: 'x', confidence: 0.9, at: AT }, dataSensitivity: { value: 'none', source: 'default', evidence: 'default', confidence: 0.3, at: AT } } };
  assert.deepEqual(ids(answered, { moment: 'activation' }), ['Q-data']);
  // Observation answers Q-people (two people commit already); the answer would flip nothing at L2 (lanes on),
  // L3 (security depth on) or with an incident (runbooks and release on).
  assert.deepEqual(ids(empty, { moment: 'activation', signals: { tier: 'L0', contributors30: 2 } }), ['Q-data', 'Q-live']);
  assert.deepEqual(ids(empty, { moment: 'activation', signals: { tier: 'L2' } }), ['Q-data', 'Q-live']);
  assert.deepEqual(ids(empty, { moment: 'activation', signals: { tier: 'L3' } }), ['Q-live']);
  assert.deepEqual(ids(empty, { moment: 'activation', signals: { tier: 'L0', incidents30: 1 } }), ['Q-people', 'Q-data']);
  // A contradicted said fact is asked once it is askable, and counts against the cap.
  const conflict = { key: 'ui', said: false, observed: true, evidence: 'src/App.tsx', saidAt: AT, askable: true };
  const withConflict = profile.pendingQuestions(empty, { moment: 'session', packs: PACKS, signals: { tier: 'L0' }, conflicts: [conflict, { ...conflict, key: 'backend', askable: false }] });
  assert.deepEqual(withConflict.map((q) => q.id), ['Q-confirm-ui']);
  assert.match(withConflict[0].text, /ui.*false.*true.*src\/App\.tsx.*\?$/);
});

// ---- update triggers ----

test('update triggers: a scan is due when never done, after ≥ 50 commits, after ≥ 7 days, or when the last scanned HEAD is unknown', () => {
  const now = '2026-10-15T00:00:00.000Z';
  const doc = (at, head = 'a'.repeat(40)) => ({ schema: 1, facts: {}, gates: [], riskPaths: [], lastScan: at === null ? null : { head, at } });
  const ago = (ms) => new Date(Date.parse(now) - ms).toISOString();
  assert.deepEqual(profile.TRIGGERS, { commits: 50, days: 7 });
  assert.deepEqual(profile.scanDue(doc(null), { commits: 0, now }), { due: true, reason: 'never-scanned', commits: null, days: null });
  assert.deepEqual(profile.scanDue(doc(ago(DAY)), { commits: 49, now }), { due: false, reason: null, commits: 49, days: 1 });
  assert.deepEqual(profile.scanDue(doc(ago(DAY)), { commits: 50, now }).reason, 'commits');
  assert.deepEqual(profile.scanDue(doc(ago(7 * DAY - 60000)), { commits: 0, now }).due, false);
  assert.deepEqual(profile.scanDue(doc(ago(7 * DAY)), { commits: 0, now }).reason, 'days');
  assert.deepEqual(profile.scanDue(doc(ago(DAY)), { commits: null, now }).reason, 'head-unknown');
});

test('update triggers: show reports whether a scan is due from git history; observe and set update the profile', async (t) => {
  const { dir, store } = repo(t, { files: WEB });
  const first = commit(dir);
  commit(dir, 'two');
  const head = commit(dir, 'three');
  const plant = (lastScan) => put(store, 'profile.json', { schema: 1, facts: {}, gates: [], riskPaths: [], lastScan });
  plant({ head: first, at: new Date(Date.now() - DAY).toISOString() });
  let r = await cli(['profile', 'show'], { dir });
  assert.deepEqual([r.code, r.data.scan.due, r.data.scan.commits], [0, false, 2]);
  plant({ head: first, at: new Date(Date.now() - 8 * DAY).toISOString() });
  r = await cli(['profile', 'show'], { dir });
  assert.deepEqual([r.data.scan.due, r.data.scan.reason], [true, 'days']);
  plant({ head: 'f'.repeat(40), at: new Date().toISOString() });
  r = await cli(['profile', 'show'], { dir });
  assert.deepEqual([r.data.scan.due, r.data.scan.reason], [true, 'head-unknown']);
  assert.equal((await cli(['profile', 'observe'], { dir })).code, 0);
  r = await cli(['profile', 'show'], { dir });
  assert.deepEqual([r.data.scan.due, r.data.scan.commits, r.data.profile.lastScan.head], [false, 0, head]);
  // A repository activated before its first scan: due, never scanned.
  rmSync(join(store, 'profile.json'));
  r = await cli(['profile', 'show'], { dir });
  assert.deepEqual([r.code, r.data.active, r.data.scan.reason, r.data.profile.facts], [0, true, 'never-scanned', {}]);
});

// ---- command table ----

test('profile show, observe and set are command table rows; observe and set change files, show is read-only', () => {
  const row = (name) => COMMANDS.find((r) => r.name === name);
  for (const name of ['profile show', 'profile observe', 'profile set']) assert.ok(row(name) && !row(name).hidden, name);
  assert.equal(Boolean(row('profile show').mutating), false);
  assert.equal(row('profile observe').mutating, true);
  assert.equal(row('profile set').mutating, true);
  assert.deepEqual(row('profile set').args.map((a) => [a.name, Boolean(a.required)]), [['key', true], ['value', true]]);
  assert.deepEqual(row('profile set').flags.map((f) => f.flag), ['--source', '--evidence']);
  const pub = COMMANDS.filter((r) => !r.hidden).map((r) => r.name);
  assert.deepEqual(pub, [...pub].sort(), 'public rows sorted by name');
  // The key list in the help of profile set is the keys.mjs list (one source, GC6).
  const listed = row('profile set').details.find((d) => d.startsWith('Keys: '));
  assert.deepEqual(listed.replace(/^Keys: |\.$/g, '').split(', '), Object.keys(profile.FACT_KEYS));
  // The thresholds named in help are the constants.
  assert.ok(row('profile show').details.join(' ').includes(`after ${profile.TRIGGERS.commits} commits or ${profile.TRIGGERS.days} days`));
  assert.ok(row('profile observe').details.join(' ').includes(`askable after ${profile.SAID_OUTRANKS_DAYS} days`));
});
