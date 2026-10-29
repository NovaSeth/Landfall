// readRegularFile (T-MG-75, audit D8): one safe reader for a file named by the user (--from <file>). It opens with
// O_NOFOLLOW and O_NONBLOCK, looks at the descriptor (never the path), and refuses anything but a regular file of at
// most `max` bytes without blocking: a link, a FIFO, a directory, an oversize file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lib } from './helpers/hook-fixture.mjs';

const fsx = await lib('fsx/index.mjs');

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'fsx-read-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const refused = (fn, code) => assert.throws(fn, (err) => err.code === code, `refused with ${code}`);

test('a regular file is read as a buffer, up to max bytes', (t) => {
  const d = dir(t);
  writeFileSync(join(d, 'a.txt'), 'hello');
  const buf = fsx.readRegularFile(join(d, 'a.txt'), { max: 5 });
  assert.equal(buf.toString('utf8'), 'hello');
  writeFileSync(join(d, 'empty'), '');
  assert.equal(fsx.readRegularFile(join(d, 'empty'), { max: 5 }).length, 0);
});

test('an oversize file is refused before it is read', (t) => {
  const d = dir(t);
  writeFileSync(join(d, 'big'), 'x'.repeat(11));
  refused(() => fsx.readRegularFile(join(d, 'big'), { max: 10 }), 'ETOOBIG');
});

test('a symbolic link is refused, also to a regular file', (t) => {
  const d = dir(t);
  writeFileSync(join(d, 'real'), 'x');
  symlinkSync(join(d, 'real'), join(d, 'link'));
  refused(() => fsx.readRegularFile(join(d, 'link'), { max: 10 }), 'ENOTREGULAR');
});

test('a directory and a missing file are refused with their own codes', (t) => {
  const d = dir(t);
  mkdirSync(join(d, 'sub'));
  refused(() => fsx.readRegularFile(join(d, 'sub'), { max: 10 }), 'ENOTREGULAR');
  refused(() => fsx.readRegularFile(join(d, 'nope'), { max: 10 }), 'ENOENT');
});

test('a FIFO is refused without blocking', { timeout: 20000 }, (t) => {
  const d = dir(t);
  const made = spawnSync('mkfifo', [join(d, 'pipe')]);
  if (made.status !== 0) return t.skip('no mkfifo on this platform');
  const started = Date.now();
  refused(() => fsx.readRegularFile(join(d, 'pipe'), { max: 10 }), 'ENOTREGULAR');
  assert.ok(Date.now() - started < 5000, 'returned at once');
});

// Fix round 1 (review r1, F2): a file that grows after fstat is read to its end or refused, never cut at its old size.
test('F2: a file that grows after fstat is refused when it passes max, read whole when it stays within it', () => {
  const content = Buffer.from(`{"a":1}${' '.repeat(44)}`); // 51 bytes, valid JSON in its first bytes
  const fake = (bytes) => {
    let pos = 0;
    return {
      openSync: () => 99, closeSync: () => {}, lstatSync: () => ({ isFile: () => true, dev: 1, ino: 1 }),
      fstatSync: () => ({ isFile: () => true, size: 10, dev: 1, ino: 1 }),
      readSync: (fd, buf, off, len) => { const n = Math.min(len, bytes.length - pos); bytes.copy(buf, off, pos, pos + n); pos += n; return n; },
    };
  };
  assert.throws(() => fsx.readRegularFile('/x', { max: 20, fs: fake(content) }), (err) => err.code === 'ETOOBIG');
  assert.equal(fsx.readRegularFile('/x', { max: 60, fs: fake(content) }).length, 51);
});
