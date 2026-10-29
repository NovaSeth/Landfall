// Secrets unit (spec §8.2 `secrets`, §11, SD-29): the public interface. patterns.mjs is the one source of secret
// patterns (the scanner here and the redaction of gate output read it); scan.mjs scans a repository, its staged
// changes, a commit range or a built artifact; command.mjs is the CLI command.
export { PATTERNS, SYNTHETIC, WINDOW_SIZE, WINDOW_OVERLAP, MAX_PATTERN_SPAN, isFixturePath, isKeyFile, isSynthetic, mask, matchLine, projectPatterns } from './patterns.mjs';
export { MODES, PATTERN_FILE, rangeWords, scanSecrets } from './scan.mjs';
