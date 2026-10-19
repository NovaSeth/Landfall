// Secret patterns (spec §8.2 `secrets`, §11; SEC-5, SEC-11): the one source of every secret pattern of the plugin. The
// scanner (scan.mjs) reads them here, and so does every later consumer (the redaction of gate output); no other file
// defines one (tests/secrets.test.mjs).
// The built-in list is the 1.x check-secrets.sh list (POSIX ERE, matched by git grep and grep in the C locale) written
// as JS regular expressions with the same language: text is matched as bytes (the scanner decodes it as latin1, one
// character per byte, so a length counts bytes as 1.x did), [[:space:]] is the six C-locale space characters and a
// `.` is any byte but a newline. Matching (leftmost-first here, leftmost-longest in ERE) can differ only in the span
// of a match, never in whether a line matches (tests/secrets-differential.test.mjs).
// A line holding the synthetic marker is no finding in the repository modes (SEC-11): the marker is a separate word in
// the line's text (so SYNTHESIS_API_KEY is no marker), never in its path. Key and env files are findings by name alone.
// Project patterns: <state directory>/secrets-patterns.txt, one per line, the syntax of guard-extra.txt (a JS regular
// expression with POSIX classes in brackets; lib/guard/extra.mjs); `#` starts a comment at the start of a line or
// after a space. A pattern that does not compile or has a nested quantifier makes the scan invalid: refused, never
// skipped (the scan would be weaker than the project asked for). Its error names the line and a reason, never the
// pattern's text: a project pattern can be a literal secret.
import { extraRegExp, nestedQuantifier } from '../guard/extra.mjs';

const SPACE = ' \\t\\n\\v\\f\\r';
const S = `[${SPACE}]`;
// "api" → "[Aa][Pp][Ii]": key names match in any case.
const anyCase = (word) => word.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
// A key name in any convention: api_key, apiKey, API_KEY, clientSecret, DB_PASSWORD, "password", authToken.
const KEY = `(${anyCase('api')}[_-]?${anyCase('key')}|${anyCase('secret')}|${anyCase('token')}|${anyCase('password')}|${anyCase('passwd')}|${anyCase('private')}[_-]?${anyCase('key')})([_-]?${anyCase('key')})?`;
// key: "value" / key = 'value' / "key": "value" / key := "value" / key => "value": up to the opening quote.
const ASSIGNED = `${KEY}["']?${S}*(:=|=>|[:=])${S}*["']`;
// A character of a quoted value: no quote, space, $, <, >, {, } or *, so ${VAR}, <placeholder> and ***** are no value.
const VALUE = `[^"'${SPACE}$<>{}*]`;
const AFTER_COLON = `[^/"'${SPACE}$<>{}*]`; // a colon not followed by "/" (an address)

// [id, source]; ids name the finding type, the first matching source names it. Several sources may share an id.
const BUILT_IN = [
  ['github-token', 'gh[pousr]_[A-Za-z0-9]{30,}'],
  ['github-token', 'github_pat_[A-Za-z0-9_]{40,}'],
  ['anthropic-key', 'sk-ant-[A-Za-z0-9_-]{20,}'],
  ['openai-key', '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}'],
  ['aws-access-key', 'AKIA[0-9A-Z]{16}'],
  ['slack-token', 'xox[baprs]-[A-Za-z0-9-]{10,}'],
  ['google-api-key', 'AIza[0-9A-Za-z_-]{35}'],
  ['private-key', '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'],
  ['bearer-token', `[Bb]earer${S}+[A-Za-z0-9_.~+/-]{20,}`], // an Authorization header with a token
  ['jwt', 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}'],
  // A literal quoted value of at least 12 characters without a colon (so addresses and test IDs such as user:x are no
  // value); password characters (.!@#%…) are value characters.
  ['assigned-secret', `${ASSIGNED}[^"'${SPACE}$<>{}*:]{12,}["']`],
  // A quoted value with a colon is one only with a password character (!@#%^&) and no ":/" (an address).
  ['assigned-secret', `${ASSIGNED}${VALUE}*:${AFTER_COLON}${VALUE}*[!@#%^&]${VALUE}*["']`],
  ['assigned-secret', `${ASSIGNED}${VALUE}*[!@#%^&]${VALUE}*:${AFTER_COLON}${VALUE}*["']`],
  // YAML without quotes: api_key: value (16 or more characters, up to the end of the line or a comment).
  ['assigned-secret', `${KEY}${S}*:${S}+[A-Za-z0-9_/+=-]{16,}${S}*(#[^\\n]*)?$`],
  ['url-secret', '[?&](token|api_key|apikey|access_token)=[A-Za-z0-9_-]{8,}'],
  ['env-secret', '(^|[^A-Z_])[A-Z_]*(API_KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*=["\']?[A-Za-z0-9_/+=-]{12,}'], // KEY=value in env and config files
];

export const PATTERNS = Object.freeze(BUILT_IN.map(([id, source]) => Object.freeze({ id, re: new RegExp(source) })));
// One alternation of the built-in sources: a line that does not match it matches no built-in pattern (they hold no
// back-reference, so the groups may be renumbered).
const ANY_BUILT_IN = new RegExp(PATTERNS.map((p) => `(?:${p.re.source})`).join('|'));

// The synthetic marker of test values (SEC-11): a separate word anywhere in the line's text.
export const SYNTHETIC = /\bSYNTH\b|\bcheck-secrets: synthetic\b/;
export const isSynthetic = (line) => SYNTHETIC.test(line);

// Key stores, certificates and env files never belong in a repository or a build, in any directory; examples,
// samples and templates of them do.
const KEY_FILE = /(?:^|\/)(?:[^/]*\.(?:keystore|jks|p12|pfx|pem|key)|\.env(?:\.[^/]*)?)$/;
const KEY_FILE_TEMPLATE = /\.(?:example|sample|template)$/;
export const isKeyFile = (path) => KEY_FILE.test(path) && !KEY_FILE_TEMPLATE.test(path);
// Files whose content the repository modes do not scan: bun's binary lockfile. Text lockfiles are scanned (a registry
// token in a "resolved" address is a real leak).
export const skipsContent = (path) => /\.lockb$/.test(path);

// Project patterns from the text of secrets-patterns.txt (latin1, as the lines it is matched against):
// { patterns: [{ id: 'project:<line>', re }], errors: [{ line, message }] }.
export function projectPatterns(text) {
  const patterns = [];
  const errors = [];
  text.split('\n').forEach((raw, k) => {
    const comment = raw.search(/[ \t\n\v\f\r]#/);
    const line = (comment < 0 ? raw : raw.slice(0, comment)).replace(/^[ \t\v\f\r]+|[ \t\v\f\r]+$/g, '');
    if (line === '' || line.startsWith('#')) return;
    let re;
    try { re = extraRegExp(line); } catch (err) { errors.push({ line: k + 1, message: reasonOf(err) }); return; }
    if (nestedQuantifier(re.source)) { errors.push({ line: k + 1, message: 'a nested quantifier such as (a+)+ can take exponential time' }); return; }
    patterns.push(Object.freeze({ id: `project:${k + 1}`, re }));
  });
  return { patterns, errors };
}

// Why a pattern does not compile, without its text: the engine's reason for a syntax error ("Invalid regular expression:
// /<pattern>/: Unterminated group" → "Unterminated group"), a fixed phrase for the POSIX translation.
function reasonOf(err) {
  if (err instanceof SyntaxError) {
    const reason = /: ([A-Za-z][A-Za-z ']{2,60})$/.exec(err.message)?.[1];
    return `not a valid regular expression${reason ? ` (${reason.toLowerCase()})` : ''}`;
  }
  if (/^unknown POSIX class/.test(err.message)) return 'an unknown POSIX class';
  if (/^unsupported bracket expression/.test(err.message)) return 'an unsupported bracket expression ([. .] or [= =])';
  if (/^an empty pattern/.test(err.message)) return 'an empty pattern';
  return 'not a valid pattern';
}

// The first pattern matching a line: { id, index, text } or null. extra: the project patterns.
export function matchLine(line, extra = []) {
  if (ANY_BUILT_IN.test(line)) {
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (m) return { id: p.id, index: m.index, text: m[0] };
    }
  }
  for (const p of extra) {
    const m = p.re.exec(line);
    if (m) return { id: p.id, index: m.index, text: m[0] };
  }
  return null;
}

// A matched text as it may be shown: its first characters (at most 4, a quarter of it) and its length. The first
// characters of a built-in match are a format prefix or a key name; the rest of the value is never shown.
export function mask(text) {
  const shown = Math.min(4, Math.floor(text.length / 4));
  return `${text.slice(0, shown)}${'*'.repeat(8)} (${text.length} chars)`;
}
