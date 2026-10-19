// Errors of the router unit: a kebab-case code, the name of the spec §8.1 exit code the CLI turns it into (USAGE,
// FAIL, REFUSED; the numbers live in lib/cli/commands.mjs), a message and a hint, the same shape as the state
// unit's errors, so a command returns { code: EXIT[err.exit], errors: [err] } for either.
export class RouteError extends Error {
  constructor(code, exit, message, { hint = '' } = {}) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

export const usage = (code, message, hint = '') => new RouteError(code, 'USAGE', message, { hint });
