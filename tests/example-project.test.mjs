// The example project (T-MG-11, D-MG-21): examples/notes-api is a service built end to end with the plugin, its state
// committed next to the code. The suite keeps it honest: its own tests pass, the decisions its code cites exist, and
// the copy holds no path of the machine it was built on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const example = join(root, 'examples', 'notes-api');
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

test('the example project\'s own tests pass', { timeout: 120000 }, () => {
  const files = readdirSync(join(example, 'test')).filter((n) => n.endsWith('.test.mjs')).map((n) => join('test', n));
  assert.ok(files.length >= 3, 'the store, API and limits tests are there');
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: example, encoding: 'utf8', timeout: 110000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
});

test('every decision the example code cites exists in its committed state, and every task has a brief, a report and a verify record', () => {
  const cited = new Set();
  for (const f of walk(join(example, 'src'))) for (const [id] of readFileSync(f, 'utf8').matchAll(/\bD-[A-Z]{2,4}-\d+\b/g)) cited.add(id);
  assert.ok(cited.size >= 2, [...cited].join(' '));
  for (const id of cited) assert.ok(existsSync(join(example, '.landfall', 'decisions', `${id}.md`)), id);
  const tasks = readdirSync(join(example, '.landfall', 'tasks'));
  assert.ok(tasks.length >= 4, tasks.join(' '));
  for (const t of tasks) for (const f of ['brief.md', 'report.md', 'verify.json', 'task.json']) assert.ok(existsSync(join(example, '.landfall', 'tasks', t, f)), `${t}/${f}`);
});

test('the example copy names no path of the machine it was built on', () => {
  const hits = walk(example).filter((f) => /\/(Users|home)\/[a-z][\w.-]*\//.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => f.slice(root.length + 1)), []);
});
