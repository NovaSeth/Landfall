// `gen apply` (spec §7.14, §7.14a, SD-35, REV-57, GC9, findings-r1): the decision for each target and its execution.
// Provenance comes only from records; equal content never proves who wrote a file. For each item
// { target, path, theirs } (theirs = the newly rendered version; for a block target, the block):
//   target absent                               → create it; base = theirs                       (create)
//   no base recorded (unknown origin)           → no record and equal to theirs: nothing written (unknown-origin-identical)
//                                                 otherwise leave it, propose theirs in the side file (unknown-origin)
//   ours == base (pristine)                     → replace with theirs; base = theirs             (update)
//   theirs == base, or ours == theirs           → keep ours and the base                         (unchanged)
//   otherwise `git merge-file` + hunk survival  → clean, counts add up, file changed: write it; base = theirs (merge)
//     + line counts                               clean but nothing changes: keep the base       (unchanged)
//                                                 else leave ours, propose theirs in the side file (conflict, lost-hunk)
// The base moves only with the file (a pristine update or a merge that changed it), or when the user deletes a
// recorded side file: that acknowledges the version it proposed, which becomes the base (else a conflict could
// never be cleared). Side files (<path><side suffix>) are ours only while their content matches the recorded
// hash: one without a record stops the target (side-foreign), a recorded one the user changed stops it too
// (side-modified). A managed block applies the same rules to the text between its markers; every byte outside
// stays the user's. Paths are inspected component by component below the repository root: a symbolic link or a
// non-regular file anywhere on the way stops the target (unsafe); content that is not UTF-8 text is never merged.
// Execution: decisions are computed read-only first; when nothing would change (or on --dry-run) nothing is
// written, not even the store lock. Otherwise (1) under the store lock the decisions are computed again from
// fresh reads and each entry with file writes gets a write-ahead intent (pending: target hashes before and after,
// side file hash, removal, version) in the manifest; nothing else is written. (2) Under the lock again, every
// intent must still be in place and every target and side file must still hold the bytes the decision read;
// only then are the files written (exclusive create, atomic replace, mode kept) and the committed entries
// recorded, in the same locked section. Nothing destructive happens outside the lock. A run whose intent was
// superseded, or whose files changed in between, writes nothing and decides again from scratch (a bounded number
// of times). A run that finds an intent finishes it when all its writes landed (no second merge), and otherwise
// decides as if the interrupted run had not started. Accepted residual: an inspected path and the write that
// follows are separate system calls (as in lib/state).
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createExclusive, makeDirs, writeAtomic } from '../fsx/index.mjs';
import { StateError, check } from '../state/index.mjs';
import { extract, withBlock, wrapBlock } from './block.mjs';
import { MANIFEST, baseOf, makeEntry, readManifest, sha } from './manifest.mjs';
import { merge3, mergeChecked } from './merge.mjs';
import { render, sideSuffix } from './targets.mjs';

export const OK_ACTIONS = Object.freeze(['create', 'update', 'merge', 'unchanged', 'unknown-origin-identical']);
const SIDE_ACTIONS = new Set(['unknown-origin', 'conflict', 'lost-hunk', 'side-modified', 'side-foreign']);

// What is at rel below root, never following a link: { state: 'absent' | 'file' | 'unsafe' | 'not-text' }.
export function inspect(root, rel) {
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return { state: 'absent' };
    if (st.isSymbolicLink()) return { state: 'unsafe' };
    if (i < parts.length - 1) {
      if (!st.isDirectory()) return { state: 'unsafe' };
      continue;
    }
    if (!st.isFile()) return { state: 'unsafe' };
    const buf = readFileSync(cur);
    const text = buf.toString('utf8');
    if (buf.includes(0) || !Buffer.from(text, 'utf8').equals(buf)) return { state: 'not-text' };
    return { state: 'file', text, mode: st.mode & 0o777 };
  }
  return { state: 'unsafe' };
}

function decide(item, ctx) {
  const { target, path, theirs } = item;
  const { root, names, files, version, at, env, merge } = ctx;
  const block = target.mode === 'block';
  if (block && theirs !== '' && !theirs.endsWith('\n')) throw new Error(`gen: the block of ${target.id} must end with a newline`);
  const sidePath = `${path}${sideSuffix(names)}`;
  const theirsSha = sha(theirs);
  let entry = files[path] ?? null;
  let recovered = false; // an intent was found: the entry no longer equals the record
  let leftover = false; // our old side file that an interrupted run meant to remove
  let stale = false; // an interrupted run applied a version that is no longer the current one
  const cur = inspect(root, path);
  const side = inspect(root, sidePath);
  const curSha = cur.state === 'file' ? sha(cur.text) : null;
  const sideSha = side.state === 'file' ? sha(side.text) : null;
  const prior = () => entry ?? makeEntry({ target, version, base: null, side: null, at, previous: null });
  const out = (action, extra = {}) => ({
    id: target.id, path, sidePath, action, ok: OK_ACTIONS.includes(action), write: null, side: null, removeSide: leftover,
    advance: false, preSha: curSha, sidePreSha: sideSha, theirsSha, prior: prior(), entry: recovered ? entry : undefined, ...extra,
  });
  if (cur.state === 'unsafe' || side.state === 'unsafe') return out('unsafe');
  if (cur.state === 'not-text') return out('not-text');

  if (entry?.pending) {
    const { pending: p, ...committed } = entry;
    const landed = (p.resultSha256 === null || curSha === p.resultSha256) && (p.sideSha256 === null || sideSha === p.sideSha256);
    entry = committed;
    if (landed) {
      const current = p.theirsSha256 === theirsSha;
      stale = p.advance && !current;
      leftover = p.removeSide && sideSha !== null && sideSha === committed.side?.fileSha256;
      const sideRecord = p.sideSha256 !== null ? { fileSha256: p.sideSha256, theirsSha256: p.theirsSha256, at: p.at } : p.removeSide ? null : committed.side;
      entry = makeEntry({ target, version: p.templateVersion, base: p.advance && current ? theirs : baseOf(committed), side: sideRecord, at: p.at, previous: committed });
    }
    recovered = true;
  }

  const recorded = entry?.side ?? null;
  const sideExists = side.state !== 'absent' && !leftover;
  const sideIsOurs = sideExists && recorded !== null && sideSha === recorded.fileSha256;
  if (sideExists && recorded === null) return out('side-foreign');
  if (sideExists && !sideIsOurs) return out('side-modified');

  let base = baseOf(entry);
  if (recorded !== null && !sideExists && recorded.theirsSha256 === theirsSha) base = theirs; // the user merged it by hand
  const settle = (action, b, write = null) => out(action, {
    write, removeSide: sideIsOurs || leftover, advance: b === theirs, entry: makeEntry({ target, version, base: b, side: null, at, previous: entry }),
  });
  const offer = (action) => {
    const proposal = block ? withBlock(target, names, cur.text, theirs) : theirs;
    const fresh = { fileSha256: sha(proposal), theirsSha256: theirsSha, at };
    const record = recorded && recorded.fileSha256 === fresh.fileSha256 && recorded.theirsSha256 === theirsSha ? recorded : fresh;
    const write = sideIsOurs && side.text === proposal ? null : { content: proposal, create: side.state === 'absent', mode: 0o644 };
    return out(action, { side: write, removeSide: false, entry: makeEntry({ target, version, base, side: record, at, previous: entry }) });
  };

  if (cur.state === 'absent') return settle('create', theirs, { content: block ? wrapBlock(target, names, theirs) : theirs, create: true, mode: target.fileMode });
  let ours = cur.text;
  if (block) {
    const x = extract(target, names, cur.text);
    if (x.state === 'malformed') return out('block-malformed');
    ours = x.state === 'ok' ? x.block : null; // null: the user removed the markers
  }
  if (stale) return offer('conflict');
  if (base === null) return entry === null && ours === theirs ? out('unknown-origin-identical') : offer('unknown-origin');
  if (ours === null) return theirs === base ? settle('unchanged', base) : offer('conflict');
  const replaced = (text) => (block ? withBlock(target, names, cur.text, text) : text);
  if (ours === base) return theirs === base ? settle('unchanged', base) : settle('update', theirs, { content: replaced(theirs), create: false, mode: cur.mode });
  if (theirs === base || ours === theirs) return settle('unchanged', base); // the base moves only with the file
  const m = mergeChecked({ ours, base, theirs, env, merge });
  if (m.status === 'clean' && (!block || m.text === '' || m.text.endsWith('\n'))) {
    const content = replaced(m.text);
    return content === cur.text ? settle('unchanged', base) : settle('merge', theirs, { content, create: false, mode: cur.mode });
  }
  return offer(m.status === 'lost-hunk' ? 'lost-hunk' : 'conflict');
}

const hasWrites = (d) => Boolean(d.write || d.side || d.removeSide);
const entryChanged = (d, files) => d.entry !== undefined && !isDeepStrictEqual(d.entry, files[d.path]);

function put(root, rel, { content, create, mode }) {
  const file = join(root, rel);
  if (!create) return writeAtomic(file, content, { mode });
  makeDirs(dirname(file));
  if (createExclusive(file, content, { mode })) return;
  // Another run of the same decision created it first: fine when it holds exactly this content.
  if (inspect(dirname(file), basename(file)).text !== content) throw Object.assign(new Error(`${rel} appeared while it was being generated; nothing was overwritten, run again`), { code: 'ERACED' });
}

function execute(root, d) {
  if (d.side) put(root, d.sidePath, d.side);
  if (d.write) put(root, d.path, d.write);
  if (d.removeSide) rmSync(join(root, d.sidePath), { force: true });
}

function report(decisions, { dryRun, manifest }) {
  const results = decisions.map((d) => ({
    id: d.id,
    path: d.path,
    action: d.action,
    ok: d.ok,
    sideFile: SIDE_ACTIONS.has(d.action) ? d.sidePath : null,
    written: [...(d.side ? [d.sidePath] : []), ...(d.write ? [d.path] : [])],
    removed: d.removeSide ? [d.sidePath] : [],
  }));
  return { dryRun, ok: results.every((r) => r.ok), results, written: results.flatMap((r) => r.written), removed: results.flatMap((r) => r.removed), manifest };
}

function validated(files) {
  const doc = { schema: MANIFEST.version, files };
  const errors = check(MANIFEST, doc);
  if (errors.length) throw new Error(`generated manifest: ${errors[0].message}`);
  return doc;
}

const ATTEMPTS = 5; // a run superseded by another one decides again at most this many times

// The hash of what is at rel now: null when absent, a marker when it is no longer a plain text file.
function bytesNow(root, rel) {
  const x = inspect(root, rel);
  return x.state === 'file' ? sha(x.text) : x.state === 'absent' ? null : `<${x.state}>`;
}

// items: [{ target, path, theirs }]. Returns { dryRun, ok, results, written, removed, manifest } where written and
// removed list repository-relative paths and manifest tells whether the record changed (or would, on a dry run).
export function applyGen({ root, store, names, version, items, dryRun = false, now = () => new Date().toISOString(), env = process.env, merge = merge3 }) {
  const at = now();
  // The decisions are computed more than once (read-only, then under the lock); one merge per input triple.
  const memo = new Map();
  const merged = (args) => {
    const key = `${args.ours}\0${args.base}\0${args.theirs}`;
    if (!memo.has(key)) memo.set(key, merge(args));
    return memo.get(key);
  };
  const plan = (files) => items.map((item) => decide(item, { root, names, files, version, at, env, merge: merged }));
  const files0 = readManifest(store).files;
  const first = plan(files0);
  const recordChanges = first.some((d) => entryChanged(d, files0));
  if (dryRun || (!recordChanges && !first.some(hasWrites))) return report(first, { dryRun, manifest: recordChanges });
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const done = attemptRun({ root, store, version, at, plan });
    if (done) return report(done.decisions, { dryRun, manifest: done.manifest });
  }
  throw new StateError('locked', 'ENV', `another run kept changing the generated files; ${ATTEMPTS} attempts made, nothing stale written`, { hint: 'run it again' });
}

// One attempt: { decisions, manifest } when done, null when another run or the user changed the files in between.
function attemptRun({ root, store, version, at, plan }) {
  // 1. Under the lock: fresh decisions; entries without file writes are committed, the others get their intent.
  let decisions;
  const intents = new Map();
  let manifest = false;
  store.update('generated', null, (cur) => {
    const files = cur?.files ?? {};
    decisions = plan(files);
    const next = { ...files };
    const committed = { ...files };
    for (const d of decisions) {
      if (hasWrites(d)) {
        const pending = {
          preSha256: d.preSha, resultSha256: d.write ? sha(d.write.content) : null, sideSha256: d.side ? sha(d.side.content) : null,
          removeSide: d.removeSide, theirsSha256: d.theirsSha, advance: d.advance, templateVersion: version, at,
        };
        next[d.path] = { ...d.prior, pending };
        intents.set(d.path, next[d.path]);
        committed[d.path] = d.entry ?? d.prior;
      } else if (entryChanged(d, files)) {
        next[d.path] = d.entry;
        committed[d.path] = d.entry;
      }
    }
    validated(committed); // the record after the writes is checked before any of them
    if (isDeepStrictEqual(next, files)) return undefined;
    manifest = true;
    return validated(next);
  });
  if (intents.size === 0) return { decisions, manifest };

  // 2. Under the lock again: the intents and the bytes are as decided, then the writes and the commit.
  let current = true;
  store.update('generated', null, (cur) => {
    const files = { ...(cur?.files ?? {}) };
    current = decisions.every((d) => !intents.has(d.path)
      || (isDeepStrictEqual(files[d.path], intents.get(d.path)) && bytesNow(root, d.path) === d.preSha && bytesNow(root, d.sidePath) === d.sidePreSha));
    if (!current) return undefined;
    for (const d of decisions) {
      if (!intents.has(d.path)) continue;
      execute(root, d);
      files[d.path] = d.entry ?? d.prior;
    }
    return validated(files);
  });
  return current ? { decisions, manifest: true } : null;
}

// The items of the given targets: path (a location recorded in the manifest, else the first existing location
// the target lists, else its default path) and the version rendered from the options.
export function targetItems({ root, store, names, options, targets }) {
  const files = readManifest(store).files;
  return targets.map((target) => {
    const recorded = Object.keys(files).find((p) => files[p].target === target.id);
    const existing = (target.locations ?? []).find((loc) => inspect(root, loc).state !== 'absent');
    return { target, path: recorded ?? existing ?? target.path(names), theirs: render(target, options, names) };
  });
}
