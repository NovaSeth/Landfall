// `<bin> import-1x [--from <dir>] --dry-run` (NICE 5, SD-48): slice 1 reads a 1.x ledger and prints the mapping.
import { readLedger, summary } from '../import1x/index.mjs';
import { StateError, resolve } from '../state/index.mjs';
import { EXIT } from './commands.mjs';

export function importOneX({ flags, names, io }) {
  if (!flags.dryRun) {
    return { code: EXIT.REFUSED, errors: [{ code: 'apply-unavailable', message: 'import-1x writes nothing yet', hint: `use --dry-run; apply comes in the next release step` }] };
  }
  const from = flags.from ?? resolve({ cwd: io.cwd, env: io.env, names }).repo ?? io.cwd;
  const map = readLedger(from);
  if (!map) throw new StateError('no-ledger', 'ENV', `no 1.x ledger at ${from}/.workflow/progress.md`, { hint: `give the repository root of a 1.x project: ${names.bin} import-1x --from <dir> --dry-run` });
  return { data: map, text: summary(map) };
}
