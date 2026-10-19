// Line diff and the hunk-survival check of generated files (spec §7.14 step 4, SD-35, GC9).
// Lines keep their terminators, so "x\n", "x\r\n" and a final "x" without a newline are three different lines:
// a CRLF conversion or a removed final newline is a user hunk like any other.
// diffLines is Myers' O((N+M)D) shortest edit script after trimming the common prefix and suffix; it returns the
// hunks (maximal runs of edits, half-open ranges in a and b) or null when more than `maxEdits` edits are needed,
// which callers treat as "not verified" (the safe answer).
// survives(base, ours, result): every hunk of diff(base, ours) must appear in diff(base, result): a result hunk
// that covers the user hunk's base range (so the lines the user removed are gone) and holds the user's added lines
// contiguously, user hunks in order.

export const splitLines = (text) => (text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g));

// Trace memory grows with the square of the edit count; past this budget the diff is not computed.
export const MAX_EDITS = 2000;

export function diffLines(a, b, { maxEdits = MAX_EDITS } = {}) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const ops = shortestEdit(A, B, maxEdits);
  if (ops === null) return null;
  const hunks = [];
  let x = 0;
  let y = 0;
  let open = null;
  for (const op of ops) {
    if (op === '=') {
      if (open) { hunks.push({ aStart: open.x + pre, aEnd: x + pre, bStart: open.y + pre, bEnd: y + pre }); open = null; }
      x++; y++;
      continue;
    }
    if (!open) open = { x, y };
    if (op === '-') x++; else y++;
  }
  if (open) hunks.push({ aStart: open.x + pre, aEnd: x + pre, bStart: open.y + pre, bEnd: y + pre });
  return hunks;
}

// Myers forward pass with a trace of the diagonals [-d, d] per step, then backtracking: '=' equal, '-' delete
// from A, '+' insert from B, in order.
function shortestEdit(A, B, maxEdits) {
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > maxEdits) return null;
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const at = (k) => snap[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
    if (d > 0) ops.push(x === prevX ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// { ok: true } or { ok: false, hunk } with the first user hunk (base → ours coordinates) the result does not keep.
export function survives(base, ours, result, opts) {
  const b = splitLines(base);
  const o = splitLines(ours);
  const r = splitLines(result);
  const user = diffLines(b, o, opts);
  const merged = diffLines(b, r, opts);
  if (user === null || merged === null) return { ok: false, hunk: null };
  let ri = 0;
  let from = 0; // search position inside the added lines of merged[ri]
  for (const h of user) {
    const covers = (m) => m.aStart <= h.aStart && h.aEnd <= m.aEnd;
    let j = ri;
    while (j < merged.length && !covers(merged[j]) && merged[j].aStart <= h.aStart) j++;
    if (j >= merged.length || !covers(merged[j])) return { ok: false, hunk: h };
    if (j !== ri) { ri = j; from = 0; }
    const m = merged[ri];
    const added = o.slice(h.bStart, h.bEnd);
    const pool = r.slice(m.bStart, m.bEnd);
    const at = indexOfRun(pool, added, from);
    if (at < 0) return { ok: false, hunk: h };
    from = at + added.length;
  }
  return { ok: true };
}

// Line counts of a lossless merge (findings-r1 1): every line L appears max(0, ours(L) + theirs(L) − base(L))
// times in the result. A merge that moves a line the user deleted, or merges one change made on both sides once,
// fails it: in doubt, a side file.
export function countsAddUp(base, ours, theirs, result) {
  const count = (text, sign, m) => { for (const l of splitLines(text)) m.set(l, (m.get(l) ?? 0) + sign); return m; };
  const want = count(base, -1, count(theirs, 1, count(ours, 1, new Map())));
  const got = count(result, 1, new Map());
  for (const l of new Set([...want.keys(), ...got.keys()])) if ((got.get(l) ?? 0) !== Math.max(0, want.get(l) ?? 0)) return false;
  return true;
}

function indexOfRun(pool, run, from) {
  if (run.length === 0) return from;
  for (let i = from; i + run.length <= pool.length; i++) {
    let k = 0;
    while (k < run.length && pool[i + k] === run[k]) k++;
    if (k === run.length) return i;
  }
  return -1;
}
