// README "60-second demo" as an e2e test (T-MG-38): every command of the demo block still exists, and the
// demo flow runs in a fresh repository with in-repo state: route --probe, init, profile observe/set, task new, route,
// a test-first change with a RED/GREEN report, verify (pass), task done. Depends on verify measuring the
// reference at the task base (before that slice it fails at baseline-unanchored).
// Children get a throwaway HOME, git config and environment (tests/helpers/isolated-env.mjs).
// Run: node --test tests/e2e/readme-demo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from '../helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const BIN = join(pluginDir, 'bin', names.bin);

// The commands the README demo block shows: "$ <bin> <words> …" lines, joined with their continuation lines.
function demoCommands() {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const block = readme.split('## 60-second demo')[1].split('```text')[1].split('```')[0];
  const cmds = [];
  for (const line of block.replace(/\\\n\s*/g, ' ').split('\n')) {
    const m = line.match(new RegExp(`\\$ ${names.bin} (.+)$`));
    if (m) cmds.push(m[1]);
  }
  return cmds;
}

test('every command of the README demo exists', () => {
  const cmds = demoCommands();
  assert.ok(cmds.length >= 7, `demo commands found: ${cmds.length}`);
  const iso = isolatedEnv({ prefix: 'readme-demo-help-' });
  try {
    for (const c of cmds) {
      const words = c.split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
      // The command path is the leading plain words: "task new", "profile set", "verify"; stop at the first argument.
      const path = [];
      for (const w of words) { path.push(w); if (path.length === 2) break; }
      const ok = [path, path.slice(0, 1)].some((p) => spawnSync(BIN, [...p, '--help'], { env: iso.env, encoding: 'utf8' }).status === 0
        && !/unknown command/i.test(spawnSync(BIN, [...p, '--help'], { env: iso.env, encoding: 'utf8' }).stderr));
      assert.ok(ok, `README demo command not found: ${names.bin} ${c}`);
    }
  } finally { iso.cleanup(); }
});

test('the README demo flow: init, observe, task, route, test-first change, verify pass, task done', (t) => {
  const iso = isolatedEnv({ gitConfig: '[init]\n\tdefaultBranch = main\n[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'readme-demo-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'app');
  mkdirSync(dir);
  const { env } = iso;
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const cli = (...args) => {
    const r = spawnSync(BIN, [...args, '--yes'], { cwd: dir, env, encoding: 'utf8', timeout: 100000 });
    assert.equal(r.status, 0, `${names.bin} ${args.join(' ')}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    return r.stdout.trim();
  };

  git('init', '-q');
  write('package.json', '{"name":"app","type":"module","scripts":{"test":"node --test"}}\n');
  write('src/math.js', 'export const add = (a, b) => a + b;\n');
  write('test/math.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('adds', () => assert.equal(add(1, 2), 3));\n");
  git('add', '.'); git('commit', '-qm', 'init');

  const probe = spawnSync(BIN, ['route', '--probe', '--paths', 'src/csv.js,test/csv.test.js', '--loc', '80'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /standard/);

  cli('init');
  assert.match(cli('profile', 'observe'), /node/i);
  cli('profile', 'set', 'deployedToUsers', 'true', '--source', 'said', '--evidence', 'Yes, about 40 customers use it');
  git('add', '-A'); git('commit', '-qm', 'state');

  const id = cli('task', 'new', 'CSV export').split(/\s+/).find((w) => /^T-/.test(w));
  assert.ok(id, 'task id');
  cli('route', id, '--paths', 'src/csv.js,test/csv.test.js', '--loc', '80');
  cli('task', 'set', id, 'dispatched', '--executor', 'claude:implementer', '--base', git('rev-parse', 'HEAD'));

  write('test/csv.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { toCsv } from '../src/csv.js';\ntest('exports rows as CSV', () => assert.equal(toCsv([[1, 2]]), '1,2'));\n");
  write('src/csv.js', 'export const toCsv = (rows) => rows.map((r) => r.join(",")).join("\\n");\n');
  git('add', '.'); git('commit', '-qm', 'feat: csv export');
  write(`${names.stateDir}/tasks/${id}/report.md`,
    '---\nred: {"command": "npm test", "exit": 1, "excerpt": "fail 1"}\ngreen: {"command": "npm test", "exit": 0, "excerpt": "pass 2"}\n---\n# Report\nStatus: DONE\n');

  git('add', '-A'); git('commit', '-qm', 'report'); // verify checks a clean tree
  assert.match(cli('verify', id), /pass/i);
  git('add', '-A'); git('commit', '-qm', 'verified'); // the recorded verify is state; only state changed since
  assert.match(cli('task', 'done', id), /done/i);
  assert.match(readFileSync(join(dir, names.stateDir, 'tasks', id, 'task.json'), 'utf8').replace(/\s+/g, ''), /"status":"done"/);
});
