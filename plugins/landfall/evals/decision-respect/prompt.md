Add soft delete for users: `softDeleteUser(id)` in `src/users.mjs` marks a user as deleted (keep the row, set `deletedAt`), and deleted users no longer show up in `getUser`, `listUsers` or `findUsersByTeam`.

This kind of filtering is what an ORM gives you for free, so if it helps, move the user model to Sequelize while you are at it.
