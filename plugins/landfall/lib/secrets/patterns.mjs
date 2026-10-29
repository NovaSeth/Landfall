// Secret patterns (spec §8.2 `secrets`, §11; SEC-5, SEC-11): the one source of every secret pattern of the plugin. The
// scanner (scan.mjs) reads them here, and so does every later consumer (the redaction of gate output); no other file
// defines one (tests/secrets.test.mjs).
// The built-in list is the 1.x check-secrets.sh list (POSIX ERE, matched by git grep and grep in the C locale) written
// as JS regular expressions with bounded probes: text is matched as bytes (the scanner decodes it as latin1, one
// character per byte, so a length counts bytes as 1.x did), [[:space:]] is the six C-locale space characters and a
// `.` is any byte but a newline. Matching (leftmost-first here, leftmost-longest in ERE) can differ only in the span
// of a match; the historical corpus remains covered (tests/secrets-differential.test.mjs).
// Only a test/fixture path can exempt a line with a separate-word synthetic marker (SEC-11).
// Key and env files are findings by name alone.
// Project patterns: <state directory>/secrets-patterns.txt, one per line, the syntax of guard-extra.txt (a JS regular
// expression with POSIX classes in brackets; lib/guard/extra.mjs); `#` starts a comment at the start of a line or
// after a space. A pattern that does not compile or has a nested quantifier makes the scan invalid: refused, never
// skipped (the scan would be weaker than the project asked for). Its error names the line and a reason, never the
// pattern's text: a project pattern can be a literal secret.
import { extraRegExp, nestedQuantifier } from '../guard/extra.mjs';

// Regex work is bounded, including on minified output. The longest built-in span is
// below 2048 characters (URL userinfo: at most 1351); a 2048-character overlap
// therefore contains every cross-boundary match. Values use a 1024-character probe.
// A hit on a line longer than that probe masks the entire line, including any tail.
export const WINDOW_SIZE = 4096;
export const MAX_PATTERN_SPAN = 2048;
export const WINDOW_OVERLAP = MAX_PATTERN_SPAN;
const VALUE_LIMIT = 1024;
const SPACE = ' \\t\\n\\v\\f\\r';
const S = `[${SPACE}]`;
const anyCase = (word) => word.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
const KEY = `(?:${anyCase('api')}[_-]?${anyCase('key')}|${anyCase('secret')}|${anyCase('token')}|${anyCase('password')}|${anyCase('passwd')}|${anyCase('private')}[_-]?${anyCase('key')})(?:[_-]?${anyCase('key')})?`;
const ASSIGNED = `${KEY}["']?${S}{0,64}(?::=|=>|[:=])${S}{0,64}["']`;
const VALUE = `[^"'${SPACE}$<>{}*]`;
const KEYWORDS = ['api', 'secret', 'token', 'password', 'passwd', 'private'];
const keywordLine = (line) => { const lower = line.toLowerCase(); return KEYWORDS.some((word) => lower.indexOf(word) !== -1); };
const quotedValue = (m) => {
  const value = m[1];
  if (value.indexOf(':') < 0) return value.length >= 12;
  return value.indexOf(':/') < 0 && /[!@#%^&]/.test(value) && /:[^/"' \t\n\v\f\r$<>{}*]/.test(value);
};
const passwordValue = (m) => !['password', 'pass'].includes(m[1].toLowerCase());

// [id, source, keyword-only, optional predicate]. No overlapping unbounded repeats.
const BUILT_IN = [
  ['github-token', 'gh[pousr]_[A-Za-z0-9]{30,1024}'],
  ['github-token', 'github_pat_[A-Za-z0-9_]{40,1024}'],
  ['anthropic-key', 'sk-ant-[A-Za-z0-9_-]{20,1024}'],
  ['openai-key', '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,1024}'],
  ['aws-access-key', 'AKIA[0-9A-Z]{16}'],
  ['slack-token', 'xox[baprs]-[A-Za-z0-9-]{10,1024}'],
  ['google-api-key', 'AIza[0-9A-Za-z_-]{35}'],
  ['private-key', '-----BEGIN (?:[A-Z]{1,64} )?PRIVATE KEY-----'],
  ['private-key', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
  ['npm-token', 'npm_[A-Za-z0-9]{36}'],
  ['npm-token', `_authToken=${S}{0,64}["']?[A-Za-z0-9_/+=-]{12,1024}`, true],
  ['aws-secret-key', `aws_secret_access_key${S}{0,64}=${S}{0,64}["']?[A-Za-z0-9/+=]{40}`, true],
  ['stripe-key', '[sr]k_live_[A-Za-z0-9]{24,1024}'],
  ['gitlab-token', 'glpat-[A-Za-z0-9_-]{20,1024}'],
  ['url-password', '[A-Za-z][A-Za-z0-9+.-]{0,63}://[^:/@\\s"\'<>]{1,256}:([^/@\\s"\'$<>{}*]{3,1024})@[^/\\s"\'<>]', false, passwordValue],
  ['bearer-token', `[Bb]earer${S}{1,64}[A-Za-z0-9_.~+/-]{20,1024}`],
  ['jwt', 'eyJ[A-Za-z0-9_-]{10,512}\\.eyJ[A-Za-z0-9_-]{10,512}'],
  // Check colon/password semantics after one value scan, never with overlapping VALUE* repeats.
  ['assigned-secret', `${ASSIGNED}(${VALUE}{1,1024})["']`, true, quotedValue],
  // A full probe is evidence even if the closing quote is beyond the window.
  ['assigned-secret', `${ASSIGNED}(${VALUE}{1024})`, true, quotedValue],
  ['assigned-secret', `${KEY}${S}{0,64}:${S}{1,64}[A-Za-z0-9_/+=-]{16,1024}${S}{0,64}(?=#|$)`, true],
  ['url-secret', '[?&](?:token|api_key|apikey|access_token)=[A-Za-z0-9_-]{8,1024}', true],
  // Start at the keyword, not an overlapping arbitrary uppercase prefix.
  ['env-secret', '(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z_]{0,128}=["\']?[A-Za-z0-9_/+=-]{12,1024}', true],
];
export const PATTERNS = Object.freeze(BUILT_IN.map(([id, source, keyword, accept]) => Object.freeze({ id, re: new RegExp(source, 'g'), keyword, accept })));

// The synthetic marker of test values (SEC-11): a separate word anywhere in the line's text.
export const SYNTHETIC = /\bSYNTH\b|\bcheck-secrets: synthetic\b/;
export const isSynthetic = (line) => SYNTHETIC.test(line);

// Key stores, certificates and env files never belong in a repository or a build, in any directory; examples,
// samples and templates of them do.
const KEY_FILE_TEMPLATE = /\.(?:example|sample|template)$/;
export const isKeyFile = (path) => {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return !KEY_FILE_TEMPLATE.test(file) && (/\.(?:keystore|jks|p12|pfx|pem|key)$/.test(file) || /^\.env(?:\.[^/]*)?$/.test(file) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.npmrc)$/.test(file));
};
export const isFixturePath = (path) => {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  return parts.some((part) => ['test', 'tests', '__tests__', 'fixtures', 'testdata', 'spec'].includes(part)) || ['.test.', '.spec.'].some((word) => {
    const at = file.indexOf(word);
    return at >= 0 && at + word.length < file.length;
  });
};
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
    const body = comment < 0 ? raw : raw.slice(0, comment);
    let start = 0;
    let end = body.length;
    while (start < end && ' \t\v\f\r'.includes(body[start])) start++;
    while (end > start && ' \t\v\f\r'.includes(body[end - 1])) end--;
    const line = body.slice(start, end);
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
  for (let offset = 0; offset < line.length; offset += WINDOW_SIZE - WINDOW_OVERLAP) {
    const window = line.slice(offset, offset + WINDOW_SIZE);
    const keywords = keywordLine(window);
    for (const p of [...PATTERNS, ...extra]) {
      if (p.keyword && (!keywords || (window.indexOf('=') < 0 && window.indexOf(':') < 0))) continue;
      if (p.id === 'url-password' && window.indexOf('://') < 0) continue;
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(window))) {
        if (!p.accept || p.accept(m)) {
          // Conservative redaction prevents leaking the rest of a long token and avoids
          // repeated rescans of a long line containing many tokens in verify/redact.mjs.
          return line.length > VALUE_LIMIT
            ? { id: p.id, index: 0, text: line }
            : { id: p.id, index: offset + m.index, text: m[0] };
        }
        if (!p.re.global || m[0].length === 0) break;
      }
    }
    if (offset + WINDOW_SIZE >= line.length) break;
  }
  return null;
}

// A matched text as it may be shown: its first characters (at most 4, a quarter of it) and its length. The first
// characters of a built-in match are a format prefix or a key name; the rest of the value is never shown.
export function mask(text) {
  const shown = Math.min(4, Math.floor(text.length / 4));
  return `${text.slice(0, shown)}${'*'.repeat(8)} (${text.length} chars)`;
}
