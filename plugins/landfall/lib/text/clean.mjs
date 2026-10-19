// Text unit (review I8 r1, security guide 3.7): the one place that decides what a reader cannot see. A pure leaf:
// no I/O, no import (tests/architecture.test.mjs), so every unit may use it for its output.
// Hidden: ANSI/OSC escape sequences (removed whole: CSI, OSC, DCS/PM/APC/SOS, two-character escapes, C1 CSI/OSC) and
// the code points of category Cc (except \n and \t), Cf (zero-width characters, bidi controls U+061C, U+200E/F,
// U+202A-202E, U+2066-2069, soft hyphen U+00AD, U+180E, tag characters), Co (private use), Cs (lone surrogates),
// and the whole tag block U+E0000-E007F (unassigned ones too); code points that render blank or smuggle bytes:
// variation selectors U+FE00-FE0F and U+E0100-E01EF, Mongolian FVS U+180B-180F, CGJ U+034F, Hangul fillers U+115F,
// U+1160, U+3164, U+FFA0, braille blank U+2800; noncharacters U+FDD0-FDEF and U+xFFFE/xFFFF of every plane.
// CR LF, a lone CR, U+2028 and U+2029 become LF (hidden() reports U+2028 and U+2029: a check refuses them).
//   forModel(text)     text for model context (hook additionalContext): hidden content removed
//   forTerminal(text)  text a command prints: the same removal, so neither escapes nor invisible text reach a person;
//                      a separate entry point so terminal-only rules can change without touching model context
//   forJson(json)      JSON text (JSON.stringify output) with every hidden code point written as a \u escape:
//                      JSON leaves DEL, C1, Cf and the rest raw; escaped, the line is inert on a terminal and parses
//                      to the same value (the CLI envelope: data is escaped, never removed)
//   hidden(text)       [{ line, codePoint }] of the hidden code points (an escape sequence counts by its first one),
//                      for checks that refuse such text instead of cleaning it; CR LF is a line end, not hidden
//   codePointName(cp)  "U+XXXX"

const SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*(?:\u0007|\u009c)?/g;
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180F}\u{034F}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\u{2028}\u{2029}]/gu;

function clean(text) {
  return String(text ?? '').replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(SEQUENCE, '').replace(HIDDEN, '');
}

export const forModel = (text) => clean(text);
export const forTerminal = (text) => clean(text);
const unitEscape = (c) => Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');
export const forJson = (json) => String(json ?? '').replace(HIDDEN, unitEscape);

export function hidden(text) {
  const out = [];
  String(text ?? '').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HIDDEN)) out.push({ line: i + 1, codePoint: m[0].codePointAt(0) });
  });
  return out;
}

export const codePointName = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
