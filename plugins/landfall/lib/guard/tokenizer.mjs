// Tokenizer-light of the Bash guard (spec SD-29, SEC-3): reads a command only as a sequence of PLAIN simple commands —
// connectors && || ; and newline, pipe | — made of plain words: a bare word, or '…' / "…" without $ and ` (a backslash
// in "…" gives only the literal character). Any other syntax throws NotPlain with the reason: $, `, ( ), { } (except
// ref@{n}), <( ) >( ), |&, &, a here-string, a backslash outside quotes, an assignment before the command. A heredoc is
// data only: a quoted delimiter or a body without $ ` \. Two fixed forms are kept: `$?` (also as "$?") and the commit
// message "$(cat <<'EOF' … EOF\n)" as a word of its own.
// Result: simple commands { words: [{ text, q, glob }], redirs: [{ op, target, glob }], heredoc: body | null, pipeIn, pipeOut,
// before, after } — before / after: the connector on that side (';', '&&', '||', '|', '\n' or null at either end).
// q: '' plain · '?' holds $? · 'msg' the message substitution (its body as one word).
export class NotPlain extends Error {}
export const why = (w) => { throw new NotPlain(w); };

// Literal variables (retro 2026-10 §4.1, SEC-3): `NAME=value` standing as a simple command of its own, whose value is one
// bare word of letters, digits and . / : @ , + = _ - or one quoted string without quotes, $, backtick, backslash or
// a shell metacharacter, is substituted for every later `$NAME` or `${NAME}` outside single quotes in the same text,
// and the assignment is dropped, so the shapes read literal words (the 36 "expansion inside quotes" and 10 "assignment
// before the command" blocks of one project). No substitution: a name set or used any other way in the text (printf -v,
// read, declare, export, for, unset, +=, an array index), a name assigned twice, or a reference where the command name
// stands (a command from a variable has no shape). `for NAME in <literal words>; do <body>; done` as the whole text is
// unrolled the same way. Anything else stays as written and the parser decides.
const ASSIGN = /^\s*([A-Za-z_]\w*)=(.*?)\s*$/s;
const BARE = /^[A-Za-z0-9_./:@,+=-]*$/;
const META = /[;&|<>(){}$`\\!*?[\]#~'"\n]/;
const FOR = /^\s*for\s+([A-Za-z_]\w*)\s+in\s+([^;\n]+?)\s*(?:;|\n)\s*do\s+([\s\S]*?)\s*(?:;|\n)?\s*done\s*$/;

// The literal of a value word, or null when it is not one.
function literal(value) {
  if (BARE.test(value)) return value;
  const q = value[0];
  if ((q === "'" || q === '"') && value.length >= 2 && value.endsWith(q)) {
    const inner = value.slice(1, -1);
    return META.test(inner) ? null : inner;
  }
  return null;
}

// Top-level segments of the text (split at ; newline && || | outside quotes) with the connector that follows each.
function segments(src) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(' || c === ')' || c === '`') return null; // left to the parser
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push({ text: cur, sep: two }); cur = ''; i++; continue; }
    if (c === ';' || c === '\n' || c === '|') { out.push({ text: cur, sep: c }); cur = ''; continue; }
    cur += c;
  }
  if (q) return null;
  out.push({ text: cur, sep: '' });
  return out;
}

// `text` with `$NAME` / `${NAME}` of `vars` replaced outside single quotes; a reference in command position stays.
function substitute(text, vars) {
  let out = '';
  let q = null;
  let atStart = true; // only whitespace so far in the current simple command
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === "'" && q === null) { q = c; out += c; atStart = false; continue; }
    if (c === '"') { q = q === '"' ? null : '"'; out += c; continue; }
    if (c === '$') {
      const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(text.slice(i));
      const name = m ? m[1] ?? m[2] : null;
      if (name !== null && vars.has(name) && !atStart) { out += vars.get(name); i += m[0].length - 1; continue; }
      out += c; atStart = false; continue;
    }
    if (q === null && (c === ';' || c === '|' || c === '&' || c === '\n')) { out += c; atStart = true; continue; }
    if (!/\s/.test(c) || q !== null) atStart = false;
    out += c;
  }
  return out;
}

export function expandLiterals(src) {
  const loop = FOR.exec(src);
  if (loop) {
    const words = loop[2].split(/\s+/).filter(Boolean).map(literal);
    if (words.length && words.every((w) => w !== null)) return expandLiterals(words.map((w) => substitute(loop[3], new Map([[loop[1], w]]))).join('; '));
  }
  const segs = segments(src);
  if (!segs) return src;
  const vars = new Map();
  const twice = new Set();
  const rest = [];
  for (const s of segs) {
    const m = ASSIGN.exec(s.text);
    const value = m ? literal(m[2]) : null;
    if (m && value !== null && s.sep !== '|') {
      if (vars.has(m[1])) twice.add(m[1]);
      vars.set(m[1], value);
      continue;
    }
    rest.push(s);
  }
  for (const name of twice) vars.delete(name);
  if (!vars.size) return src;
  const text = rest.map((s) => s.text + s.sep).join('').replace(/^\s+/, '');
  // a bare occurrence of the name (not $NAME, ${NAME}) sets or reads it another way: no proof of its value
  for (const name of [...vars.keys()]) if (new RegExp(`(?<![\\w$\\{])${name}(?![\\w])`).test(text)) vars.delete(name);
  if (!vars.size) return src;
  return substitute(text, vars);
}

const MSG_SUB = /^"\$\(cat <<(-?)(['"])([A-Za-z_]\w*)\2\n([\s\S]*?)\n(\t*)\3\n\)"/;
// tick() throws when the analysis is over its deadline; limit is the longest text read at once.
export function parse(src, { tick = () => {}, limit = 65536 } = {}) {
  const cmds = []; const pending = []; const n = src.length;
  let cur = null; let word = null; let redir = null; let pipeIn = false; let i = 0; let sep = null;
  const start = () => { cur = cur ?? { words: [], redirs: [], heredoc: null, pipeIn, pipeOut: false, before: sep, after: null }; };
  const add = (s) => { start(); word = word ?? { text: '', q: '', glob: false, at: false }; word.text += s; };
  const boundary = () => i >= n || /[\s;&|<>]/.test(src[i]);
  function special(text, q, len) { // a word of fixed form: $? or the message from a heredoc
    if (word !== null) why('$ inside a word');
    start(); word = { text, q, glob: false, at: false }; i += len;
    if (!boundary()) why('$ inside a word');
  }
  function endWord() {
    if (word === null) return;
    const w = word; word = null;
    if (w.at) why('unclosed ref@{…}');
    if (redir) { if (w.q) why('redirection to an expansion'); cur.redirs.push({ op: redir, target: w.text, glob: w.glob }); redir = null; return; }
    if (!cur.words.length && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w.text)) why('assignment before the command');
    cur.words.push(w);
  }
  function endCmd(kind = null) {
    endWord();
    if (redir) why('redirection without a target');
    if (cur) { cur.after = kind; cmds.push(cur); } else if (pipeIn) why('pipe without a command');
    cur = null; pipeIn = false; sep = kind;
  }
  function dquote() {
    if (word === null && src.startsWith('"$?"', i)) return special('$?', '?', 4);
    if (word === null && src.startsWith('"$(cat <<', i)) {
      const m = MSG_SUB.exec(src.slice(i, i + limit));
      const strip = (l) => (m?.[1] ? l.replace(/^\t+/, '') : l);
      if (m && (!m[5] || m[1]) && !m[4].split('\n').some((l) => strip(l) === m[3])) return special(m[4], 'msg', m[0].length);
    }
    add(''); i++;
    while (i < n && src[i] !== '"') {
      const d = src[i];
      // a $ that no expansion can follow (the closing quote, a space, punctuation) is the literal character, as in bash
      if (d === '`' || (d === '$' && /[A-Za-z_{(@*#?!$0-9-]/.test(src[i + 1] ?? ''))) why('expansion inside quotes');
      if (d === '\\') { const x = src[i + 1] ?? ''; if (x !== '\n') add('$`"\\'.includes(x) ? x : d + x); i += 2; continue; }
      add(d); i++;
    }
    if (i >= n) why('unclosed quote');
    i++;
  }
  function redirect() {
    if (src[i + 1] === '(') why('process substitution <( ) / >( )');
    if (word !== null && !word.q && /^\d+$/.test(word.text)) word = null; // a descriptor number (2>&1)
    else endWord();
    start();
    if (src.startsWith('<<<', i)) why('here-string <<<');
    if (src.startsWith('<<', i)) {
      const dash = src[i + 2] === '-'; i += dash ? 3 : 2;
      while (src[i] === ' ' || src[i] === '\t') i++;
      let tag = ''; let quoted = false;
      while (i < n && !/[\s;&|<>()]/.test(src[i])) {
        const d = src[i];
        if (d === "'" || d === '"') { const e = src.indexOf(d, i + 1); if (e < 0) why('unclosed heredoc delimiter'); tag += src.slice(i + 1, e); quoted = true; i = e + 1; }
        else if ('\\$`'.includes(d)) why('heredoc delimiter with an expansion');
        else { tag += d; i++; }
      }
      if (!tag || pending.some((p) => p.cmd === cur) || cur.heredoc !== null) why('heredoc without a delimiter, or several heredocs');
      pending.push({ cmd: cur, tag, dash, quoted });
      return;
    }
    const c = src[i]; let op = c; i++;
    if (c === '>' && (src[i] === '>' || src[i] === '|')) op += src[i++];
    else if (c === '<' && src[i] === '>') op += src[i++];
    if (src[i] === '&') op += src[i++];
    redir = op;
  }
  function readHeredocs() {
    for (const h of pending.splice(0)) {
      const lines = []; let done = false;
      while (i < n) {
        let e = src.indexOf('\n', i); if (e < 0) e = n;
        const line = src.slice(i, e); i = e + 1;
        if ((h.dash ? line.replace(/^\t+/, '') : line) === h.tag) { done = true; break; }
        lines.push(line);
      }
      if (!done) why('heredoc without its delimiter');
      const body = lines.join('\n');
      if (!h.quoted && /[$`\\]/.test(body)) why('heredoc with an expansion (unquoted delimiter)');
      h.cmd.heredoc = body;
    }
  }
  while (i < n) {
    if ((i & 1023) === 0) tick();
    const c = src[i];
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '\n') { endCmd('\n'); i++; readHeredocs(); continue; }
    if (c === '#' && word === null) { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; } // a comment
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) why('unclosed single quote'); add(src.slice(i + 1, e)); i = e + 1; continue; }
    if (c === '"') { dquote(); continue; }
    if (c === '$') { if (src[i + 1] === '?') { special('$?', '?', 2); continue; } why('$ expansion'); }
    if (c === '`') why('`…` substitution');
    if (c === '\\') why('backslash outside quotes');
    if (c === '(' || c === ')') why('subshell, group or ( ) substitution');
    if (c === '{' && word?.text.endsWith('@') && !word.at) { add(c); word.at = true; i++; continue; } // ref@{n}
    if (c === '}' && word?.at) { add(c); word.at = false; i++; continue; }
    if (c === '{' || c === '}' || (word?.at && (c === ',' || src.startsWith('..', i)))) why('group or { } expansion');
    if (c === ';') { if (src[i + 1] === ';' || src[i + 1] === '&') why('case syntax ;;'); endCmd(';'); i++; continue; }
    if (c === '&') {
      if (src[i + 1] === '&') { endCmd('&&'); i += 2; continue; }
      if (src[i + 1] !== '>') why('& (background command)');
      endWord(); start(); i += 2; redir = '&>'; if (src[i] === '>') { redir = '&>>'; i++; } continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') { endCmd('||'); i += 2; continue; }
      if (src[i + 1] === '&') why('|&');
      endWord(); if (!cur || redir) why('pipe without a command');
      cur.pipeOut = true; endCmd('|'); pipeIn = true; i++; continue;
    }
    if (c === '<' || c === '>') { redirect(); continue; }
    if ('*?['.includes(c)) { add(c); word.glob = true; i++; continue; }
    add(c); i++;
  }
  endCmd();
  if (pending.length) why('heredoc without its delimiter');
  return cmds;
}
