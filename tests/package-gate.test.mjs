import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the npm test script bounds the test workers with --test-concurrency=<n>, 1 <= n <= 8', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const m = /(?:^|\s)--test-concurrency=(\d+)(?:\s|$)/.exec(pkg.scripts.test);
  assert.ok(m, `no bounded --test-concurrency in: ${pkg.scripts.test}`);
  const n = Number(m[1]);
  assert.ok(n >= 1 && n <= 8, `concurrency ${n} out of range`);
});
