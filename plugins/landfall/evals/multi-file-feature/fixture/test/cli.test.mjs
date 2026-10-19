import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.mjs';
import { createStore } from '../src/store.mjs';

test('adds and lists tasks', () => {
  const store = createStore();
  assert.equal(run(['add', 'Buy', 'milk'], store), 'added [ ] #1 Buy milk');
  assert.equal(run(['list'], store), '[ ] #1 Buy milk');
});

test('completes a task', () => {
  const store = createStore();
  run(['add', 'Write', 'report'], store);
  assert.equal(run(['done', '1'], store), 'completed [x] #1 Write report');
  assert.equal(run(['done', '7'], store), 'error: no task 7');
});

test('empty list and usage', () => {
  assert.equal(run(['list'], createStore()), 'No tasks.');
  assert.match(run([], createStore()), /^usage:/);
});
