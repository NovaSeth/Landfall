// `<bin> commit [--message <text>]` (retro 2026-10 §4.4): one chore commit of the changes under the state directory,
// nothing else; nothing to commit and a linked state directory exit 0 without a commit. The state is not code, so this
// is the one commit a task needs for its records. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const { summarize } = await lib('cli/commit.mjs');

const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  return { code, out: json ? JSON.parse(out.join('')) : out.join(''), stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

// An active repository with one commit; initArgs go to `init` (a --state-dir keeps the state outside it).
async function repo(t, initArgs = []) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'commit-command-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  git(dir, iso.env, ['add', '-A']);
  git(dir, iso.env, ['commit', '-q', '-m', 'base']);
  const r = { base: iso.base, dir, cwd: dir, env: iso.env, run: (args) => cli([...args, '--yes'], { cwd: dir, env: iso.env }) };
  const init = await r.run(['init', ...initArgs]);
  assert.equal(init.code, 0, show(init));
  r.status = () => git(dir, iso.env, ['status', '--porcelain', '--untracked-files=all']);
  r.subject = () => git(dir, iso.env, ['log', '-1', '--format=%s']);
  r.head = () => git(dir, iso.env, ['rev-parse', 'HEAD']);
  return r;
}

test('summarize names tasks, decisions and files once each and stays within one line', () => {
  assert.equal(summarize(['.gitignore', 'profile.json', 'tasks/T-AB-1/task.json', 'tasks/T-AB-1/brief.md', 'decisions/D-AB-2.md', 'baseline/tests.json', 'team/AB.json']), 'T-AB-1, D-AB-2, profile, baseline, team');
  assert.equal(summarize(['.gitignore']), '.gitignore', 'a dot file alone is still named');
  const many = summarize(Array.from({ length: 40 }, (_, i) => `tasks/T-AB-${i + 1}/task.json`));
  assert.ok(many.length <= 120 && /\(\+\d+ more\)$/.test(many), many);
});

test('commit stages and commits only the state directory, with a message naming what changed; code outside it is left alone', async (t) => {
  const r = await repo(t);
  const created = await r.run(['task', 'new', 'Cart checkout']);
  assert.equal(created.code, 0, show(created));
  writeFileSync(join(r.dir, 'b.js'), 'export const b = 2;\n');
  const c = await r.run(['commit']);
  assert.equal(c.code, 0, show(c));
  assert.equal(c.out.data.committed, true);
  assert.match(c.out.data.commit, /^[0-9a-f]{40}$/);
  assert.equal(c.out.data.message, `chore(${names.bin}): T-TU-1, state, team`, 'the task first, then the activation files init left uncommitted');
  assert.equal(r.subject(), c.out.data.message);
  assert.equal(r.head(), c.out.data.commit);
  assert.ok(c.out.data.files.length > 0 && c.out.data.files.every((f) => f.startsWith(`${names.stateDir}/`)), show(c));
  assert.equal(r.status(), '?? b.js', 'the code change stays uncommitted and unstaged');
  const text = await cli(['commit', '--yes'], { cwd: r.dir, env: r.env, json: false });
  assert.match(text.out, /^nothing to commit under /);
  const again = await r.run(['commit']);
  assert.deepEqual([again.code, again.out.data.committed], [0, false], show(again));
});

test('commit --message is used as given; a message over 200 characters, empty or with control characters is refused with nothing committed', async (t) => {
  const r = await repo(t);
  await r.run(['task', 'new', 'Cart checkout']);
  const head = r.head();
  for (const [message, code] of [['x'.repeat(201), 'invalid-value'], ['', 'invalid-value'], ['two\nlines', 'invalid-value']]) {
    const bad = await r.run(['commit', '--message', message]);
    assert.deepEqual([bad.code, bad.out.errors[0].code], [2, code], show(bad));
    assert.equal(r.head(), head, 'nothing committed');
  }
  const ok = await r.run(['commit', '--message', 'chore: first task recorded']);
  assert.equal(ok.code, 0, show(ok));
  assert.equal(r.subject(), 'chore: first task recorded');
});

test('commit: a linked state directory has nothing git tracks (exit 0, no commit); an inactive repository is refused; consent is needed', async (t) => {
  const r = await repo(t);
  const linked = await repo(t, ['--state-dir', join(r.base, 'elsewhere-state')]);
  await linked.run(['task', 'new', 'Linked task']);
  const head = linked.head();
  const c = await linked.run(['commit']);
  assert.deepEqual([c.code, c.out.data.committed, c.out.data.linked], [0, false, true], show(c));
  assert.equal(linked.head(), head);
  const noYes = await cli(['commit'], { cwd: r.dir, env: r.env });
  assert.deepEqual([noYes.code, noYes.out.errors[0].code], [7, 'consent-required'], show(noYes));
  const bare = isolatedEnv({ gitConfig: identity, prefix: 'commit-inactive-' });
  t.after(bare.cleanup);
  const dir = join(bare.base, 'repo');
  mkdirSync(dir);
  git(dir, bare.env, ['init', '-q']);
  const inactive = await cli(['commit', '--yes'], { cwd: dir, env: bare.env });
  assert.deepEqual([inactive.code, inactive.out.errors[0].code], [7, 'inactive'], show(inactive));
  const help = await cli(['--help'], { cwd: r.dir, env: r.env, json: false });
  assert.match(help.out, /^ {2}commit {2,}Commit the changes under the state directory/m);
});
