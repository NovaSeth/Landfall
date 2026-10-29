import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-store-'));
  return { dir, file: path.join(dir, 'notes.json') };
}

test('a missing file reads as no notes', () => {
  const { file } = tmpFile();
  const s = openStore(file);
  assert.deepEqual(s.list(), []);
  assert.equal(s.get('x'), null);
  assert.equal(s.remove('x'), false);
});

test('create returns a note; list is oldest first; get and remove work', () => {
  const { file } = tmpFile();
  const s = openStore(file);
  const a = s.create({ title: 'a', body: 'one' });
  const b = s.create({ title: 'b', body: '' });
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(a.createdAt).toISOString(), a.createdAt);
  assert.deepEqual(s.list().map((n) => n.id), [a.id, b.id]);
  assert.deepEqual(s.get(a.id), a);
  assert.equal(s.remove(a.id), true);
  assert.equal(s.remove(a.id), false);
  assert.equal(s.get(a.id), null);
});

test('1: notes survive a new openStore on the same file', () => {
  const { file } = tmpFile();
  const n = openStore(file).create({ title: 't', body: 'b' });
  assert.deepEqual(openStore(file).list(), [n]);
});

test('2: writes go through a temp file renamed onto the file', () => {
  const { dir, file } = tmpFile();
  const calls = [];
  const orig = fs.renameSync;
  fs.renameSync = (from, to) => { calls.push([from, to]); return orig(from, to); };
  try {
    openStore(file).create({ title: 't', body: 'b' });
  } finally {
    fs.renameSync = orig;
  }
  assert.equal(calls.length, 1);
  assert.match(path.basename(calls[0][0]), /^notes\.json\.tmp-.+/);
  assert.equal(calls[0][1], file);
  assert.deepEqual(fs.readdirSync(dir), ['notes.json']);
});

test('3: a corrupt file throws an Error naming the file', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => openStore(file).list(), (e) => e instanceof Error && e.message.includes(file));
  fs.writeFileSync(file, '{"a":1}');
  assert.throws(() => openStore(file).list(), (e) => e instanceof Error && e.message.includes(file));
  assert.throws(() => openStore(file).create({ title: 't', body: '' }), (e) => e.message.includes(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
});

test('4: create validates title and body with a TypeError', () => {
  const { file } = tmpFile();
  const s = openStore(file);
  const bad = [
    { title: '', body: '' }, { title: 5, body: '' }, { title: 'x'.repeat(201), body: '' },
    { title: 't', body: 5 }, { title: 't' }, { title: 't', body: 'x'.repeat(10001) },
  ];
  for (const input of bad) assert.throws(() => s.create(input), TypeError);
  assert.throws(() => s.create(undefined), TypeError);
  assert.doesNotThrow(() => s.create({ title: 'x'.repeat(200), body: 'y'.repeat(10000) }));
  assert.equal(s.list().length, 1);
});
