// Decision record files (spec §5, §5.1, SD-21): `<state>/decisions/D-<H>-<n>.md` = a YAML-subset frontmatter block
// between `---` lines, then a Markdown body with the sections What / Why / Cost if wrong / Alternatives.
// Frontmatter grammar (our own parser, GC10): one `key: value` per line; lists as `[a, b]`; `null` or nothing for
// none; a value may be a JSON double-quoted string (also valid YAML); `signals` is a JSON object; `schema` an
// integer. The formatter quotes a free-text value or list item unless it is a safe plain YAML scalar, so a record
// stays valid YAML and parse(format(doc)) == doc.
// The field checks are the state unit's schema validator over the DECISION kind (validation only: records are
// Markdown, so they are created through lib/state allocateId, never through the JSON kind API).
import { PATTERNS, check, defineKind } from '../state/index.mjs';
import { codePointName, forModel, hidden } from '../text/clean.mjs';

export const STATUSES = Object.freeze(['active', 'superseded', 'retired']);
export const DECISION_KINDS = Object.freeze(['general', 'tier', 'tier-pin', 'route-override', 'test-removal', 'gate-change', 'takeover', 'review-close']);
// Spec §5.1 limits (title, scope) plus defaults for the fields the spec leaves open.
export const RECORD_LIMITS = Object.freeze({ title: 120, scope: 20, glob: 120, supersedes: 100, testIds: 1000, testId: 300, signalsBytes: 4096, legacy: 40, remaining: 200, findingId: 40 });
export const FILE_NAME = /^(D-[A-Z]{2,4}-[1-9]\d{0,5})\.md$/;
// SD-21: a citation anywhere in a file. A match that is not a valid ID (number 0, leading zeros, seven digits) is an unknown ID.
export const citationPattern = () => /\bD-[A-Z]{2,4}-\d+\b/g;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
const decisionId = str(40, { re: PATTERNS.decisionId });

export const DECISION = defineKind('decision', 1, {
  dir: 'decisions',
  keyPattern: PATTERNS.decisionId,
  file: (id) => `decisions/${id}.md`,
  match: /^decisions\/(D-[A-Z]{2,4}-[1-9]\d{0,5})\.md$/,
  key: 'id',
  fields: {
    id: decisionId,
    title: str(RECORD_LIMITS.title, { min: 1 }),
    status: { t: 'enum', of: STATUSES },
    kind: { t: 'enum', of: DECISION_KINDS },
    date: str(10, { re: DATE }),
    author: str(4, { re: PATTERNS.handle }),
    supersedes: { t: 'arr', max: RECORD_LIMITS.supersedes, of: decisionId },
    supersededBy: { ...decisionId, null: true },
    scope: { t: 'arr', max: RECORD_LIMITS.scope, of: str(RECORD_LIMITS.glob, { min: 1 }) },
    allowsTestRemoval: { t: 'arr', max: RECORD_LIMITS.testIds, of: str(RECORD_LIMITS.testId, { min: 1 }) },
    signals: { t: 'data', maxBytes: RECORD_LIMITS.signalsBytes },
    legacy: str(RECORD_LIMITS.legacy, { min: 1 }),
    // kind review-close: the task whose review step it closes and the blocking finding IDs left open (verify/artifacts).
    task: str(20, { re: PATTERNS.taskId }),
    remaining: { t: 'arr', max: RECORD_LIMITS.remaining, of: str(RECORD_LIMITS.findingId, { min: 1 }) },
  },
  opt: ['supersedes', 'supersededBy', 'scope', 'allowsTestRemoval', 'signals', 'legacy', 'task', 'remaining'],
});

const ORDER = Object.keys(DECISION.spec.f);
const LISTS = new Set(['supersedes', 'scope', 'allowsTestRemoval', 'remaining']);
// Values that are always plain (pattern-checked): written unquoted, read as text.
const PATTERNED = new Set(['id', 'status', 'kind', 'date', 'author', 'supersededBy', 'task']);
const KEYWORD = /^(?:null|~|true|false|yes|no|on|off|y|n)$/i;

// A plain YAML scalar our parser reads back unchanged: starts with a letter, `_`, `/`, `.` or `(`; no leading or
// trailing space, no `: ` or ` #`, no quote; in a list no `,[]{}` either; not a YAML keyword.
function plain(s, inList) {
  return /^[A-Za-z_/.(]/.test(s) && s === s.trim() && !/: | #|"|:$/.test(s) && !(inList && /[,[\]{}]/.test(s)) && !KEYWORD.test(s);
}
const scalar = (s, inList = false) => (plain(s, inList) ? s : JSON.stringify(s));

function formatValue(key, v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map((item) => scalar(String(item), true)).join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  return PATTERNED.has(key) ? v : scalar(v);
}

export const frontmatterLine = (key, value) => `${key}: ${formatValue(key, value)}`;

// The record text: frontmatter keys in schema order (absent keys skipped), a blank line, the body.
export function formatRecord(doc, body = '') {
  const lines = ORDER.filter((k) => doc[k] !== undefined).map((k) => frontmatterLine(k, doc[k]));
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

// A JSON string starting at s[i] (a quote): [value, index after it], or null.
function quoted(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') {
      try { return [JSON.parse(s.slice(i, j + 1)), j + 1]; } catch { return null; }
    }
  }
  return null;
}

function parseList(v) {
  if (!v.startsWith('[') || !v.endsWith(']')) return { error: 'expected a list [a, b]' };
  const inner = v.slice(1, -1);
  const items = [];
  let i = 0;
  const skip = () => { while (i < inner.length && inner[i] === ' ') i++; };
  skip();
  if (i === inner.length) return { value: items };
  for (;;) {
    skip();
    if (inner[i] === '"') {
      const q = quoted(inner, i);
      if (!q) return { error: 'a quoted list item is not a valid JSON string' };
      items.push(q[0]);
      i = q[1];
    } else {
      const end = inner.indexOf(',', i);
      const item = inner.slice(i, end < 0 ? inner.length : end).trim();
      if (item === '' || /["[\]{}]/.test(item)) return { error: 'an empty list item, or one that needs quotes' };
      items.push(item);
      i = end < 0 ? inner.length : end;
    }
    skip();
    if (i === inner.length) return { value: items };
    if (inner[i] !== ',') return { error: 'list items are separated by commas' };
    i++;
  }
}

function parseValue(key, raw) {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === '~') return { value: null };
  if (LISTS.has(key)) return parseList(v);
  if (key === 'schema') return /^\d{1,9}$/.test(v) ? { value: Number(v) } : { error: 'expected an integer' };
  if (key === 'signals') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' && !Array.isArray(o) ? { value: o } : { error: 'expected a JSON object' };
    } catch {
      return { error: 'expected a JSON object' };
    }
  }
  if (v.startsWith('"')) {
    const q = quoted(v, 0);
    return q && q[1] === v.length ? { value: q[0] } : { error: 'not a valid quoted string' };
  }
  return { value: v };
}

// Text → { doc (null without a frontmatter block), body, errors (strings) }. The body starts after the closing
// `---` line and one blank line.
export function parseRecord(text, fileName) {
  const src = String(text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  if (lines[0] !== '---') return { doc: null, body: src, errors: [`${fileName}: no frontmatter: the file must start with a line ---`] };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { doc: null, body: src, errors: [`${fileName}: the frontmatter has no closing --- line`] };
  const doc = {};
  const errors = [];
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
    if (!m) { errors.push(`${fileName}: not a "key: value" line: ${JSON.stringify(line.slice(0, 60))}`); continue; }
    if (Object.hasOwn(doc, m[1])) { errors.push(`${fileName}: ${m[1]} appears twice`); continue; }
    const r = parseValue(m[1], m[2] ?? '');
    if (r.error) errors.push(`${fileName}: ${m[1]}: ${r.error}`);
    else doc[m[1]] = r.value;
  }
  let body = lines.slice(end + 1).join('\n');
  if (body.startsWith('\n')) body = body.slice(1);
  return { doc, body, errors };
}

// Field and consistency errors of one parsed frontmatter (strings, [] when valid). References to other records are
// checked by the caller, which sees all of them.
export function recordErrors(doc, fileName) {
  const at = (msg) => `${fileName}: ${msg}`;
  if (Number.isInteger(doc.schema) && doc.schema > DECISION.version) return [at(`schema ${doc.schema} is newer than this plugin knows (${DECISION.version}); update the plugin`)];
  const errors = check(DECISION, doc).map((e) => at(e.message));
  if (errors.length) return errors;
  const m = FILE_NAME.exec(fileName);
  if (!m || m[1] !== doc.id) errors.push(at(`id ${doc.id} does not match the file name`));
  if (Number.isNaN(Date.parse(doc.date))) errors.push(at(`date ${doc.date} is not a calendar date`));
  if (doc.status === 'superseded' && !doc.supersededBy) errors.push(at('status superseded needs supersededBy'));
  if (doc.status === 'active' && doc.supersededBy) errors.push(at(`an active decision has no supersededBy (found ${doc.supersededBy})`));
  if (doc.supersededBy === doc.id || (doc.supersedes ?? []).includes(doc.id)) errors.push(at('a decision cannot supersede itself'));
  if (doc.kind === 'review-close' && !doc.task) errors.push(at('kind review-close needs task (the task whose review step it closes)'));
  return errors;
}

// Replaces (or adds before the closing ---) the given frontmatter lines and leaves every other byte as it was.
export function setFields(text, fields) {
  const lines = text.split('\n');
  if (lines[0] !== '---' || lines.indexOf('---', 1) < 0) return null;
  for (const [key, value] of Object.entries(fields)) {
    const line = frontmatterLine(key, value);
    const end = lines.indexOf('---', 1);
    const at = lines.slice(1, end).findIndex((l) => l.startsWith(`${key}:`));
    if (at >= 0) lines[at + 1] = line;
    else lines.splice(end, 0, line);
  }
  return lines.join('\n');
}

// Body sections by `## <name>` heading (lowercased name → trimmed text).
export function sections(body) {
  const out = {};
  let cur = null;
  for (const line of String(body).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { cur = m[1].toLowerCase(); out[cur] = []; } else if (cur) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

// One line of text for model context: hidden content removed (lib/text), whitespace collapsed to one space.
export const flat = (s) => forModel(s).replace(/\s+/g, ' ').trim();

// Review r1: a record must not carry what a reader cannot see. Errors naming each hidden code point, in the file text
// (with its line) and in the parsed frontmatter values (a JSON-quoted value can spell one as an escape); at most 20.
export function hiddenErrors(text, doc, fileName) {
  const out = new Set();
  for (const h of hidden(text)) out.add(`${fileName}:${h.line}: hidden character ${codePointName(h.codePoint)}`);
  const walk = (key, v) => {
    if (typeof v === 'string') for (const h of hidden(v)) out.add(`${fileName}: ${key}: hidden character ${codePointName(h.codePoint)}`);
    else if (Array.isArray(v)) v.forEach((item) => walk(key, item));
    else if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) walk(`${key}.${k}`, item);
  };
  for (const [key, v] of Object.entries(doc ?? {})) walk(key, v);
  return [...out].slice(0, 20);
}
export const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
export const firstSentence = (s) => { const t = flat(s); return /^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t; };
export const firstClause = (s) => { const t = flat(s); return /^.*?(?=[,;:]\s|\.(?:\s|$)|\s[—–-]\s|$)/.exec(t)?.[0] ?? t; };
