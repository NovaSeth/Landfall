// `<bin> import-1x [--from <dir>] [--handle <H>] (--dry-run | --yes)` (NICE 5, SD-48): reads a 1.x ledger; the dry run
// prints the mapping, the apply writes it through lib/state once (lib/import1x/apply.mjs) and lists the 1.x files to remove.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMap } from '../import1x/apply.mjs';
import { removalChecklist } from '../import1x/checklist.mjs';
import { readLedger, summary } from '../import1x/index.mjs';
import { PATTERNS, StateError, resolve } from '../state/index.mjs';

export function importOneX({ flags, names, io }) {
  // A dry run with --from needs no repository here.
  const where = flags.dryRun && flags.from !== undefined ? null : resolve({ cwd: io.cwd, env: io.env, names });
  const from = flags.from ?? where.repo ?? io.cwd;
  const map = readLedger(from);
  if (!map) throw new StateError('no-ledger', 'ENV', `no 1.x ledger at ${from}/.workflow/progress.md`, { hint: `give the repository root of a 1.x project: ${names.bin} import-1x --from <dir> --dry-run` });
  if (flags.dryRun) return { data: map, text: summary(map) };
  if (flags.handle !== undefined && !PATTERNS.handle.test(flags.handle)) throw new StateError('invalid-value', 'USAGE', '--handle must be 2-4 letters A-Z');
  if (!where.active) throw new StateError('inactive', 'REFUSED', 'import-1x writes only into an active repository', { hint: `${names.bin} init` });
  const source = readFileSync(join(from, '.workflow', 'progress.md'), 'utf8');
  const result = applyMap({ where, names, env: io.env, map, source, handle: flags.handle });
  const checklist = removalChecklist(from);
  const lines = [
    `imported: ${Object.keys(result.imported).length}`,
    ...Object.entries(result.imported).map(([legacy, id]) => `  ${legacy} -> ${id}`),
    `already imported: ${result.already}`,
    ...(result.notWritten.length ? [`not imported (no matching profile fact): ${result.notWritten.join(', ')}`] : []),
    `skipped lines: ${map.skipped.length}`, ...map.skipped.map((s) => `  line ${s.line}: ${s.reason}`),
    checklist.length ? 'Remove these 1.x files by hand once you have checked the import (nothing was deleted):' : 'No 1.x files left to remove.',
    ...checklist.map((c) => `  ${c}`),
  ];
  return { data: { ...result, skipped: map.skipped, checklist }, text: `${lines.join('\n')}\n` };
}
