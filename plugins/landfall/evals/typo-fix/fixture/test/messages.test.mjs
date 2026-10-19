import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyInbox, unreadCount, welcome } from '../src/messages.mjs';

test('welcome greets the user by name', () => {
  assert.match(welcome('Ada'), /Ada/);
});

test('unread count uses singular and plural', () => {
  assert.equal(unreadCount(1), 'You have 1 unread message.');
  assert.equal(unreadCount(3), 'You have 3 unread messages.');
});

test('empty inbox', () => {
  assert.equal(emptyInbox(), 'Your inbox is empty.');
});
