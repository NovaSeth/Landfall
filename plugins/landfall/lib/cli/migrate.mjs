// `<bin> migrate [--dry-run]` (spec §5.4, SD-10, COD-8, GC9): the forward migration chain (lib/state migrate) on every
// state document of the repository: every committed JSON kind of every unit (MIGRATE_KINDS; decision records are
// Markdown with their own schema line, and local/ is machine-local, so neither is migrated here). --dry-run lists the
// steps and writes nothing; a run copies each original to local/backup/<stamp>/ first and writes state.json last; a
// second run writes nothing. Exit 7 a newer schema (before any byte), no consent · 1 a file that does not parse · 8 not
// a git repository. An inactive repository has no state: nothing to do.
import { MANIFEST } from '../gen/index.mjs';
import { PROFILE_KINDS } from '../profile/index.mjs';
import { RECEIPT } from '../receipts/index.mjs';
import { KINDS, LAYOUTS, migrate as migrateStore, open, resolve } from '../state/index.mjs';
import { VERIFY_KINDS } from '../verify/index.mjs';

export const MIGRATE_KINDS = Object.freeze({ ...KINDS, ...PROFILE_KINDS, ...VERIFY_KINDS, [RECEIPT.name]: RECEIPT, [MANIFEST.name]: MANIFEST });

// Layout steps first (directory moves of the rename, lib/state/migrations): a dry run lists them, a run applies them
// and resolves again, as the moved directory is what makes the repository active.
export function migrate({ flags, io, names }) {
  const dryRun = Boolean(flags.dryRun);
  let where = resolve({ cwd: io.cwd, env: io.env, names });
  const layout = { moves: [] };
  for (const step of LAYOUTS) {
    const r = dryRun ? step.plan({ repo: where.repo, env: io.env, names }) : step.run({ repo: where.repo, env: io.env, names });
    layout.moves.push(...r.moves);
  }
  if (layout.moves.length && !dryRun) where = resolve({ cwd: io.cwd, env: io.env, names });
  const moved = layout.moves.map((m) => `  ${dryRun ? 'move' : 'moved'} ${m.from}/ -> ${m.to}/`);
  if (!where.active) return { data: { repo: where.repo, dryRun, layout, steps: [], backup: null }, text: `${[...moved, `${where.repo} is not active: no state to migrate`].join('\n')}\n` };
  const r = migrateStore(open(where.dir, { names, kinds: MIGRATE_KINDS }), { dryRun });
  const lines = r.steps.map((s) => `  ${s.rel}: ${s.kind} ${s.from === null ? 'new' : `schema ${s.from}`} → ${s.to} (${s.ids.join(', ')})`);
  const head = r.steps.length === 0 ? 'Nothing to migrate: every state file is at its current schema.'
    : dryRun ? `Migration steps (dry run: nothing written):` : `Migrated (originals in ${r.backup}):`;
  return { data: { repo: where.repo, dryRun, layout, ...r }, text: `${[...moved, head, ...lines].join('\n')}\n` };
}
