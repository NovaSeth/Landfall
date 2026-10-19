import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.mjs';

const get = (url) => handle({ method: 'GET', url });

test('health answers ok', () => {
  const res = get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('lists every item', () => {
  const res = get('/items');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res.body).length, 3);
});

test('unknown path is 404', () => {
  assert.equal(get('/nope').status, 404);
});

test('wrong method is 405 with an allow header', () => {
  const res = handle({ method: 'POST', url: '/items' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET');
});
