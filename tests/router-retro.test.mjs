// Routing after the Pinwall retro (2026-10 §3.6, §4.3): the project's own risk globs and review focus are said facts
// of the profile (riskGlobs, reviewFocus) that route, verify and the briefs read; verify classes a task from its own
// commits, so merging main into the branch brings none of main's work into the class (D-MG-13). This file holds no
// plugin name or path: both come from lib/name.json.
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
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "passing"}\n---\n\n# Report\n';

// An active repository with one commit and a routed trivial task on a branch; `git` runs in it, `cli` runs the CLI.
async function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'router-retro-')));
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
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  write('calc.test.mjs', "import { test } from 'node:test';\ntest('adds', () => {});\n");
  write('src/a.js', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const r = { base, dir, env, git, write, cwd: dir };
  r.cli = async (args, { json = true } = {}) => {
    const out = [];
    const err = [];
    const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
    const code = await main(json ? [...args, '--json'] : args, { io });
    const text = out.join('');
    return { code, text, stderr: err.join(''), env: json ? JSON.parse(text) : null };
  };
  assert.equal((await r.cli(['init', '--yes'])).code, 0);
  r.stateDir = join(dir, names.stateDir);
  const pstore = profile.openStore(r.stateDir, names);
  pstore.write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }] });
  r.vstore = verify.openStore(r.stateDir, names);
  return r;
}
const show = (res) => `${res.text}\n${res.stderr}`;

test('profile set riskGlobs adds the project\'s own risk globs; route and route --probe read them next to the scanned risk paths; show lists them', async (t) => {
  const r = await repo(t);
  const set = await r.cli(['profile', 'set', 'riskGlobs', 'client/src/ai/**, server/src/webhooks.ts', '--source', 'said', '--evidence', 'the AI key and the LAN-only webhooks are the risks here', '--yes']);
  assert.equal(set.code, 0, show(set));
  assert.deepEqual(set.env.data.fact.value, ['client/src/ai/**', 'server/src/webhooks.ts']);
  const probe = await r.cli(['route', '--probe', '--paths', 'client/src/ai/settings.ts', '--loc', '12']);
  assert.deepEqual([probe.code, probe.env.data.class, probe.env.data.reasons[0].code], [0, 'critical', 'risk-path'], show(probe));
  const file = await r.cli(['route', '--probe', '--paths', 'server/src/webhooks.ts', '--loc', '3']);
  assert.equal(file.env.data.class, 'critical', 'a said glob naming one file');
  const plain = await r.cli(['route', '--probe', '--paths', 'server/src/other.ts', '--loc', '3']);
  assert.equal(plain.env.data.class, 'trivial');
  assert.equal((await r.cli(['task', 'new', 'AI settings', '--yes'])).code, 0);
  const routed = await r.cli(['route', 'T-TU-1', '--paths', 'client/src/ai/settings.ts', '--loc', '12', '--yes']);
  assert.equal(routed.env.data.class, 'critical', show(routed));
  const shown = await r.cli(['profile', 'show'], { json: false });
  assert.match(shown.text, /Risk paths: .*said \(riskGlobs\): client\/src\/ai\/\*\*, server\/src\/webhooks\.ts/);
  const still = await r.cli(['profile', 'set', 'riskPaths', 'x/**', '--source', 'said', '--evidence', 'x', '--yes']);
  assert.deepEqual([still.code, still.env.errors[0].code], [2, 'not-settable']);
  assert.match(still.env.errors[0].hint, /riskGlobs/);
});

test('profile set reviewFocus is injected into the task brief; a docs-only route is standard without a spec', async (t) => {
  const r = await repo(t);
  const set = await r.cli(['profile', 'set', 'reviewFocus', 'maskedIds and hiddenIds in private mode, every webhook stays LAN-only', '--source', 'said', '--evidence', 'the two leaks reviews found', '--yes']);
  assert.equal(set.code, 0, show(set));
  await r.cli(['task', 'new', 'Manual in Polish', '--yes']);
  const routed = await r.cli(['route', 'T-TU-1', '--paths', 'docs/manual/pl/a.md,docs/manual/pl/b.md,docs/manual/pl/c.md', '--loc', '2100', '--yes']);
  assert.deepEqual([routed.code, routed.env.data.class, routed.env.data.reasons.map((x) => x.code)], [0, 'standard', ['docs-only']], show(routed));
  const brief = await r.cli(['brief', 'T-TU-1'], { json: false });
  assert.equal(brief.code, 0, show(brief));
  assert.match(brief.text, /^Review focus \(what every review of this project checks\): maskedIds and hiddenIds in private mode; every webhook stays LAN-only$/m);
  const json = await r.cli(['brief', 'T-TU-1']);
  assert.deepEqual(json.env.data.focus, ['maskedIds and hiddenIds in private mode', 'every webhook stays LAN-only']);
});

test('verify classes a task from its own commits: main merged into the branch brings none of main\'s files or lines (D-MG-13)', async (t) => {
  const r = await repo(t);
  await r.cli(['task', 'new', 'Small fix', '--yes']);
  assert.equal((await r.cli(['route', 'T-TU-1', '--paths', 'src/a.js', '--loc', '2', '--yes'])).env.data.class, 'trivial');
  const base = r.git('rev-parse', 'HEAD');
  r.git('switch', '-q', '-c', 'task/T-TU-1-fix');
  r.write('src/a.js', 'export const a = 2;\n');
  r.write(`${names.stateDir}/tasks/T-TU-1/report.md`, REPORT);
  state.setTask({ cwd: r.dir, env: r.env, names, id: 'T-TU-1', state: 'started', options: { branch: 'task/T-TU-1-fix', base } });
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'the fix');
  // meanwhile main grows by 20 files and 600 lines (another task merged), and the branch merges main
  r.git('switch', '-q', 'main');
  for (let i = 0; i < 20; i++) r.write(`src/big${i}.js`, `${'export const x = 1;\n'.repeat(30)}`);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'another task lands on main');
  r.git('switch', '-q', 'task/T-TU-1-fix');
  r.git('merge', '-q', '--no-edit', 'main');
  const res = await r.cli(['verify', 'T-TU-1', '--yes']);
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.env.data.route.actual, res.env.data.route.escalated, res.env.data.class], ['trivial', false, 'trivial'], 'main\'s 20 files are not the task\'s change');
  // what a merge commit itself adds beyond its parents (an edit made while merging) is the task's own change
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'state after verify');
  r.git('switch', '-q', 'main');
  r.write('src/more.js', 'export const m = 1;\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'main again');
  r.git('switch', '-q', 'task/T-TU-1-fix');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
  for (let i = 0; i < 16; i++) r.write(`src/own${i}.js`, 'export const y = 1;\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'merge main, with 16 files slipped into the merge');
  const grown = await r.cli(['verify', 'T-TU-1', '--yes']);
  assert.deepEqual([grown.code, grown.env.data.route.actual, grown.env.data.route.escalated], [1, 'critical', true], show(grown));
});

test('a side branch merged cleanly into the task is the task\'s own work: its risk path and lines count (review r1 F3)', async (t) => {
  const r = await repo(t);
  await r.cli(['task', 'new', 'Login', '--yes']);
  assert.equal((await r.cli(['route', 'T-TU-1', '--paths', 'src/a.js', '--loc', '2', '--yes'])).env.data.class, 'trivial');
  const base = r.git('rev-parse', 'HEAD');
  // the task branch does its own small change (the state travels with it)
  r.git('switch', '-q', '-c', 'task/T-TU-1-login');
  r.write('src/a.js', 'export const a = 2;\n');
  r.write(`${names.stateDir}/tasks/T-TU-1/report.md`, REPORT);
  state.setTask({ cwd: r.dir, env: r.env, names, id: 'T-TU-1', state: 'started', options: { branch: 'task/T-TU-1-login', base } });
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'the task');
  // a helper's side branch, off the same base, adds an auth file with 900 lines; the task merges it without a conflict
  r.git('switch', '-q', '-c', 'side', base);
  r.write('src/auth/login.js', 'export const login = 1;\n'.repeat(900));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'side: login');
  r.git('switch', '-q', 'task/T-TU-1-login');
  r.git('merge', '-q', '--no-ff', '--no-edit', 'side');
  const res = await r.cli(['verify', 'T-TU-1', '--yes']);
  assert.deepEqual([res.code, res.env.data.route.actual, res.env.data.route.escalated], [1, 'critical', true], show(res));
  assert.ok(res.env.errors.some((e) => e.code === 'route-escalated'), show(res));
  // the same change on main itself (no branch) is classed from its own commits too
  const m = await repo(t);
  await m.cli(['task', 'new', 'On main', '--yes']);
  assert.equal((await m.cli(['route', 'T-TU-1', '--paths', 'src/a.js', '--loc', '2', '--yes'])).env.data.class, 'trivial');
  const mb = m.git('rev-parse', 'HEAD');
  m.write('src/auth/login.js', 'export const login = 1;\n');
  m.write(`${names.stateDir}/tasks/T-TU-1/report.md`, REPORT);
  state.setTask({ cwd: m.dir, env: m.env, names, id: 'T-TU-1', state: 'dispatched', options: { executor: 'claude:implementer', base: mb } });
  m.git('add', '-A');
  m.git('commit', '-q', '-m', 'on main');
  const onMain = await m.cli(['verify', 'T-TU-1', '--yes']);
  assert.deepEqual([onMain.env.data.route.actual, onMain.env.data.route.escalated], ['critical', true], show(onMain));
});
