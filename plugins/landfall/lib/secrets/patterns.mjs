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
// after a space. A pattern that does not compile or has unsafe quantifiers makes the scan invalid: refused, never
// skipped (the scan would be weaker than the project asked for). Its error names the line and a reason, never the
// pattern's text: a project pattern can be a literal secret.
import { extraRegExp, nestedQuantifier } from '../guard/extra.mjs';

// Regex work is bounded, including on minified output. Fixed-stride built-in spans are
// below 2048 characters (URL userinfo: at most 1351); a 2048-character overlap
// therefore contains every cross-boundary match. JWT segments instead use windows
// anchored at their separator, at most 4096 characters on either side.
// Values use a 1024-character probe.
// A hit on a line longer than that probe masks the entire line, including any tail.
export const WINDOW_SIZE = 4096;
export const MAX_PATTERN_SPAN = 2048;
export const WINDOW_OVERLAP = MAX_PATTERN_SPAN;
export const PROJECT_LINE_MAX = 4096;
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
const npmValue = (m) => !/^x+$/i.test(m[2]);

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
  ['private-key', `-----BEGIN PGP PRIVATE ${'KEY'} BLOCK-----`], // split so the scanner's own source holds no key header
  ['npm-token', 'npm_[A-Za-z0-9]{36}'],
  ['npm-token', `(?:(^${S}{0,64}_(?:auth|password))|//[A-Za-z0-9][A-Za-z0-9.:-]{0,254}/[^${SPACE}:"']{0,256}:_(?:authToken|auth|password))${S}{0,64}=${S}{0,64}["']?([A-Za-z0-9_/+=-]{8,1024})`, false, npmValue],
  ['aws-secret-key', `aws_secret_access_key${S}{0,64}=${S}{0,64}["']?[A-Za-z0-9/+=]{40}`, true],
  ['stripe-key', '[sr]k_live_[A-Za-z0-9]{24,1024}'],
  ['gitlab-token', 'glpat-[A-Za-z0-9_-]{20,1024}'],
  ['url-password', '[A-Za-z][A-Za-z0-9+.-]{0,63}://[^:/@\\s"\'<>]{1,256}:([^/@\\s"\'$<>{}*]{3,1024})@[^/\\s"\'<>]', false, passwordValue],
  ['bearer-token', `[Bb]earer${S}{1,64}[A-Za-z0-9_.~+/-]{20,1024}`],
  ['jwt', 'eyJ[A-Za-z0-9_-]{10,4080}\\.eyJ[A-Za-z0-9_-]{10,4080}'],
  // Check colon/password semantics after one value scan, never with overlapping VALUE* repeats.
  ['assigned-secret', `${ASSIGNED}(${VALUE}{1,1024})["']`, true, quotedValue],
  // A full probe is evidence even if the closing quote is beyond the window.
  ['assigned-secret', `${ASSIGNED}(${VALUE}{1024})`, true, quotedValue],
  ['assigned-secret', `${KEY}${S}{0,64}:${S}{1,64}[A-Za-z0-9_/+=-]{16,1024}${S}{0,64}(?=#|$)`, true],
  ['url-secret', '[?&](?:token|api_key|apikey|access_token)=[A-Za-z0-9_-]{8,1024}', true],
  // Start at the keyword, not an overlapping arbitrary uppercase prefix.
  ['env-secret', '(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z_]{0,128}=["\']?[A-Za-z0-9_/+=-]{12,1024}', true],
];
export const PATTERNS = Object.freeze(BUILT_IN.map(([id, source, keyword, accept]) => Object.freeze({ id, re: new RegExp(source), keyword, accept })));

// Public regexes stay stateless; scanning uses private global copies.
const MATCH_PATTERNS = PATTERNS.map((p) => ({ ...p, re: new RegExp(p.re.source, 'g') }));

// The synthetic marker of test values (SEC-11): a separate word anywhere in the line's text.
export const SYNTHETIC = /\bSYNTH\b|\bcheck-secrets: synthetic\b/;
export const isSynthetic = (line) => SYNTHETIC.test(line);

// Key stores, certificates and env files never belong in a repository or a build, in any directory; examples,
// samples and templates of them do.
const KEY_FILE_TEMPLATE = /\.(?:example|sample|template)$/;
export const isKeyFile = (path) => {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return !KEY_FILE_TEMPLATE.test(file) && (/\.(?:keystore|jks|p12|pfx|pem|key)$/.test(file) || /^\.env(?:\.[^/]*)?$/.test(file) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(file));
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
    if (overlappingWildcards(re.source)) { errors.push({ line: k + 1, message: 'two adjacent unbounded wildcards can match the same text and take polynomial time' }); return; }
    patterns.push(Object.freeze({ id: `project:${k + 1}`, re }));
  });
  return { patterns, errors };
}

// Check repeated character atoms in sequence, including across intervening text.
// Project input is latin1, so overlap is exactly a shared byte. Alternatives keep
// separate histories, then merge at their closing group. This is conservative:
// delimiters do not prove that overlapping repetitions are safe.
function overlappingWildcards(source) {
  let seen = new Set();
  const groups = [];
  for (let i = 0; i < source.length; i++) {
    const start = i;
    const c = source[i];
    if (c === '(') {
      groups.push({ before: new Set(seen), branches: new Set() });
      if (source[i + 1] === '?') {
        i += source[i + 2] === '<' && !'=!'.includes(source[i + 3]) ? source.indexOf('>', i) - i : 2;
      }
      continue;
    }
    if (c === '|') {
      const group = groups[groups.length - 1];
      if (group) for (const byte of seen) group.branches.add(byte);
      seen = new Set(group?.before);
      continue;
    }
    if (c === ')') {
      const group = groups.pop();
      if (group) for (const byte of group.branches) seen.add(byte);
      continue;
    }
    if (c === '\\') { i++; if (!'dDsSwW'.includes(source[i])) continue; }
    else if (c === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
    } else if (c !== '.') continue;
    if (!/^(?:[*+]|\{\d+,\})/.test(source.slice(i + 1))) continue;
    const atom = new RegExp(`^(?:${source.slice(start, i + 1)})$`);
    const bytes = [];
    for (let byte = 0; byte < 256; byte++) {
      if (!atom.test(String.fromCharCode(byte))) continue;
      if (seen.has(byte)) return true;
      bytes.push(byte);
    }
    for (const byte of bytes) seen.add(byte);
  }
  return false;
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

// Separator-anchored probes avoid retrying a long header/scheme at every character.
// A separator partitions JWT base64 runs, so backwards scans do not overlap.
const BASE64URL = /[A-Za-z0-9_-]/;
const JWT_TAIL = /^\.eyJ[A-Za-z0-9_-]{10,4080}/;
function jwtMatch(line) {
  if (line.indexOf('eyJ') < 0 || line.indexOf('.eyJ') < 0) return null;
  for (let dot = line.indexOf('.eyJ'); dot >= 0; dot = line.indexOf('.eyJ', dot + 4)) {
    let start = dot;
    const floor = Math.max(0, dot - (WINDOW_SIZE - 1));
    while (start > floor && BASE64URL.test(line[start - 1])) start--;
    const header = line.slice(start, dot);
    const prefix = header.indexOf('eyJ');
    if (prefix < 0 || header.length - prefix < 13) continue;
    const tail = JWT_TAIL.exec(line.slice(dot, dot + WINDOW_SIZE));
    if (tail) return { id: 'jwt', index: start + prefix, text: header.slice(prefix) + tail[0] };
  }
  return null;
}
const URL_PATTERN = MATCH_PATTERNS.find((p) => p.id === 'url-password');
const URL_PROBE = new RegExp(URL_PATTERN.re.source.slice(URL_PATTERN.re.source.indexOf(':')), 'y');
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
function urlMatch(line) {
  // Only a separator can start a probe; long scheme-like runs without it are free.
  for (let at = line.indexOf('://'); at >= 0; at = line.indexOf('://', at + 3)) {
    let start = at;
    const floor = Math.max(0, at - 64);
    while (start > floor && SCHEME_CHAR.test(line[start - 1])) start--;
    while (start < at && !/[A-Za-z]/.test(line[start])) start++;
    if (start === at) continue;
    const window = line.slice(at, at + 3 + 256 + 1 + 1024 + 2);
    URL_PROBE.lastIndex = 0;
    const m = URL_PROBE.exec(window);
    if (m && URL_PATTERN.accept(m)) return { id: URL_PATTERN.id, index: start, text: line.slice(start, at) + m[0] };
  }
  return null;
}

// The first pattern matching a line: { id, index, text } or null. The optional
// boundary context is for streaming pieces of one physical line, never fake ^/$.
export function matchLine(line, extra = [], { before = '', after = '' } = {}) {
  const hit = (id, index, text) => line.length > VALUE_LIMIT
    ? { id, index: 0, text: line }
    : { id, index, text };
  for (let offset = 0; offset < line.length; offset += WINDOW_SIZE - WINDOW_OVERLAP) {
    const window = line.slice(offset, offset + WINDOW_SIZE);
    const keywords = keywordLine(window);
    for (const p of MATCH_PATTERNS) {
      if (p.id === 'jwt' || p.id === 'url-password') continue;
      if (p.keyword && (!keywords || (window.indexOf('=') < 0 && window.indexOf(':') < 0))) continue;
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(window))) {
        if (p.accept === npmValue && m[1] !== undefined && (offset !== 0 || before)) continue;
        if (p.id === 'openai-key' && m.index === 0 && m[1] === '' && /[A-Za-z0-9]/.test(offset ? line[offset - 1] : before)) continue;
        if (p.re.source.endsWith('(?=#|$)') && window[m.index + m[0].length] !== '#'
          && (offset + window.length < line.length || after)) continue;
        if (!p.accept || p.accept(m)) return hit(p.id, offset + m.index, m[0]);
        if (m[0].length === 0) break;
      }
    }
    if (offset + WINDOW_SIZE >= line.length) break;
  }
  for (const match of [jwtMatch(line), urlMatch(line)]) {
    if (match) return hit(match.id, match.index, match.text);
  }
  const project = matchProjectLine(line, extra);
  return project ? hit(project.id, project.index, project.text) : null;
}

// Project regexes keep their anchors and spans, with a separate documented cap.
export function matchProjectLine(line, extra) {
  const projectLine = line.slice(0, PROJECT_LINE_MAX);
  for (const p of extra) {
    p.re.lastIndex = 0;
    const m = p.re.exec(projectLine);
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
