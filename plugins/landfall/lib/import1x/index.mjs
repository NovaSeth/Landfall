// 1.x import (NICE 5, SD-48), slice 1: reads a 1.x ledger and prints the mapping. Pure: it writes nothing.
// Entry grammar (English): `Ruling R<n>: what — why — cost`, `Task <id>: <event> …`, `S<n>: …`, `SEC-<n>: …`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY = JSON.parse(readFileSync(new URL('./legacy.json', import.meta.url), 'utf8')).rules;
const STATUS = { dispatched: 'in_progress', complete: 'done', cancelled: 'cancelled', blocked: 'blocked' };
const RULING = /^(?:- )?(?:\*\*)?Ruling (R(?:-([A-Z]+))?-?(\d+))(?: \(([^)]*)\))?:\s*(.*?)(?:\*\*)?$/;
const TASK = /^(?:- )?Task ([A-Za-z0-9][\w.-]*): ([a-z-]+)/;
const SHARED = /^(?:- )?(?:Shared-fix backlog )?(S(?:-([A-Z]+))?-?(\d+))(?: \([^)]*\))?:\s*(.+)$/;
const FINDING = /^(?:- )?SEC-(?:([A-Z]+)-)?(\d+)(?: \([^)]*\))?:\s*(.+)$/;
const CORRECTION = /\((?:korekta|correction) (R(?:-([A-Z]+))?-?(\d+))/i;

// Rule IDs of 1.x cited in a text: the text with the current IDs, and what each citation became.
export function translate(text) {
  const citations = [];
  const out = text.replace(/\b([A-Z]{3})-(\d+)\b/g, (whole, p, n) => {
    const hit = p === 'SEC' ? undefined : LEGACY[whole];
    if (!hit) return whole;
    citations.push(hit.to === null ? { from: whole, to: null, note: hit.note } : { from: whole, to: hit.to });
    return hit.to ?? whole;
  });
  return { text: out, citations };
}

function ruling(m, handleOf) {
  const [, , author, num, meta, body] = m;
  const parts = body.split(' — ');
  if (parts.length < 3) return null;
  const handle = author ?? /\s([A-Z]{2,})$/.exec(meta ?? '')?.[1] ?? handleOf;
  const [what, why, ...cost] = parts.map((p) => translate(p));
  const c = CORRECTION.exec(body);
  return {
    id: `D-${handle}-${num}`,
    legacy: m[1],
    what: what.text,
    why: why.text,
    cost: cost.map((x) => x.text).join(' — '),
    supersedes: c ? [c[1]] : [],
    citations: [what, why, ...cost].flatMap((x) => x.citations),
  };
}

export function parseLedger(source, { handle = /^(?:- )?Ruling R-?\d* ?\([^)]* ([A-Z]{2,})\)/m.exec(source)?.[1] ?? 'IMP' } = {}) {
  const out = { decisions: [], tasks: [], shared: [], notes: [], skipped: [] };
  const tasks = new Map();
  source.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const skip = (reason) => out.skipped.push({ line: i + 1, text: line, reason });
    let m;
    if (/^(?:- )?(?:\*\*)?Ruling\b/.test(line)) {
      m = RULING.exec(line);
      const d = m && ruling(m, handle);
      if (d) out.decisions.push(d); else skip('a ruling needs "what — why — cost"');
    } else if (/^(?:- )?Task\b/.test(line)) {
      m = TASK.exec(line);
      if (!m) { skip('a task line needs "Task <id>: <event>"'); return; }
      const t = tasks.get(m[1]) ?? { id: m[1], status: 'todo' };
      if (STATUS[m[2]]) t.status = STATUS[m[2]];
      tasks.set(m[1], t);
    } else if ((m = SHARED.exec(line))) {
      const t = translate(m[4]);
      out.shared.push({ legacy: m[1], title: t.text, labels: ['shared'], citations: t.citations });
    } else if ((m = FINDING.exec(line))) {
      out.notes.push({ id: `SF-${m[2]}`, legacy: `SEC-${m[1] ? `${m[1]}-` : ''}${m[2]}`, text: translate(m[3]).text });
    }
  });
  const byLegacy = new Map(out.decisions.map((d) => [d.legacy, d.id]));
  for (const d of out.decisions) d.supersedes = d.supersedes.map((ref) => byLegacy.get(ref) ?? `D-${handle}-${/\d+$/.exec(ref)[0]}`);
  out.tasks = [...tasks.values()];
  return out;
}

export function profileFacts(config) {
  return Object.entries(config).map(([key, value]) => ({ key, value, source: 'import' }));
}

// Returns null when `<dir>/.workflow/progress.md` does not exist.
export function readLedger(dir) {
  let source;
  try { source = readFileSync(join(dir, '.workflow', 'progress.md'), 'utf8'); } catch { return null; }
  let config = {};
  try { config = JSON.parse(readFileSync(join(dir, '.workflow', 'config.json'), 'utf8')); } catch { /* optional */ }
  return { ...parseLedger(source), profile: profileFacts(config && typeof config === 'object' ? config : {}) };
}

export function summary(map) {
  const lines = [
    `decisions: ${map.decisions.length}`, ...map.decisions.map((d) => `  ${d.legacy} -> ${d.id}${d.supersedes.length ? ` (supersedes ${d.supersedes.join(', ')})` : ''}: ${d.what}`),
    `tasks: ${map.tasks.length}`, ...map.tasks.map((t) => `  ${t.id} -> ${t.status}`),
    `shared tasks: ${map.shared.length}`, ...map.shared.map((s) => `  ${s.legacy} (shared): ${s.title}`),
    `notes: ${map.notes.length}`, ...map.notes.map((n) => `  ${n.legacy} -> ${n.id}: ${n.text}`),
    `profile facts: ${map.profile.length}`, ...map.profile.map((f) => `  ${f.key} = ${JSON.stringify(f.value)} (source import)`),
    `skipped lines: ${map.skipped.length}`, ...map.skipped.map((s) => `  line ${s.line}: ${s.reason}`),
  ];
  return `${lines.join('\n')}\n`;
}
