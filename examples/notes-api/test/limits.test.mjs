import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';

let server, port, dir, store;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-limits-'));
  store = openStore(path.join(dir, 'notes.json'));
  server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => {
    server.close(r);
    server.closeAllConnections?.();
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

function request({ headers = {}, chunks, method = 'POST' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/notes', method, headers },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    for (const c of chunks ?? []) req.write(c);
    req.end();
  });
}

const JSON_H = { 'content-type': 'application/json' };

test('a 17 KiB body with content-length gets 413', async () => {
  const body = JSON.stringify({ title: 't', body: 'x'.repeat(17 * 1024) });
  const res = await request({
    headers: { ...JSON_H, 'content-length': Buffer.byteLength(body) },
    chunks: [body],
  });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.text), { error: 'body too large' });
});

test('a chunked body past the limit gets 413', async () => {
  const chunk = 'x'.repeat(4096);
  const res = await request({
    headers: { ...JSON_H, 'transfer-encoding': 'chunked' },
    chunks: ['{"title":"t","body":"', chunk, chunk, chunk, chunk, chunk, '"}'],
  });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.text), { error: 'body too large' });
});

test('a wrong content type gets 415, a charset parameter is accepted', async () => {
  const bad = await request({
    headers: { 'content-type': 'text/plain' },
    chunks: ['{"title":"t","body":""}'],
  });
  assert.equal(bad.status, 415);
  assert.equal(typeof JSON.parse(bad.text).error, 'string');
  const ok = await request({
    headers: { 'content-type': 'application/json; charset=utf-8' },
    chunks: ['{"title":"t","body":""}'],
  });
  assert.equal(ok.status, 201);
});

test('an unexpected error returns exactly {"error":"internal error"} and logs once', async () => {
  const err = mock.method(console, 'error', () => {});
  const orig = store.list;
  store.list = () => {
    throw new Error('/secret/path');
  };
  try {
    const res = await request({ method: 'GET' });
    assert.equal(res.status, 500);
    assert.equal(res.text, '{"error":"internal error"}');
    assert.equal(err.mock.callCount(), 1);
  } finally {
    store.list = orig;
    err.mock.restore();
  }
});

for (const [name, make] of [
  ['TypeError', () => new TypeError('/secret/path')],
  ['URIError', () => new URIError('/secret/path')],
]) {
  test(`an unexpected ${name} from the store returns 500 internal error and logs once`, async () => {
    const err = mock.method(console, 'error', () => {});
    const orig = store.list;
    store.list = () => {
      throw make();
    };
    try {
      const res = await request({ method: 'GET' });
      assert.equal(res.status, 500);
      assert.equal(res.text, '{"error":"internal error"}');
      assert.equal(err.mock.callCount(), 1);
    } finally {
      store.list = orig;
      err.mock.restore();
    }
  });
}

test('after the overflow no more body bytes reach the request, also after the 413 finishes', async () => {
  let emitted = 0;
  const handler = createApp(store);
  const srv = http.createServer((req, res) => {
    const emit = req.emit;
    req.emit = function (ev, ...args) {
      if (ev === 'data') emitted += args[0].length;
      return emit.call(this, ev, ...args);
    };
    return handler(req, res);
  });
  // An in-memory connection: the whole request arrives in one buffer, so the
  // outcome does not depend on socket timing.
  const parts = ['{"title":"t","body":"', ...Array(9).fill('x'.repeat(4096)), '"}'];
  const raw =
    'POST /notes HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n' +
    parts.map((c) => `${Buffer.byteLength(c).toString(16)}\r\n${c}\r\n`).join('') +
    '0\r\n\r\n';
  let sent = false;
  let got = '';
  const conn = new Duplex({
    read() {
      if (!sent) {
        sent = true;
        this.push(Buffer.from(raw));
      }
    },
    write(chunk, enc, cb) {
      got += chunk;
      cb();
    },
  });
  const closed = new Promise((r) => conn.on('close', r));
  srv.emit('connection', conn);
  await closed;
  assert.match(got, /^HTTP\/1\.1 413 /);
  assert.ok(emitted <= 16 * 1024 + 4096, `request emitted ${emitted} bytes`);
});
