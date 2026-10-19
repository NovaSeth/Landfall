// JSON envelope (spec §8.1): with --json every command prints exactly one line
// {"cli":1,"command","ok","code","exit","data","errors":[{"code","message","hint"}]}; ok is true exactly when
// code is 0. Error codes are kebab-case; messages and hints are clipped to their limits. lib/cli/output.mjs writes
// the line.
import { EXIT_CODES } from './commands.mjs';

export const ENVELOPE_VERSION = 1;
export const LIMITS = { message: 300, hint: 200 };
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function normalizeError(e) {
  return {
    code: typeof e?.code === 'string' && KEBAB.test(e.code) ? e.code : 'error',
    message: clip(e?.message || 'error', LIMITS.message),
    hint: clip(e?.hint ?? '', LIMITS.hint),
  };
}

export function envelope({ command, code, data = {}, errors = [] }) {
  const exit = EXIT_CODES.find((e) => e.code === code);
  if (!exit) throw new Error(`exit code ${code} is not in the command table`);
  return { cli: ENVELOPE_VERSION, command: String(command), ok: code === 0, code, exit: exit.name, data, errors: errors.map(normalizeError) };
}
