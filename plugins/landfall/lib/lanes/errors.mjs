// Errors of the lanes unit: a kebab-case code, the name of the spec §8.1 exit code the CLI turns it into (USAGE,
// FAIL, ENV), a message, a hint and details (the owner and times of the claim in the way), the same shape as the
// state unit's errors, so a command returns { code: EXIT[err.exit], data: err.details, errors: [err] }.
export class LaneError extends Error {
  constructor(code, exit, message, { hint = '', details = {} } = {}) {
    super(message);
    this.name = 'LaneError';
    this.code = code;
    this.exit = exit;
    this.hint = hint;
    this.details = details;
  }
}
