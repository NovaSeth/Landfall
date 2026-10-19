// Route-override decision record (spec §5.1 decisions/D-H-n.md, SD-14, SD-21): written through lib/state's ID
// allocation, which creates the file exclusively with its complete text. Kind `route-override` until the
// decisions unit owns the full record format: YAML-subset frontmatter (`key: value`, lists as `[a, b]`) and the
// sections What / Why / Cost if wrong / Alternatives. The user's words go into Why as a Markdown quote, every
// line prefixed with `> `, so they cannot end the frontmatter or start a section. What names the waived reasons:
// the reason keys recorded on the task before this decision (a path appears as a count; its key is a hash).
import { LIMITS } from '../state/index.mjs';
import { usage } from './errors.mjs';
import { addedSteps } from './routes.mjs';

// C0 and C1 control characters except tab and newline, zero-width and byte-order marks, bidirectional controls.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

// The quote as stored: line ends unified to \n; refused (never altered otherwise) when blank, too long or unsafe.
export function checkQuote(quote) {
  const hint = 'pass the user\'s own words: --quote "<text>"';
  if (typeof quote !== 'string' || quote.trim() === '') throw usage('invalid-quote', 'an override needs the user\'s words as a quote', hint);
  const text = quote.replace(/\r\n?/g, '\n');
  if (text.length > LIMITS.evidence) throw usage('invalid-quote', `the quote has ${text.length} characters; the limit is ${LIMITS.evidence}`, 'quote the decisive sentence; nothing was written');
  if (UNSAFE.test(text)) throw usage('invalid-quote', 'the quote contains control, zero-width or bidirectional characters', 'retype the quote as plain text; nothing was written');
  return text;
}

// "2 risk paths, loc-over, risk-flag:migration" for recorded reason keys.
export function describeKeys(keys) {
  const paths = keys.filter((k) => k.startsWith('risk-path:')).length;
  const rest = keys.filter((k) => !k.startsWith('risk-path:')).sort();
  const parts = [...(paths ? [`${paths} risk ${paths === 1 ? 'path' : 'paths'}`] : []), ...rest];
  return parts.length ? parts.join(', ') : 'none';
}

export function renderOverride({ id, task, from, to, quote, author, at, waived = [] }) {
  const skipped = addedSteps(to, from);
  const quoted = quote.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
  return [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: Route override of ${task} from ${from} to ${to}`,
    'status: active',
    'kind: route-override',
    `date: ${at.slice(0, 10)}`,
    `author: ${author}`,
    'by: user',
    `task: ${task}`,
    `from: ${from}`,
    `to: ${to}`,
    'supersedes: []',
    'scope: []',
    '---',
    '',
    '## What',
    `${task} follows the ${to} route instead of the ${from} route its plan was classified for. Its outcome gates do not change.`,
    `Waived: the reasons recorded for ${task} so far (${describeKeys(waived)}). Any other reason raises the class again.`,
    '',
    '## Why',
    'The user asked for it:',
    '',
    quoted,
    '',
    '## Cost if wrong',
    `The steps of the ${from} route that the ${to} route skips: ${skipped.length ? skipped.join(', ') : 'none'}.`,
    '',
    '## Alternatives',
    `Keep the ${from} route.`,
    '',
  ].join('\n');
}
