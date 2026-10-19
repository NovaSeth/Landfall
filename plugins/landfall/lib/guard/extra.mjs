// Project rules of the Bash guard (spec SD-29, §11, SEC-4): guard-extra.txt, one rule per line <pattern><TAB><message>;
// the pattern is a JS RegExp (\b, \s, \d work) with POSIX classes in brackets ([[:space:]], [^[:alnum:]_], …), matched
// against the raw and the normalized command and against each simple command. A bad, empty or risky pattern (a nested
// quantifier, e.g. (a+)+) is skipped with a warning; a match over the time limit blocks. The text comes from a reader the
// caller injects (the state directory belongs to lib/state). The pattern syntax and the nested-quantifier check are
// shared with the project patterns of the secrets scan (lib/secrets/patterns.mjs).
import vm from 'node:vm';

const POSIX_CLASS = { alpha: 'A-Za-z', digit: '0-9', alnum: '0-9A-Za-z', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e' };
// POSIX classes become ASCII ranges; "]" right after "[" or "[^" is a literal character (as in POSIX ERE).
export function extraRegExp(src) {
  if (!src) throw new Error('an empty pattern would match every command');
  let out = ''; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (c !== '[') { out += c; i++; continue; }
    let j = i + 1; let body = '[';
    if (src[j] === '^') { body += '^'; j++; }
    if (src[j] === ']') { body += '\\]'; j++; }
    let closed = false;
    while (j < src.length) {
      const d = src[j];
      if (d === ']') { closed = true; j++; break; }
      if (d === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
      if (d === '[' && /[:.=]/.test(src[j + 1] ?? '')) {
        const kind = src[j + 1]; const e = src.indexOf(`${kind}]`, j + 2);
        if (kind !== ':' || e < 0) throw new Error(`unsupported bracket expression: ${src.slice(j, e < 0 ? j + 2 : e + 2)}`);
        const name = src.slice(j + 2, e);
        if (!Object.hasOwn(POSIX_CLASS, name)) throw new Error(`unknown POSIX class [:${name}:]`);
        body += POSIX_CLASS[name]; j = e + 2;
        if (src[j] === '-' && src[j + 1] !== ']') { body += '\\-'; j++; } // a class is not a range end: a literal "-"
        continue;
      }
      body += d === '[' ? '\\[' : d; j++;
    }
    if (!closed) { out += src.slice(i); break; } // an unclosed bracket: RegExp reports it
    out += `${body}]`; i = j;
  }
  return new RegExp(out);
}
// A nested quantifier: a group with a repetition inside and a repetition after it: (a+)+, (\w*x)*, (.+){2,}.
export function nestedQuantifier(src) {
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') { i++; if (src[i] === '^') i++; if (src[i] === ']') i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '(') {
      stack.push(false);
      if (src[i + 1] === '?') { i += src[i + 2] === '<' && src[i + 3] !== '=' && src[i + 3] !== '!' ? src.indexOf('>', i) - i : 2; }
      continue;
    }
    if (c === ')') {
      const inner = stack.pop() ?? false;
      const q = /^(?:[*+]|\{\d+,\d*\})/.test(src.slice(i + 1, i + 12));
      if (inner && q) return true;
      if (stack.length && (inner || q)) stack[stack.length - 1] = true;
      continue;
    }
    if (stack.length && ('*+?'.includes(c) || (c === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i, i + 12))))) stack[stack.length - 1] = true;
  }
  return false;
}
// The literals a pattern requires (≥ 4 characters): prescan tokens for the project rules.
const literalsOf = (re) => re.replace(/\\./g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/.(?=[?*]|\{0)/g, ' ')
  .split(/[^A-Za-z0-9_-]+/).filter((x) => x.length >= 4).map((x) => x.toLowerCase());

// Rules from the file text: { rules: [{ rx, msg, line, literals }], warnings: [text] }.
export function loadRules(text) {
  const rules = []; const warnings = [];
  if (typeof text !== 'string') return { rules, warnings };
  text.split('\n').forEach((raw, k) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) return;
    const [re, msg] = line.split('\t');
    const warn = (reason) => warnings.push(`guard: bad pattern in guard-extra.txt:${k + 1} skipped (${reason})`);
    let rx;
    try { rx = extraRegExp(re); } catch (e) { warn(e.message); return; }
    if (nestedQuantifier(rx.source)) { warn('nested quantifier, e.g. (a+)+: risk of exponential match time'); return; }
    rules.push({ rx, msg: msg || `Command blocked by the project rule ${re}.`, line: k + 1, literals: literalsOf(re) });
  });
  return { rules, warnings };
}
// A match in its own context with a time limit: catastrophic backtracking stops instead of hanging the hook.
const RX_SCRIPT = new vm.Script('inputs.some((s) => rx.test(s))');
const RX_CTX = vm.createContext({ rx: null, inputs: null });
export function ruleMatches(rx, inputs, { limit = 65536, ms = 100 } = {}) {
  RX_CTX.rx = rx; RX_CTX.inputs = inputs.map((x) => x.slice(0, limit));
  return RX_SCRIPT.runInContext(RX_CTX, { timeout: ms });
}
