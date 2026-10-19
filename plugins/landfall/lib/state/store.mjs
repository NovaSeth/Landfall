// State store (spec §4.3, §5, §5.4, SD-10, SC10): typed reads and writes of the files of one state directory.
// open() touches nothing on disk; reads write nothing (an older file is upgraded in memory).
// Paths: every path is checked component by component from the store root (inclusive): a symbolic link, or a
// name that differs in case from the entry on disk, is refused (state-invalid), never followed — the lock
// directory and backups included.
// Writes (findings-r2, r3): every write, migration, allocation and registration holds the one store lock
// (local/lock, lib/fsx withLock), never nested: starting one inside another (a migration in an update callback)
// fails closed with lock-reentry (INTERNAL). A lock left by a process that is gone is not taken over: writes
// refuse with stale-lock (exit 7, REFUSED: nothing can be written until a person acts) and the hint to run
// `<bin> state unlock --stale`, the only way it is removed. Field checks that need no file come first; all
// schema checks run inside the lock right before the write: state.json (newer → exit 7, corrupt → exit 1), every
// file of the target's kind (a newer one → exit 7), the target itself. A refusal under the lock writes nothing
// but the lock, which is removed before returning (local/ too when the lock created it). Writes are atomic
// (lib/fsx); temporary files of dead writers in the written directory are swept.
// Carried data (store schema 2): a migration step may carry data its new schema cannot hold to another single-file
// kind (lib/state/migrations/index.mjs); read() and update() of that kind add it while the source file is still at a
// schema the step has to upgrade, so nothing is lost before `migrate` writes it (and reads still write nothing).
// Logs (LOGS, spec §5.2 local/shadow.jsonl): append() adds one JSON line under the store lock, rewriting the file
// atomically; it refuses in an inactive store before anything is created.
// Accepted residual (findings-r3): path checks and the file operation that follows are separate system calls
// (Node has no openat or O_NOFOLLOW for directories), so a process that can already write the store could swap
// a checked directory for a link in between. Locks never write through links, and that process could write the
// store directly anyway; this window is not closed.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createExclusive, makeDirs, removeEmptyDirs, sweepTemps, unlockStale as fsxUnlockStale, withLock, writeAtomic } from '../fsx/index.mjs';
import { checkWrite, invalidState, parseDoc, requireArg } from './document.mjs';
import { StateError, newerSchema } from './errors.mjs';
import { KINDS, LOGS } from './kinds.mjs';
import { MIGRATIONS } from './migrations/index.mjs';
import { format, validate } from './schema.mjs';
import { upgradeDoc } from './upgrade.mjs';

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const missing = (err) => err.code === 'ENOENT' || err.code === 'ENOTDIR';

export function open(dir, { names, kinds = KINDS, migrations = MIGRATIONS, lockTimeoutMs = 10000 } = {}) {
  requireArg(names, 'names', 'open');
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new TypeError(`state.open: the state directory must be an absolute path, got ${dir}`);
  return new Store(dir, { names, kinds, migrations, lockTimeoutMs });
}

// The lib/fsx lock errors as state errors (other errors unchanged).
export function lockFailure(err, names) {
  if (err?.code === 'ELOCKED') return new StateError('locked', 'ENV', err.message, { hint: `wait for the other ${names.bin} command to finish` });
  if (err?.code === 'ESTALE') return new StateError('stale-lock', 'REFUSED', err.message, { hint: `if no ${names.bin} command is running, run '${names.bin} state unlock --stale'` });
  if (err?.code === 'EREENTRANT') return new StateError('lock-reentry', 'INTERNAL', err.message, { hint: 'a state write was started inside another one; report this' });
  return err;
}

// Removes the store lock of a process that is gone (an explicit command, for a store nobody is using; lib/fsx
// unlockStale); { removed, owner }. quietMs: how long the lock must stay unchanged (default 2 s).
export function unlockStale(store, { quietMs } = {}) {
  try {
    return fsxUnlockStale(store.abs('local/lock'), { quietMs });
  } catch (err) {
    throw busyFailure(err, store.names);
  }
}

// lib/fsx unlockStale refusals (EBUSY) as state errors (other errors unchanged).
export function busyFailure(err, names) {
  if (err?.code !== 'EBUSY') return err;
  return new StateError('store-busy', 'REFUSED', err.message, { hint: `run it when no ${names.bin} command is running: it removes only a lock whose owner is gone and that stayed unchanged for 2 seconds` });
}

// realpath names where an entry is now: on macOS it asks the system for the path of the opened entry, so an
// entry renamed meanwhile (a lock released to lock.released-<token>) comes back under its new name. A case alias
// is the same entry (same inode) under a path that differs from ours only in case; anything else moved
// meanwhile and is treated as if lstat had missed it (findings S3).
function caseAlias(cur, onDisk, st) {
  const fold = (p) => p.normalize('NFC').toLowerCase();
  if (fold(onDisk) !== fold(cur)) return false;
  const now = lstatSync(onDisk, { throwIfNoEntry: false });
  return now !== undefined && now.ino === st.ino && now.dev === st.dev;
}

export const unsafe = (path, why) => new StateError('state-invalid', 'FAIL', `${path} ${why}; the state never follows links or case aliases`, { hint: 'replace it with a plain directory or file of exactly that name' });

// Public: active, read, list, write, create, update, append. The other methods are internal to lib/state.
export class Store {
  constructor(dir, { names, kinds, migrations, lockTimeoutMs }) {
    this.dir = dir;
    this.names = names;
    this.kinds = kinds;
    this.migrations = migrations;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  get active() {
    return this.readText(this.kinds.state.path()) !== null;
  }

  kind(name) {
    if (!Object.hasOwn(this.kinds, name)) throw new TypeError(`state: unknown kind ${name}`);
    return this.kinds[name];
  }

  // ---- paths ----

  // The absolute path of `rel` after checking it: the root and every existing component of rel must be plain
  // entries (no symbolic link) whose name on disk is exactly the one asked for.
  abs(rel) {
    const parts = rel === '' ? [] : rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new TypeError(`state: bad store path ${rel}`);
    // Entries can vanish while they are checked (another process removing its lock): check again.
    for (let attempt = 0; ; attempt++) {
      try {
        this.checkPath(parts);
        return join(this.dir, rel);
      } catch (err) {
        if (!missing(err) || attempt >= 5) throw err;
      }
    }
  }

  checkPath(parts) {
    let st;
    try {
      st = lstatSync(this.dir);
    } catch (err) {
      if (missing(err)) return;
      throw err;
    }
    if (st.isSymbolicLink()) throw unsafe(this.dir, 'is a symbolic link');
    const root = realpathSync.native(this.dir);
    let cur = root;
    let curSt = st;
    const done = [];
    for (const part of parts) {
      st = lstatSync(join(cur, part), { throwIfNoEntry: false });
      if (!st) break;
      done.push(part);
      if (st.isSymbolicLink()) throw unsafe(join(this.dir, ...done), 'is a symbolic link');
      if (!st.isDirectory() && done.length < parts.length) break;
      cur = join(cur, part);
      curSt = st;
    }
    if (cur !== root) {
      const onDisk = realpathSync.native(cur);
      if (onDisk !== cur && caseAlias(cur, onDisk, curSt)) throw unsafe(join(this.dir, ...done), `differs in case from its name on disk (${onDisk.slice(root.length + 1)})`);
    }
  }

  readText(rel) {
    try {
      return readFileSync(this.abs(rel), 'utf8');
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  }

  // Directory entries of `rel` ([] when absent); a symbolic link among them is refused.
  entries(rel) {
    let names;
    try {
      names = readdirSync(this.abs(rel));
    } catch (err) {
      if (missing(err)) return [];
      throw err;
    }
    for (const n of names) {
      let st;
      try { st = lstatSync(join(this.dir, rel, n)); } catch (err) { if (missing(err)) continue; throw err; }
      if (st.isSymbolicLink()) throw unsafe(join(this.dir, rel, n), 'is a symbolic link');
    }
    return names;
  }

  // ---- checks (inside the lock for writes) ----

  parse(kind, rel, text, { write = false, key = null } = {}) {
    const where = this.abs(rel);
    const doc = parseDoc(kind, text, { where, names: this.names, write, upgrade: (k, d, w) => upgradeDoc(k, d, this.migrations, w) });
    if (kind.key && doc.schema <= kind.version && doc[kind.key] !== key) throw invalidState(where, `${kind.key} ${JSON.stringify(doc[kind.key])} does not match the file name`);
    return doc;
  }

  // SC10: a store whose state.json is newer than this plugin refuses every write (a corrupt one too).
  assertWritable() {
    const kind = this.kinds.state;
    const text = this.readText(kind.path());
    if (text !== null) this.parse(kind, kind.path(), text, { write: true });
  }

  // A newer file of the kind anywhere in the store (the target included) refuses writes of the kind.
  refuseNewerKind(kind) {
    for (const key of this.list(kind.name)) {
      const rel = kind.path(key);
      let doc;
      try { doc = JSON.parse(this.readText(rel)); } catch { continue; } // corrupt: a full write repairs it
      if (Number.isInteger(doc?.schema) && doc.schema > kind.version) throw newerSchema(this.names, this.abs(rel), doc.schema, kind.version);
    }
  }

  // The schema checks of a write of `rel` (kind): path, store schema, kind schemas.
  checks(kind, rel) {
    this.abs(rel);
    this.assertWritable();
    this.refuseNewerKind(kind);
  }

  // ---- the store lock ----

  // Runs fn while holding the store lock (not re-entrant).
  locked(fn) {
    try {
      return withLock(this.abs('local/lock'), fn, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      throw lockFailure(err, this.names);
    }
  }

  // Housekeeping (temporary files of dead writers in the directory) only after the write succeeded, so a
  // failed or refused operation has no effect.
  writeText(rel, text) {
    const file = this.abs(rel);
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(this.abs(rel), text);
    sweepTemps(dirname(file));
  }

  // Exclusive creation; a directory made for it is removed again when the creation does not happen.
  createText(rel, text) {
    const file = this.abs(rel);
    const made = makeDirs(dirname(file));
    let created = false;
    try {
      created = createExclusive(this.abs(rel), text);
      if (created) sweepTemps(dirname(file));
      return created;
    } catch (err) {
      if (err.code === 'EFSUNSUPPORTED') throw new StateError('fs-unsupported', 'REFUSED', err.message, { hint: 'keep the state directory on a local file system with hard links (or link an external one with --state-dir)' });
      throw err;
    } finally {
      if (!created) removeEmptyDirs(dirname(file), made);
    }
  }

  // The document of a single-file kind with the data that older documents of other kinds still carry for it (each
  // migration step whose carry targets the kind, while its source file is at the step's schema or older).
  carried(kind, doc) {
    if (kind.keyPattern || (doc !== null && doc.schema > kind.version)) return doc;
    let out = doc;
    for (const m of this.migrations) {
      if (m.carry?.kind !== kind.name) continue;
      const source = Object.values(this.kinds).find((k) => k.name === m.kind && !k.keyPattern);
      const text = source ? this.readText(source.path()) : null;
      if (text === null) continue;
      const where = this.abs(source.path());
      let raw;
      try { raw = JSON.parse(text); } catch { throw invalidState(where, 'not valid JSON'); }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Number.isInteger(raw.schema) || raw.schema < 1) throw invalidState(where, 'no integer schema field');
      if (raw.schema > m.from) continue;
      const next = m.carry.into(out === null ? null : structuredClone(out), upgradeDoc(source, raw, this.migrations, where, m.from));
      if (next === undefined) continue;
      const errors = validate(kind.spec, next);
      if (errors.length) throw invalidState(this.abs(kind.path()), `with what ${m.id} carries from ${source.path()}: ${errors[0].message}`, errors);
      out = next;
    }
    return out;
  }

  stamp(kind, doc) {
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) && doc.schema === undefined ? { ...doc, schema: kind.version } : doc;
  }

  // ---- public ----

  // The document of `key` (null when absent), upgraded to the kind's schema.
  read(name, key) {
    const kind = this.kind(name);
    const rel = kind.path(key);
    const text = this.readText(rel);
    return this.carried(kind, text === null ? null : this.parse(kind, rel, text, { key }));
  }

  // Keys of the kind's existing files, in natural order ([null] for a single-file kind that exists).
  list(name) {
    const kind = this.kind(name);
    if (!kind.keyPattern) return this.readText(kind.path()) === null ? [] : [null];
    const keys = [];
    for (const entry of this.entries(kind.dir)) {
      const rel = `${kind.dir}/${entry}`;
      let candidates = [rel];
      if (lstatSync(join(this.dir, rel), { throwIfNoEntry: false })?.isDirectory()) candidates = this.entries(rel).map((f) => `${rel}/${f}`);
      for (const c of candidates) {
        const m = kind.match.exec(c);
        if (!m && new RegExp(kind.match.source, 'i').test(c)) throw unsafe(join(this.dir, c), `differs in case from the name of a ${kind.name} file`);
        if (m && lstatSync(join(this.dir, c), { throwIfNoEntry: false })?.isFile()) keys.push(m[1]);
      }
    }
    return keys.sort(natural);
  }

  // Replaces the document of `key`; returns what was written.
  write(name, key, doc) {
    const kind = this.kind(name);
    const rel = kind.path(key);
    const next = this.stamp(kind, doc);
    checkWrite(kind, next, { where: join(this.dir, rel), key });
    return this.locked(() => {
      this.checks(kind, rel);
      this.writeText(rel, format(kind.spec, next));
      return next;
    });
  }

  // Creates the document only if no file exists; true when created.
  create(name, key, doc) {
    const kind = this.kind(name);
    const rel = kind.path(key);
    const next = this.stamp(kind, doc);
    checkWrite(kind, next, { where: join(this.dir, rel), key });
    return this.locked(() => this.insert(kind, rel, next));
  }

  // Internal: create() for a caller that already holds the store lock.
  insert(kind, rel, next) {
    this.checks(kind, rel);
    return this.readText(rel) === null && this.createText(rel, format(kind.spec, next));
  }

  // fn(copy of the current document or null) → new document, or undefined to write nothing; returns the
  // stored document afterwards.
  update(name, key, fn) {
    const kind = this.kind(name);
    const rel = kind.path(key);
    return this.locked(() => {
      this.checks(kind, rel);
      const text = this.readText(rel);
      const cur = this.carried(kind, text === null ? null : this.parse(kind, rel, text, { write: true, key }));
      const out = fn(cur === null ? null : structuredClone(cur));
      if (out === undefined) return cur;
      const next = this.stamp(kind, out);
      checkWrite(kind, next, { where: this.abs(rel), key });
      this.writeText(rel, format(kind.spec, next));
      return next;
    });
  }

  // Appends `make` (a JSON object, or a function of the log's text returning one, or undefined for nothing) as one line
  // to the log `name`; returns the entry or null. The read, the decision and the write share one lock section.
  append(name, make) {
    if (!Object.hasOwn(LOGS, name)) throw new TypeError(`state: unknown log ${name}`);
    const log = LOGS[name];
    if (!this.active) throw new StateError('inactive', 'REFUSED', `${this.dir} holds no active state: nothing is logged`, { hint: `activate the repository first (${this.names.bin} init)` });
    return this.locked(() => {
      this.assertWritable();
      const text = this.readText(log.file) ?? '';
      const entry = typeof make === 'function' ? make(text) : make;
      if (entry === undefined) return null;
      const errors = validate({ t: 'data', maxBytes: log.entryBytes }, entry);
      if (errors.length) throw new StateError(errors[0].code, 'USAGE', `${this.abs(log.file)}: ${errors[0].message}`, { hint: 'nothing was logged', details: errors });
      this.writeText(log.file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n`);
      return entry;
    });
  }
}
