import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('lower-cases and joins words with dashes', () => {
  assert.equal(slugify('Simple Title'), 'simple-title');
});

test('keeps digits', () => {
  assert.equal(slugify('Release 42'), 'release-42');
});

test('collapses repeated separators', () => {
  assert.equal(slugify('Hello,  World!'), 'hello-world');
});
