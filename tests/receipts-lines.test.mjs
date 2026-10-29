// Transcript line reader (audit F2-5): a pending line is capped at 1 MiB; past it the reader skips to the next newline
// and counts the line as skipped, and the work per chunk is linear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lib, names } from './helpers/hook-fixture.mjs';

const { eachLine, parseTranscript } = await lib('receipts/transcript.mjs');
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lines-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const MiB = 1024 * 1024;
const usage = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm1', model: 'x', usage: { input_tokens: 3, output_tokens: 4 }, content: [] } });

test('eachLine: a 5 MiB line without a newline is skipped and counted, the next line is read, in time', (t) => {
  const file = join(temp(t), 't.jsonl');
  writeFileSync(file, `${'x'.repeat(5 * MiB)}\n${usage}\n`);
  const got = []; let skipped = 0;
  const start = Date.now();
  const open = eachLine(file, (l) => got.push(l), { onSkip: () => { skipped++; } });
  assert.ok(Date.now() - start < 2000, 'under 2000 ms');
  assert.deepEqual(got, [usage]);
  assert.equal(skipped, 1);
  assert.equal(open, false);
});

test('eachLine: a long unterminated last line is skipped; lines at the cap and the ordinary lines are kept', (t) => {
  const file = join(temp(t), 't.jsonl');
  const edge = 'y'.repeat(MiB);
  writeFileSync(file, `a\n${edge}\nb\r\n${'z'.repeat(2 * MiB + 5)}`);
  const got = []; let skipped = 0;
  const open = eachLine(file, (l) => got.push(l), { onSkip: () => { skipped++; } });
  assert.deepEqual(got, ['a', edge, 'b']);
  assert.equal(skipped, 1);
  assert.equal(open, true);
});

test('parseTranscript: the skipped line counts as malformed and the usage line after it is parsed', (t) => {
  const file = join(temp(t), 't.jsonl');
  writeFileSync(file, `${'"usage"'.repeat(Math.ceil(5 * MiB / 7))}\n${usage}\n`);
  const r = parseTranscript(file, { bin: names.bin });
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].tokens.output, 4);
  assert.equal(r.malformed, 1);
});
