// User API.
import { findById, findWhere, insert } from './db.mjs';

export function createUser({ name, team }) {
  return insert('users', { name, team });
}

export function getUser(id) {
  return findById('users', id);
}

export function listUsers() {
  return findWhere('users', () => true);
}

export function findUsersByTeam(team) {
  return findWhere('users', (user) => user.team === team);
}
