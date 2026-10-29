// Task flow end to end (spec §7.6, §8.2, SD-15, SD-16, SD-47, GC3): one repository driven only through the launcher,
// as a developer or an agent runs it: init, profile observe (the test gate from package.json), the initial baseline
// pinned with a decision on the target, then task new → route → implement → report from the template → verify →
// review record → task done → task merge, all green. The same flow with a removed test is refused by verify, task
// done and task merge until a decision lists the test in allowsTestRemoval.
// Children get a throwaway HOME, git config and environment (tests/helpers/isolated-env.mjs).
// Run: node --test tests/e2e/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from '../helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The plugin directory is found through name.json itself, so this test holds no plugin path or codename.
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const BIN = join(pluginDir, 'bin', names.bin);
const TEMPLATE = readFileSync(join(pluginDir, 'templates', 'task', 'report.md'), 'utf8');

const CALC = 'export const add = (a, b) => a + b;\n';
const CALC2 = `${CALC}export const subtract = (a, b) => a - b;\n`;
const HEAD = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, subtract } from './calc.mjs';\n";
const ADDS = "test('adds', () => assert.equal(add(1, 2), 3));\n";
const SUBTRACTS = "test('subtracts', () => assert.equal(subtract(3, 2), 1));\n";

// A repository with package.json (test script `node --test`), calc.mjs and its tests committed on main, activated,
// observed and with its initial baseline pinned by a gate-change decision, all committed.
function project(t, { calc, tests }) {
  const iso = isolatedEnv({ gitConfig: '[init]\n\tdefaultBranch = main\n[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'task-flow-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  const { env } = iso;
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, '--json', '--yes'], { cwd: dir, env, encoding: 'utf8', timeout: 240000 });
    let envelope = null;
    try { envelope = JSON.parse(r.stdout); } catch { /* reported below */ }
    return { code: r.status, env: envelope, out: `step "${args.join(" ")}": exit ${r.status}, signal ${r.signal}\nstdout: ${r.stdout}\nstderr (last 300 bytes): ${String(r.stderr ?? "").slice(-300)}` };
  };
  const ok = (res) => { assert.equal(res.code, 0, res.out); return res.env; };
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  const read = (rel) => JSON.parse(readFileSync(join(dir, names.stateDir, rel), 'utf8'));
  const p = { base: iso.base, dir, git, write, cli, ok, commit, read };

  git('init', '-q');
  write('package.json', `${JSON.stringify({ name: 'calc', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  write('calc.mjs', calc);
  write('calc.test.mjs', tests);
  commit('calc');
  ok(cli('init'));
  const observed = ok(cli('profile', 'observe'));
  assert.ok(read('profile.json').gates.some((g) => g.kind === 'test'), `a test gate from package.json: ${JSON.stringify(observed.data)}`);
  const pin = ok(cli('decide', '--title', 'Pin the initial test baseline', '--why', 'Verify compares every task with the baseline on main.', '--cost', 'A wrong baseline hides a removed test.', '--kind', 'gate-change'));
  const pinned = ok(cli('baseline', 'pin', '--decision', pin.data.id));
  assert.equal(pinned.data.decision, pin.data.id);
  commit('activate, observe, pin the baseline');
  return p;
}

// Starts a task on main and a branch for it: task new (committed on main), branch, dispatched with main as base, route.
function start(p, title, paths, loc) {
  const id = p.ok(p.cli('task', 'new', title)).data.id;
  const base = p.commit(`${id}: new`);
  p.git('checkout', '-q', '-b', `task/${id}`);
  p.ok(p.cli('task', 'set', id, 'dispatched', '--executor', 'claude:implementer', '--base', base));
  const route = p.ok(p.cli('route', id, '--paths', paths, '--loc', String(loc)));
  return { id, base, class: route.data.class, branch: `task/${id}` };
}

// The executor's report, rendered from the plugin's template: the placeholders of red and green get the evidence.
function report(p, id, evidence) {
  const text = TEMPLATE.replace(/^(red|green): (.*)$/gm, (line, key, value) => {
    const e = evidence[key];
    return `${key}: ${value.replace(/"command": "<[^"]*>"/, `"command": ${JSON.stringify(e.command)}`).replace(/"exit": <[^>]*>/, `"exit": ${e.exit}`).replace(/"excerpt": "<[^"]*>"/, `"excerpt": ${JSON.stringify(e.excerpt)}`)}`;
  }).replace('<title>', 'the task').replace('<task ID>', id);
  p.write(`${names.stateDir}/tasks/${id}/report.md`, text);
}
const EVIDENCE = { red: { command: 'npm test', exit: 1, excerpt: 'not ok 2 - subtracts' }, green: { command: 'npm test', exit: 0, excerpt: '# pass 2\n# fail 0' } };

// The reviewer's typed result, recorded from a file outside the repository.
function review(p, id) {
  const file = join(p.base, `${id}-review.json`);
  writeFileSync(file, JSON.stringify({ verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [{ id: 'F1', severity: 'minor', path: 'calc.mjs', line: 2, rule: null, text: 'a doc comment would help' }] }));
  const rec = p.ok(p.cli('review', 'record', id, '--from', file));
  assert.deepEqual([rec.data.round, rec.data.verdict], [1, 'approved']);
}

test('task flow: task new → route → implement → report from the template → verify → review record → task done → task merge, all green', { timeout: 600000 }, (t) => {
  const p = project(t, { calc: CALC, tests: HEAD.replace(', subtract', '') + ADDS });
  const task = start(p, 'Add subtract', 'calc.mjs,calc.test.mjs', 4);
  assert.equal(task.class, 'trivial');

  p.write('calc.mjs', CALC2);
  p.write('calc.test.mjs', HEAD + ADDS + SUBTRACTS);
  report(p, task.id, EVIDENCE);
  p.commit(`${task.id}: subtract`);

  const v = p.ok(p.cli('verify', task.id));
  assert.equal(v.data.result, 'pass');
  assert.deepEqual([v.data.inventory.added.length, v.data.inventory.removed, v.data.artifacts.report], [1, [], true]);
  review(p, task.id);
  const d = p.ok(p.cli('task', 'done', task.id));
  assert.equal(d.data.status, 'done');
  p.commit(`${task.id}: verified, reviewed, done`);

  p.git('checkout', '-q', 'main');
  const tip = p.git('rev-parse', 'HEAD');
  const m = p.ok(p.cli('task', 'merge', task.id, '--branch', task.branch));
  assert.deepEqual([m.data.merged, m.data.result], [true, 'pass']);
  assert.deepEqual(p.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1), [tip, p.git('rev-parse', task.branch)]);
  // T-MG-80 (intended change): the code is clean; the merge record is an uncommitted state write, like task done's.
  assert.equal(p.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '');
  assert.deepEqual(p.git('status', '--porcelain').split('\n').map((l) => l.replace(/^\s*\S+\s+/, '')), [`${names.stateDir}/tasks/${task.id}/task.json`]);
  assert.equal(p.read(`tasks/${task.id}/task.json`).events.at(-1).event, 'merged');
  assert.equal(p.read(`tasks/${task.id}/task.json`).status, 'done');
  assert.deepEqual(p.read(`tasks/${task.id}/review-r1.json`).verdict, 'approved');
  assert.equal(p.read('baseline/tests.json').tests.length, 2, 'main\'s baseline holds the new test');
});

test('task flow with a removed test: verify, task done and task merge refuse it until a decision allows it', { timeout: 600000 }, (t) => {
  const p = project(t, { calc: CALC2, tests: HEAD + ADDS + SUBTRACTS });
  const task = start(p, 'Drop subtract', 'calc.mjs,calc.test.mjs', 3);
  p.write('calc.mjs', CALC);
  p.write('calc.test.mjs', HEAD.replace(', subtract', '') + ADDS);
  report(p, task.id, EVIDENCE);
  p.commit(`${task.id}: drop subtract`);

  let v = p.cli('verify', task.id);
  assert.deepEqual([v.code, v.env.data.result], [1, 'baseline-shrunk'], v.out);
  assert.equal(v.env.data.inventory.removed.length, 1);
  const removed = v.env.data.inventory.removed[0];
  assert.match(removed, /subtracts/);
  const refused = p.cli('task', 'done', task.id);
  assert.deepEqual([refused.code, refused.env.errors[0].code], [1, 'verify-failed'], refused.out);
  p.commit(`${task.id}: verify refused`);

  p.git('checkout', '-q', 'main');
  const tip = p.git('rev-parse', 'HEAD');
  const early = p.cli('task', 'merge', task.id, '--branch', task.branch);
  assert.deepEqual([early.code, early.env.data.result], [1, 'baseline-shrunk'], early.out);
  assert.deepEqual([p.git('rev-parse', 'HEAD'), p.git('status', '--porcelain')], [tip, '']);
  p.git('checkout', '-q', task.branch);

  const allow = p.ok(p.cli('decide', '--title', 'Drop the subtract test with subtract', '--why', 'subtract is removed from the product.', '--cost', 'A needed operation loses its test.', '--allows-test-removal', removed));
  p.commit(`${task.id}: ${allow.data.id}`);
  v = p.ok(p.cli('verify', task.id));
  assert.equal(v.data.result, 'pass');
  assert.deepEqual([v.data.inventory.removed, v.data.inventory.allowedBy], [[removed], [allow.data.id]]);
  review(p, task.id);
  p.ok(p.cli('task', 'done', task.id));
  p.commit(`${task.id}: done`);

  p.git('checkout', '-q', 'main');
  const m = p.ok(p.cli('task', 'merge', task.id, '--branch', task.branch));
  assert.deepEqual([m.data.merged, m.data.verify.inventory.allowedBy], [true, [allow.data.id]]);
  // T-MG-80 (intended change): the code is clean; the merge record is an uncommitted state write, like task done's.
  assert.equal(p.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '');
  assert.deepEqual(p.git('status', '--porcelain').split('\n').map((l) => l.replace(/^\s*\S+\s+/, '')), [`${names.stateDir}/tasks/${task.id}/task.json`]);
  assert.deepEqual(p.read('baseline/tests.json').tests.map((x) => x.id).filter((id) => id.includes('subtracts')), []);
});
