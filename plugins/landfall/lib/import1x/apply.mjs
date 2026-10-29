// 1.x import (NICE 5, SD-48), slice 2: applies the dry-run mapping through lib/state in one store batch.
// - The manifest `import-1x.json` (a small kind of this unit) maps each legacy ID to its new ID, plus the ledger's
//   sha256. It is updated after each item, so a run cut short is finished by running it again; an item whose legacy
//   ID is in the manifest is never imported twice.
// - Decisions keep the 1.x ruling in the optional `legacy` field the decision kind already has; a correction
//   supersedes the decision its ruling corrects.
// - Tasks get the mapped status (an `imported` event holds the legacy ID); S<n> become tasks in the lane `shared`.
// - SEC-<n> become open backlog findings of one import task, reviewer {external, import-1x}, finding = the legacy ID:
//   the finding kind refuses unknown fields, so no field is added (GC9).
// - Config keys that are profile facts become facts with source `default` (the import source) and evidence naming
//   the import; the profile kind refuses other sources (GC9). Other keys are reported, not written.
// 1.x files are only read: checklist.mjs lists them for the human.
import { createHash } from 'node:crypto';
import { authorHandle, createDecision } from '../decisions/write.mjs';
import { CONFIDENCE_OF, PROFILE_KINDS, emptyProfile, validValue } from '../profile/index.mjs';
import { KINDS, PATTERNS, StateError, allocateId, createTaskInStore, defineKind, open } from '../state/index.mjs';

const LEGACY_KEY = /^[A-Za-z0-9][\w.-]{0,79}$/;
const NEW_ID = /^(?:[TDB]-[A-Z]{2,4}-[1-9]\d{0,5}|profile\.[A-Za-z]{1,40})$/;
export const MANIFEST = defineKind('import1x', 1, {
  dir: '',
  file: () => 'import-1x.json',
  match: /^import-1x\.json$/,
  fields: {
    source: { t: 'str', max: 64, re: PATTERNS.sha256 },
    items: { t: 'map', max: 100000, key: { t: 'str', max: 80, re: LEGACY_KEY }, v: { t: 'str', max: 40, re: NEW_ID } },
    findingsTask: { t: 'str', max: 40, re: PATTERNS.taskId, null: true },
  },
});

const STATUS = { todo: 'new', in_progress: 'dispatched', done: 'done', blocked: 'blocked', cancelled: 'cancelled' };
// 1.x config key → profile fact key and value.
const CONFIG = {
  team: (v) => ['people', v],
  stack: (v) => ['stack', (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean)],
};
const cut = (s, n) => [...s].slice(0, n).join('');

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const openImportStore = (dir, names) => open(dir, { names, kinds: { ...KINDS, ...PROFILE_KINDS, import1x: MANIFEST } });

// Applies `map` (readLedger) for `source` (the ledger text). Returns { imported: {legacy: id}, already, notWritten }.
export function applyMap({ where, names, env, map, source, handle: given, at = new Date().toISOString() }) {
  const store = openImportStore(where.dir, names);
  return store.batch((s) => {
    const handle = given ?? authorHandle({ store: s, where, names, env });
    if (s.read('team', handle) === null) throw new StateError('handle-unknown', 'USAGE', `handle ${handle} is not registered in this repository`, { hint: `register one: ${names.bin} init --handle ${handle}` });
    const sum = sha256(source);
    let manifest = s.read('import1x', null) ?? { source: sum, items: {}, findingsTask: null };
    const imported = {};
    const notWritten = [];
    let already = 0;
    const record = (legacy, id, extra = {}) => {
      imported[legacy] = id;
      manifest = s.write('import1x', null, { ...manifest, ...extra, source: sum, items: { ...manifest.items, [legacy]: id } });
    };
    const once = (legacy, fn) => {
      if (Object.hasOwn(manifest.items, legacy)) { already++; return; }
      fn();
    };
    const byPredicted = new Map(map.decisions.map((d) => [d.id, d.legacy]));
    for (const d of map.decisions) {
      once(d.legacy, () => {
        const supersedes = d.supersedes.map((p) => manifest.items[byPredicted.get(p)]).filter((id) => id && s.readText(`decisions/${id}.md`)?.includes('\nstatus: active\n'));
        const r = createDecision({ store: s, where, names, env, handle, input: {
          title: cut(d.what, 120), why: d.why.trim() || 'Not recorded in the 1.x ledger.', cost: d.cost.trim() || 'Not recorded in the 1.x ledger.',
          scope: [], kind: 'general', supersedes, legacy: d.legacy,
        } });
        record(d.legacy, r.id);
      });
    }
    const task = (legacy, title, status, lane = null) => {
      const { id, task: doc } = createTaskInStore({ store: s, handle, title: cut(title, 120), lane, at });
      s.write('task', id, { ...doc, status, events: [...doc.events, { at, by: handle, event: 'imported', data: { legacy, from: 'import-1x' } }] });
      return id;
    };
    for (const t of map.tasks) once(t.id, () => record(t.id, task(t.id, `[${t.id}] imported from the 1.x ledger`, STATUS[t.status] ?? 'new')));
    for (const sh of map.shared) once(sh.legacy, () => record(sh.legacy, task(sh.legacy, `[${sh.legacy}] ${sh.title}`, 'new', 'shared')));
    for (const n of map.notes) {
      once(n.legacy, () => {
        let owner = manifest.findingsTask ?? null;
        if (owner === null) {
          owner = task('import-1x', 'Security findings imported from the 1.x ledger', 'new');
          manifest = s.write('import1x', null, { ...manifest, source: sum, findingsTask: owner });
        }
        record(n.legacy, fileFinding(s, { owner, handle, legacy: n.legacy, text: n.text, at }));
      });
    }
    for (const f of map.profile) {
      const legacy = `config.${f.key}`;
      const to = Object.hasOwn(CONFIG, f.key) ? CONFIG[f.key](f.value) : null;
      if (!LEGACY_KEY.test(legacy) || !to || !validValue(to[0], to[1])) { notWritten.push(legacy); continue; }
      once(legacy, () => {
        s.update('profile', null, (cur) => {
          const doc = cur ?? emptyProfile();
          if (doc.facts[to[0]]) return undefined;
          doc.facts[to[0]] = { value: to[1], source: 'default', evidence: `import-1x: .workflow/config.json ${f.key}`, confidence: CONFIDENCE_OF.default, at };
          return doc;
        });
        record(legacy, `profile.${to[0]}`);
      });
    }
    return { imported, already, notWritten, handle };
  });
}

// An open backlog finding for a 1.x SEC-<n> item; allocateId gives its B-<H>-<n>.
function fileFinding(store, { owner, handle, legacy, text, at }) {
  return allocateId(store, { prefix: 'B', handle, build: (id) => ({
    id, status: 'open', task: owner, round: 1, reviewer: { kind: 'external', id: 'import-1x' }, finding: cut(legacy, 40), severity: 'minor',
    path: null, line: null, rule: null, text: cut(text, 500) || legacy, filedAt: at, filedBy: handle, takenBy: null, closedAt: null, closedBy: null, reason: null,
  }) });
}
