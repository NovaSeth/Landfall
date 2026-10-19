import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook } from '../src/webhook.mjs';

const post = (body, headers = {}) => ({ method: 'POST', headers, body });

test('accepts a JSON event', () => {
  assert.equal(handleWebhook(post('{"type":"payment.settled"}')).status, 202);
});

test('rejects malformed JSON', () => {
  assert.equal(handleWebhook(post('{')).status, 400);
});

test('only POST is accepted', () => {
  assert.equal(handleWebhook({ method: 'GET', headers: {}, body: '' }).status, 405);
});
