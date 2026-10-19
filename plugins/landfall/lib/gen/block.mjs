// Managed blocks (spec §7.14, last paragraph): in a file the user owns (an existing CODEOWNERS, AGENTS.md), only
// the lines between the begin and end marker lines are generated; every byte outside them stays the user's. Markers
// are comment lines "<comment> <codename>:begin" and "<comment> <codename>:end", followed by " <commentEnd>" when
// the target's comment syntax closes (HTML: "<!-- <codename>:begin -->"), recognised with surrounding spaces and a CR
// trimmed. The block is the text strictly between the two marker lines.
//   extract(text) → { state: 'ok', before, block, after } · { state: 'none' } (no marker) · { state: 'malformed' }
//   (one marker missing, repeated or out of order)

export function blockMarkers(target, names) {
  const close = target.commentEnd ? ` ${target.commentEnd}` : '';
  return { begin: `${target.comment} ${names.codename}:begin${close}`, end: `${target.comment} ${names.codename}:end${close}` };
}

export const wrapBlock = (target, names, block) => {
  const { begin, end } = blockMarkers(target, names);
  return `${begin}\n${block}${end}\n`;
};

export function extract(target, names, text) {
  const { begin, end } = blockMarkers(target, names);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const at = (marker) => lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
  const b = at(begin);
  const e = at(end);
  if (b.length === 0 && e.length === 0) return { state: 'none' };
  if (b.length !== 1 || e.length !== 1 || e[0] < b[0] || !lines[b[0]].endsWith('\n')) return { state: 'malformed' };
  return {
    state: 'ok',
    before: lines.slice(0, b[0] + 1).join(''),
    block: lines.slice(b[0] + 1, e[0]).join(''),
    after: lines.slice(e[0]).join(''),
  };
}

// The user's file with `block` in place of the managed block, or with the wrapped block appended when the file
// has no markers. Null when the markers are malformed.
export function withBlock(target, names, text, block) {
  const x = extract(target, names, text);
  if (x.state === 'ok') return `${x.before}${block}${x.after}`;
  if (x.state === 'malformed') return null;
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${wrapBlock(target, names, block)}`;
}
