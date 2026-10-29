import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';

let server, base, dir;
const JSON_CT = 'application/json; charset=utf-8';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-api-'));
  server = http.createServer(createApp(openStore(path.join(dir, 'notes.json'))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (body, raw) =>
  fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

async function assertError(res, status) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('content-type'), JSON_CT);
  assert.equal(typeof (await res.json()).error, 'string');
}

test('GET /notes returns 200 and an array', async () => {
  const res = await fetch(`${base}/notes`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), JSON_CT);
  assert.ok(Array.isArray(await res.json()));
});

test('POST /notes returns 201 with the created note', async () => {
  const res = await post({ title: 'a', body: 'b' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), JSON_CT);
  const note = await res.json();
  assert.equal(note.title, 'a');
  assert.equal(note.body, 'b');
  assert.ok(note.id);
});

test('GET and DELETE by id; unknown id is 404', async () => {
  const note = await (await post({ title: 't', body: '' })).json();
  const got = await fetch(`${base}/notes/${note.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), note);
  const del = await fetch(`${base}/notes/${note.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal(await del.text(), '');
  for (const method of ['GET', 'DELETE']) {
    await assertError(await fetch(`${base}/notes/${note.id}`, { method }), 404);
  }
});

test('invalid JSON returns 400 with error', async () => {
  await assertError(await post(null, '{not json'), 400);
});

test('store TypeError returns 400 with error', async () => {
  await assertError(await post({ title: '', body: 'x' }), 400);
});

test('other paths 404, other methods 405, all JSON', async () => {
  await assertError(await fetch(`${base}/nope`), 404);
  await assertError(await fetch(`${base}/notes`, { method: 'PUT' }), 405);
  await assertError(await fetch(`${base}/notes/x`, { method: 'POST', body: '{}' }), 405);
});
