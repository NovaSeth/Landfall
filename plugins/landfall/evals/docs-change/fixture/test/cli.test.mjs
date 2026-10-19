import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, parseArgs } from '../src/cli.mjs';

test('parses flags and the directory', () => {
  assert.deepEqual(parseArgs(['--quiet', 'downloads']), { verbose: false, quiet: true, help: false, dir: 'downloads' });
});

test('quiet keeps errors only', () => {
  const seen = [];
  const out = { log: (m) => seen.push(['log', m]), error: (m) => seen.push(['error', m]) };
  const log = createLogger({ verbose: true, quiet: true }, out);
  log.info('moved a.txt');
  log.debug('scanning');
  log.error('cannot move b.txt');
  assert.deepEqual(seen, [['error', 'cannot move b.txt']]);
});
