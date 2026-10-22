// `<bin> review brief <id> [--round <k>] [--scope <ids>] [--write [--force]]` (ORC-5, REV-6): the review brief rendered from
// the state: the range pinned to HEAD (a later round starts at the HEAD the previous brief pinned), the diff saved to a
// file in the state directory, acceptance points, risks and the previous findings. A dirty tree is refused.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const profile = await lib('profile/index.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const MARKER = new RegExp(`<!-- rendered by \`${names.bin} brief\`; sha256 [0-9a-f]{64}: an edit makes this brief hand-written -->\\n$`);

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
async function cli(args, { cwd, env, json = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${typeof r.out === 'string' ? r.out : JSON.stringify(r.out)}\n${r.stderr}`;

// An active repository: T-TU-1 routed (src/auth/login.js), with a recorded base, a brief with an acceptance point, a
// profile with a risk path and a decision D-TU-1; one commit changes src/auth/login.js and cites the decision.
async function project(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'rbrief-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env, store: join(realpathSync(repo), names.stateDir) };
  p.run = async (args) => {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`);
    return r;
  };
  p.git = (...args) => git(p.repo, env, args);
  p.commit = (msg) => { p.git('add', '-A'); p.git('commit', '-q', '-m', msg); return p.git('rev-parse', 'HEAD'); };
  for (const args of [['init'], ['task', 'new', 'Cart checkout'], ['task', 'new', 'Not routed yet'], ['route', 'T-TU-1', '--paths', 'src/auth/login.js', '--loc', '20']]) await p.run(args);
  p.base0 = p.git('rev-parse', 'HEAD');
  await p.run(['task', 'set', 'T-TU-1', 'started', '--branch', 'task/T-TU-1-cart', '--base', p.base0]);
  profile.openStore(p.store, names).write('profile', null, { facts: {}, gates: [], riskPaths: ['**/auth/**'], lastScan: null });
  await p.run(['brief', 'T-TU-1', '--write']);
  p.briefFile = join(p.store, 'tasks', 'T-TU-1', 'brief.md');
  const edited = readFileSync(p.briefFile, 'utf8').replace(/1\. <acceptance point[^\n]*\n2\. <…>\n/, '1. Login returns 401 on a bad password\n');
  assert.match(edited, /1\. Login returns 401/);
  writeFileSync(p.briefFile, edited);
  await p.run(['decide', '--title', 'Fail closed', '--why', 'security', '--cost', 'lockout']);
  mkdirSync(join(p.repo, 'src', 'auth'), { recursive: true });
  writeFileSync(join(p.repo, 'src', 'auth', 'login.js'), 'export const login = () => 401;\n// D-TU-1: fail closed\n');
  p.head1 = p.commit('feat: login');
  return p;
}
const lines = (text) => text.split('\n');

test('review brief: round 1 pins base..HEAD, saves the diff, lists files, acceptance, risks, a decision and the marker', async (t) => {
  const p = await project(t);
  const r = await cli(['review', 'brief', 'T-TU-1', '--yes'], p);
  assert.equal(r.code, 0, show(r));
  assert.ok(r.out.includes(`Range: ${p.base0}..${p.head1} (branch task/T-TU-1-cart; HEAD at rendering: ${p.head1}`), r.out);
  assert.ok(lines(r.out).includes('- src/auth/login.js'));
  assert.ok(r.out.includes('1. Login returns 401 on a bad password'));
  assert.ok(r.out.includes('src/auth/login.js: risk path **/auth/**'));
  assert.ok(r.out.includes('D-TU-1: Fail closed (cited in src/auth/login.js)'));
  assert.ok(r.out.includes('(first review: no previous findings)'));
  assert.ok(r.out.includes('(none yet)'), 'no report yet');
  assert.ok(r.out.includes(`${names.plugin}:reviewer`));
  assert.ok(MARKER.test(r.out), 'ends with the marker line');
  const diff = join(p.store, 'local', 'review', 'T-TU-1-r1.diff');
  assert.ok(existsSync(diff));
  assert.ok(readFileSync(diff, 'utf8').includes('fail closed'));
  assert.ok(r.out.includes(diff));
  const j = await cli(['review', 'brief', 'T-TU-1', '--yes'], { ...p, json: true });
  assert.equal(j.out.data.round, 1);
  assert.deepEqual(j.out.data.range, { from: p.base0, head: p.head1 });
});

test('review brief: a dirty tree is refused and no diff is written for that call', async (t) => {
  const p = await project(t);
  writeFileSync(join(p.repo, 'src', 'auth', 'login.js'), 'changed\n');
  const r = await cli(['review', 'brief', 'T-TU-1', '--yes'], { ...p, json: true });
  assert.equal(r.code, 1, show(r));
  assert.equal(r.out.errors[0].code, 'dirty-tree');
  assert.ok(!existsSync(join(p.store, 'local', 'review', 'T-TU-1-r1.diff')));
});

test('review brief --write: created; a hand-edited file is kept (brief-hand-written) unless --force', async (t) => {
  const p = await project(t);
  const file = join(p.store, 'tasks', 'T-TU-1', 'review-r1-brief.md');
  const a = await p.run(['review', 'brief', 'T-TU-1', '--write']);
  assert.ok(a.out.includes(`created: ${file}`), a.out);
  assert.ok(existsSync(file));
  writeFileSync(file, `${readFileSync(file, 'utf8')}hand note\n`);
  p.commit('chore: state');
  const b = await cli(['review', 'brief', 'T-TU-1', '--write', '--yes'], { ...p, json: true });
  assert.equal(b.code, 1, show(b));
  assert.equal(b.out.errors[0].code, 'brief-hand-written');
  const c = await cli(['review', 'brief', 'T-TU-1', '--write', '--force', '--yes'], p);
  assert.equal(c.code, 0, show(c));
  assert.ok(!readFileSync(file, 'utf8').includes('hand note'));
  const d = await cli(['review', 'brief', 'T-TU-1', '--force', '--yes'], p);
  assert.equal(d.code, 2, 'force without write');
});

test('review brief: round 2 starts at the HEAD round 1 pinned and lists the previous findings; --scope narrows; a bad scope is usage', async (t) => {
  const p = await project(t);
  await p.run(['review', 'brief', 'T-TU-1', '--write']);
  p.commit('chore: brief');
  const review = join(p.base, 'review.json');
  writeFileSync(review, JSON.stringify({
    verdict: 'needs-fixes',
    reviewer: { kind: 'claude', id: 'claude:reviewer' },
    findings: [
      { id: 'F1', severity: 'blocking', path: 'src/auth/login.js', line: 2, rule: null, text: 'fails open' },
      { id: 'F2', severity: 'minor', path: 'src/auth/login.js', line: null, rule: null, text: 'naming' },
    ],
  }));
  await p.run(['review', 'record', 'T-TU-1', '--from', review]);
  writeFileSync(join(p.repo, 'src', 'auth', 'login.js'), 'export const login = () => 403;\n');
  const head2 = p.commit('fix: login');
  const r = await cli(['review', 'brief', 'T-TU-1', '--yes'], { ...p, json: true });
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.round, 2);
  assert.deepEqual(r.out.data.range, { from: p.head1, head: head2 });
  assert.deepEqual(r.out.data.previous, ['F1', 'F2']);
  const text = await cli(['review', 'brief', 'T-TU-1', '--write', '--yes'], p);
  assert.equal(text.code, 0, show(text));
  const written = readFileSync(join(p.store, 'tasks', 'T-TU-1', 'review-r2-brief.md'), 'utf8');
  assert.ok(written.includes('| F1 | blocking | src/auth/login.js:2 | fails open |'), written);
  assert.ok(written.includes('| F2 | minor | src/auth/login.js:'), written);
  assert.ok(existsSync(join(p.store, 'local', 'review', 'T-TU-1-r2.diff')));
  const s = await cli(['review', 'brief', 'T-TU-1', '--scope', 'F1', '--yes'], { ...p, json: true });
  assert.deepEqual(s.out.data.previous, ['F1']);
  const bad = await cli(['review', 'brief', 'T-TU-1', '--scope', 'F9', '--yes'], p);
  assert.equal(bad.code, 2, show(bad));
});

test('review brief: unrouted, no base, no consent; the command is listed and docs are current', async (t) => {
  const p = await project(t);
  const u = await cli(['review', 'brief', 'T-TU-2', '--yes'], { ...p, json: true });
  assert.equal(u.code, 1, show(u));
  assert.equal(u.out.errors[0].code, 'task-unrouted');
  await p.run(['task', 'new', 'No base']);
  await p.run(['route', 'T-TU-3', '--paths', 'src/x.js', '--loc', '5']);
  const nb = await cli(['review', 'brief', 'T-TU-3', '--yes'], { ...p, json: true });
  assert.equal(nb.out.errors[0].code, 'base-missing', show(nb));
  assert.equal(nb.code, 1);
  const noYes = await cli(['review', 'brief', 'T-TU-1'], p);
  assert.equal(noYes.code, 7, show(noYes));
  const help = await cli(['--help'], p);
  assert.ok(help.out.includes('review brief'), 'listed in --help');
  const docs = spawnSync(process.execPath, [join(root, 'scripts', 'gen-docs.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(docs.status, 0, docs.stdout + docs.stderr);
});
