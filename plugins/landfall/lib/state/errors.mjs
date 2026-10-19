// Errors of the state unit: a kebab-case code, the name of the spec §8.1 exit code the CLI turns it into
// (REFUSED, USAGE, FAIL, ENV, INTERNAL; the numbers live in lib/cli/commands.mjs), a message and a hint, so a
// command returns { code: EXIT[err.exit], errors: [err] } unchanged.
export class StateError extends Error {
  constructor(code, exit, message, { hint = '', details } = {}) {
    super(message);
    this.name = 'StateError';
    this.code = code;
    this.exit = exit;
    this.hint = hint;
    if (details !== undefined) this.details = details;
  }
}

// SC10, SD-10: a schema newer than this plugin knows refuses every write, before any byte is written.
export function newerSchema(names, what, found, known) {
  return new StateError('schema-newer', 'REFUSED', `${what} has schema ${found}; this plugin knows schema ${known} and refuses to write`, {
    hint: `update the plugin (claude plugin update ${names.plugin}@${names.marketplace}), then retry`,
  });
}

// A file system that refuses access (permissions, a read-only or full volume) is an environment problem (exit 8):
// the error names the path; other errors pass unchanged.
const FS_ENV = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT']);
export function fsFailure(err) {
  if (!FS_ENV.has(err?.code)) return err;
  return new StateError('write-failed', 'ENV', `${err.syscall ?? 'access'} ${err.path ?? 'the state directory'}: ${err.code}`, {
    hint: 'check the permissions and free space of that directory, then retry',
  });
}

// Runs fn and turns such a file system refusal into write-failed.
export function guarded(fn) {
  try {
    return fn();
  } catch (err) {
    throw fsFailure(err);
  }
}
