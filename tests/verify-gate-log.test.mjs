// T-MG-153: the verify log keeps each failing test's TAP diagnostic block (the `not ok` line and its YAML block:
// error, stack, step output) next to the output tail, capped per failure and in count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers/hook-fixture.mjs';

const { logLines, tailLines } = await lib('verify/gates.mjs');
const kinds = await lib('verify/kinds.mjs');

const block = (n, extra = '') => [
  `    not ok ${n} - case ${n}`,
  '      ---',
  '      duration_ms: 12.5',
  `      error: 'step "verify T-1": exit null, signal SIGTERM${extra}'`,
  "      stack: |-",
  '        at file:1:1',
  '      ...',
];
const pad = (n) => Array.from({ length: n }, (_, i) => `ok ${i + 1} - fine ${i + 1}`);

test('logLines keeps the failing test block before the tail, and a passing run is just the tail', () => {
  const output = ['TAP version 13', ...pad(3), ...block(4), ...pad(3), '1..7', '# tests 7', '# fail 1'].join('\n');
  const lines = logLines(output);
  const text = lines.join('\n');
  assert.match(text, /not ok 4 - case 4/);
  assert.match(text, /signal SIGTERM/);
  assert.match(text, /at file:1:1/);
  assert.ok(text.endsWith(tailLines(output).join('\n')), 'the tail is still there');
  const clean = ['TAP version 13', ...pad(3), '# fail 0'].join('\n');
  assert.deepEqual(logLines(clean), tailLines(clean));
});

test('logLines caps a failure block at 4 KB and the failures at 20', () => {
  const one = logLines(block(1, ` ${'x'.repeat(10000)}`).join('\n'));
  const kept = one.slice(0, one.indexOf('--- output tail ---')).join('\n');
  assert.ok(kept.length <= 4096 + 10, `one block ${kept.length}`);
  assert.match(kept, /\[cut\]/);
  const many = Array.from({ length: 30 }, (_, i) => block(i + 1)).flat();
  const lines = logLines(many.join('\n'));
  const head = lines.slice(0, lines.indexOf('--- output tail ---')).join('\n');
  assert.equal((head.match(/not ok \d+ - case/g) ?? []).length, 20);
  assert.match(head, /case 20\b/);
  assert.doesNotMatch(head, /case 21\b/);
  assert.ok(lines.length <= kinds.TAIL_CHARS, 'fits the log schema line count');
});
