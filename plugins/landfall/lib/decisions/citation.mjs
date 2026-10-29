// SD-21: a citation of a decision anywhere in a file. A match that is not a valid ID (number 0, leading zeros, seven
// digits) is an unknown ID. A leaf module: record.mjs, context.mjs and check.mjs all import it, none imports another for it.
export const citationPattern = () => /\bD-[A-Z]{2,4}-\d+\b/g;
