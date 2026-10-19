// `<bin> secrets [--range <revs>] [--staged] [--artifact <path>]` (spec §8.2, §11, SD-29; SEC-5, SEC-6): the secrets
// scan, read-only, loaded by its row in lib/cli/commands.mjs. Exit 0 clean · 1 findings (path:line, the pattern and a
// masked value; never the value) · 2 usage (two modes, a range with an option git would act on) · 8 the scan could not
// run, its result is invalid (not a git repository, git failing, an unreadable file or pattern file, a refused
// pattern): never 0 on an error. Context comes from io (cwd, env), never from process state.
import { EXIT } from '../cli/commands.mjs';
import { StateError } from '../state/index.mjs';
import { rangeWords, scanSecrets } from './scan.mjs';

const usage = (code, message, hint) => ({ code: EXIT.USAGE, errors: [{ code, message, hint }] });
const scope = (mode, flags) => ({ tree: 'the working tree and the index', staged: 'the staged changes', range: `the commits of ${flags.range}`, artifact: flags.artifact })[mode];

// blobMax: the largest blob read from git (tests lower it; main passes none).
export function secrets({ flags, names, io, blobMax }) {
  const modes = ['range', 'staged', 'artifact'].filter((m) => flags[m] !== undefined && flags[m] !== false);
  if (modes.length > 1) return usage('one-mode', `--${modes.join(', --')}: one mode per scan`, 'run one scan for each mode');
  const mode = modes[0] ?? 'tree';
  let revs = [];
  if (mode === 'range') {
    const r = rangeWords(flags.range);
    if (r.error) return usage('bad-range', `--range: ${r.error}`, 'pass revisions as git log takes them, such as A..B or "<sha> --not --remotes"');
    revs = r.words;
  }
  if (mode === 'artifact' && flags.artifact === '') return usage('bad-artifact', '--artifact: the path is empty', 'pass a built file or directory');
  const data = { mode, ...(mode === 'range' ? { range: flags.range } : {}), ...(mode === 'artifact' ? { artifact: flags.artifact } : {}) };

  let result;
  try {
    result = scanSecrets({ cwd: io.cwd, env: io.env, names, mode, revs, artifact: flags.artifact, ...(blobMax ? { blobMax } : {}) });
  } catch (err) {
    if (!(err instanceof StateError)) throw err;
    return {
      code: EXIT.ENV,
      data: { ...data, findings: [], skipped: [] },
      errors: [err, { code: 'scan-invalid', message: `the ${names.bin} secrets scan of ${scope(mode, flags)} could not run: its result is invalid, not clean`, hint: 'fix the error above, then scan again; never read this exit as clean' }],
    };
  }
  const { findings, skipped, scanned } = result;
  const out = { ...data, findings, skipped, scanned };
  // Never silent: every file not scanned is listed, whatever the exit.
  const notScanned = skipped.map((x) => `not scanned (${x.reason}): ${x.commit ? `${x.commit}:` : ''}${x.path}\n`).join('');
  if (!findings.length) return { data: out, text: `${notScanned}secrets: clean (${scope(mode, flags)}${skipped.length ? `; ${skipped.length} not scanned, listed above` : ''})\n` };
  const lines = findings.map((f) => (f.type === 'key-file' ? `${f.where}: key-file\n` : `${f.where}: ${f.type} ${f.masked}\n`));
  const n = findings.length;
  return {
    code: EXIT.FAIL,
    data: out,
    text: `${notScanned}${lines.join('')}`,
    errors: [{
      code: 'secrets-found',
      message: `${n} finding${n === 1 ? '' : 's'} in ${scope(mode, flags)} (values masked; open each place locally)`,
      hint: 'remove each value, rotate a real secret (SEC-7); a key or env file belongs in .gitignore; mark a synthetic test value with SYNTH on its line (SEC-11)',
    }],
  };
}
