// First run with the state inside the repository (T-MG-95): `task start` refuses while the state is uncommitted, and
// `task done` run in the main checkout judges the task's recorded worktree. Commands run through the real command table.
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
  assert.equal(hits.length, 1);
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
async function cli(args, { cwd, env }) {
  const out = [];
  const code = await main([...args, '--json'], { io: { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null } });
  return { code, out: JSON.parse(out.join('')) };
}
const show = (r) => JSON.stringify(r);

async function fresh(t) {
  const iso = isolatedEnv({ gitConfig: '[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'in-repo-state-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(dir, 'a.js'), 'export {};\n');
  git(dir, iso.env, ['add', 'a.js']);
  git(dir, iso.env, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  const r = { base: iso.base, dir, cwd: dir, env: iso.env };
  r.run = (args, cwd = dir) => cli([...args, '--yes'], { cwd, env: iso.env });
  assert.equal((await r.run(['init'])).code, 0);
  assert.equal((await r.run(['task', 'new', 'Cart checkout'])).code, 0);
  return r;
}

test('task start refuses with exit 7 while the in-repo state is uncommitted, and works after commit', async (t) => {
  const r = await fresh(t);
  const res = await r.run(['task', 'start', 'T-TU-1']);
  assert.equal(res.code, 7, show(res));
  assert.equal(res.out.errors[0].code, 'state-uncommitted');
  assert.equal(res.out.errors[0].hint, `commit the state first: ${names.bin} commit --yes`);
  assert.equal(existsSync(join(r.base, 'repo-wt')), false);
  assert.equal((await r.run(['commit'])).code, 0);
  assert.equal((await r.run(['task', 'start', 'T-TU-1'])).code, 0);
});
