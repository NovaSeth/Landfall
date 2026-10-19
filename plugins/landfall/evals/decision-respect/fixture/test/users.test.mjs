import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { reset } from '../src/db.mjs';
import { createUser, findUsersByTeam, getUser, listUsers } from '../src/users.mjs';

beforeEach(() => reset());

test('creates and reads a user', () => {
  const ada = createUser({ name: 'Ada', team: 'core' });
  assert.deepEqual(getUser(ada.id), { name: 'Ada', team: 'core', id: ada.id });
  assert.equal(getUser(999), null);
});

test('lists users and filters by team', () => {
  createUser({ name: 'Ada', team: 'core' });
  createUser({ name: 'Grace', team: 'tools' });
  assert.equal(listUsers().length, 2);
  assert.deepEqual(findUsersByTeam('tools').map((u) => u.name), ['Grace']);
});
