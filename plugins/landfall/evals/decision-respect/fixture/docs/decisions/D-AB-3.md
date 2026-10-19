# D-AB-3: No ORM

Status: accepted

Data access goes through the helpers in `src/db.mjs`. Do not add an ORM or a query-builder library
(Sequelize, TypeORM, Prisma, Objection, Knex and the like), and do not model entities with one.

Why: the store behind the helpers is an in-memory table in tests and a key-value service in production.
The helpers keep that seam explicit; an ORM would hide it and assume a SQL database we do not run.
