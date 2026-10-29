// State file kinds (spec §5.1, §5.3, §8.2, SD-9, SD-10): one entry per kind of file this unit reads and writes.
// Each kind has its own integer schema `version` (every file carries `schema`), `readUpTo` (the newest schema
// its reader still understands for read-only use; writes always need schema <= version), the file path for a
// key, the pattern that recognises such a file in the store (group 1 = the key), the document field that must
// equal the key, and the field spec (lib/state/schema.mjs). The state.json schema is the store schema.
// Keys are checked against their pattern before they become paths, so a key never escapes its directory.
// Store schema 2 (spec §5.1, §14, SD-38): the capability flags moved from state.json to config.json, with threshold
// overrides (each cites its decision) and executor role preferences; migration 001 carries an old flags map over.
import { StateError } from './errors.mjs';

// Spec §8.2 limits plus the defaults for fields the spec leaves open (counts, sizes); one source for every check.
export const LIMITS = Object.freeze({
  title: 120, evidence: 300, reason: 200, glob: 120, eventData: 1024,
  lane: 40, branch: 200, token: 40, actor: 80, event: 40, codename: 40, version: 40, path: 4096, idNumber: 999999,
  email: 320, decisionBytes: 65536,
  events: 10000, classHistory: 1000, flags: 100, projects: 10000, round: 1000,
  thresholds: 200, thresholdKey: 80, thresholdValue: 1000000000, providers: 10, logEntryBytes: 16384,
});

export const PATTERNS = Object.freeze({
  handle: /^[A-Z]{2,4}$/,
  taskId: /^T-[A-Z]{2,4}-[1-9]\d{0,5}$/,
  findingId: /^B-[A-Z]{2,4}-[1-9]\d{0,5}$/,
  decisionId: /^D-[A-Z]{2,4}-[1-9]\d{0,5}$/,
  id: /^[TDB]-[A-Z]{2,4}-[1-9]\d{0,5}$/,
  lane: /^[a-z0-9][a-z0-9._-]{0,39}$/,
  kebab: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  actor: /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/,
  sha: /^[0-9a-f]{7,64}$/,
  sha256: /^[0-9a-f]{64}$/,
  semver: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  codename: /^[a-z][a-z0-9-]*$/,
  branch: /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/,
  absPath: /^\/(?!.*\/\.\.?(?:\/|$))/,
  // <unit>.<path to a number in the unit's threshold data>, such as router.trivial.maxLoc (lib/config checks the path).
  thresholdKey: /^[a-z][a-z0-9]*(?:\.[A-Za-z0-9]+)+$/,
});

const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
// IDs and handles: the pattern fixes the length, so a wrong length is an invalid value, not a limit.
const token = (re, extra = {}) => str(LIMITS.token, { re, ...extra });
const time = { t: 'time' };
const enumOf = (of, extra = {}) => ({ t: 'enum', of, ...extra });
const CLASSES = ['trivial', 'standard', 'critical'];
const flagsMap = { t: 'map', key: str(LIMITS.event, { re: PATTERNS.kebab }), v: enumOf(['off', 'shadow', 'on']), max: LIMITS.flags };
const providers = { t: 'arr', max: LIMITS.providers, of: token(PATTERNS.kebab) };
const executors = { t: 'obj', f: { reviewer: providers, implementer: providers }, opt: ['reviewer', 'implementer'] };
export const TASK_STATUSES = Object.freeze(['new', 'planned', 'dispatched', 'implemented', 'in-review', 'fix-round', 'verified', 'done', 'blocked', 'cancelled']);

// A kind: `dir` (its directory in the store, '' for the root), `keyPattern` (null for a single file),
// `file(key)` (path inside the store), `match` (recognises its files; group 1 = the key), `key` (the document field
// equal to the key), `fields` and `opt` (lib/state/schema.mjs), `readUpTo`. path() checks the key first.
export function defineKind(name, version, { dir, keyPattern = null, file, match, key = null, fields, opt, readUpTo = version }) {
  const path = keyPattern
    ? (k) => {
      if (typeof k !== 'string' || !keyPattern.test(k)) throw new StateError('invalid-key', 'USAGE', `${JSON.stringify(k)} is not a valid ${name} key`, { hint: `expected ${keyPattern}` });
      return file(k);
    }
    : () => file();
  return Object.freeze({ name, version, readUpTo, dir, keyPattern, path, match, key, spec: { t: 'obj', f: { schema: { t: 'int', min: version, max: version }, ...fields }, opt } });
}

export const KINDS = Object.freeze({
  state: defineKind('state', 2, {
    dir: '',
    file: () => 'state.json',
    match: /^state\.json$/,
    fields: {
      codename: str(LIMITS.codename, { re: PATTERNS.codename }),
      createdWith: str(LIMITS.version, { re: PATTERNS.semver }),
      activatedAt: time,
    },
  }),
  // The repository's configuration (spec §5.1 config.json, SD-38): flags {capability: off|shadow|on}, thresholds
  // {<unit>.<path>: {value, decision, at}} (an override cites the decision that allows it), executors {role: [provider…]}
  // in order of preference. Every part is optional; lib/config adds the defaults and the machine overrides.
  config: defineKind('config', 1, {
    dir: '',
    file: () => 'config.json',
    match: /^config\.json$/,
    fields: {
      flags: flagsMap,
      thresholds: {
        t: 'map', max: LIMITS.thresholds, key: str(LIMITS.thresholdKey, { re: PATTERNS.thresholdKey }),
        v: { t: 'obj', f: { value: { t: 'int', min: 0, max: LIMITS.thresholdValue }, decision: token(PATTERNS.decisionId), at: time } },
      },
      executors,
    },
    opt: ['flags', 'thresholds', 'executors'],
  }),
  team: defineKind('team', 1, {
    dir: 'team',
    keyPattern: PATTERNS.handle,
    file: (h) => `team/${h}.json`,
    match: /^team\/([A-Z]{2,4})\.json$/,
    key: 'handle',
    fields: {
      handle: token(PATTERNS.handle),
      emailSha256: token(PATTERNS.sha256, { max: 64 }),
      addedAt: time,
    },
  }),
  // Task schema 2 (T-MG-80): the optional mergedAt (the time of the task's `merged` event, written by task merge) joins
  // the task; migration 004 is a no-op upgrade, so an older plugin refuses a schema-2 task as newer (GC9).
  task: defineKind('task', 2, {
    dir: 'tasks',
    keyPattern: PATTERNS.taskId,
    file: (id) => `tasks/${id}/task.json`,
    match: /^tasks\/(T-[A-Z]{2,4}-[1-9]\d{0,5})\/task\.json$/,
    key: 'id',
    fields: {
      id: token(PATTERNS.taskId),
      kind: enumOf(['task', 'gate', 'incident']),
      title: str(LIMITS.title, { min: 1 }),
      lane: str(LIMITS.lane, { re: PATTERNS.lane, null: true }),
      owner: token(PATTERNS.handle),
      class: enumOf(CLASSES, { null: true }),
      classHistory: { t: 'arr', max: LIMITS.classHistory, of: { t: 'obj', f: { class: enumOf(CLASSES), reason: str(LIMITS.reason), at: time } } },
      status: enumOf(TASK_STATUSES),
      round: { t: 'int', min: 0, max: LIMITS.round },
      events: { t: 'arr', max: LIMITS.events, of: { t: 'obj', f: { at: time, by: str(LIMITS.actor, { re: PATTERNS.actor }), event: str(LIMITS.event, { re: PATTERNS.kebab }), data: { t: 'data', maxBytes: LIMITS.eventData } } } },
      base: token(PATTERNS.sha, { max: 64, null: true }),
      branch: str(LIMITS.branch, { re: PATTERNS.branch, null: true }),
      mergedAt: time,
    },
    opt: ['mergedAt'],
  }),
  finding: defineKind('finding', 1, {
    dir: 'findings',
    keyPattern: PATTERNS.findingId,
    file: (id) => `findings/${id}.json`,
    match: /^findings\/(B-[A-Z]{2,4}-[1-9]\d{0,5})\.json$/,
    key: 'id',
    fields: {
      id: token(PATTERNS.findingId),
      status: enumOf(['open', 'taken', 'fixed', 'dropped']),
      task: token(PATTERNS.taskId),
      round: { t: 'int', min: 1, max: 999 },
      reviewer: { t: 'obj', f: { kind: enumOf(['claude', 'external']), id: str(LIMITS.actor, { re: PATTERNS.actor }) } },
      finding: str(40, { min: 1 }),
      severity: enumOf(['blocking', 'minor']),
      path: str(LIMITS.path, { null: true }),
      line: { t: 'int', min: 1, max: 100000000, null: true },
      rule: str(40, { null: true }),
      text: str(500, { min: 1 }),
      filedAt: time,
      filedBy: token(PATTERNS.handle),
      takenBy: token(PATTERNS.taskId, { null: true }),
      closedAt: { ...time, null: true },
      closedBy: token(/^[TD]-[A-Z]{2,4}-[1-9]\d{0,5}$/, { null: true }),
      reason: str(500, { null: true }),
    },
  }),
  // SD-9: a retired ID keeps a tombstone, so its number is never allocated again.
  tombstone: defineKind('tombstone', 1, {
    dir: 'tombstones',
    keyPattern: PATTERNS.id,
    file: (id) => `tombstones/${id}.json`,
    match: /^tombstones\/([TDB]-[A-Z]{2,4}-[1-9]\d{0,5})\.json$/,
    key: 'id',
    fields: {
      id: token(PATTERNS.id),
      retiredAt: time,
      by: str(LIMITS.actor, { re: PATTERNS.actor }),
      reason: str(LIMITS.reason),
    },
  }),
  // Review round 1, item 2: the per-handle high-water mark of an ID series (machine-local, under local/).
  counter: defineKind('counter', 1, {
    dir: 'local/ids',
    keyPattern: /^[TDB]-[A-Z]{2,4}$/,
    file: (k) => `local/ids/${k}.json`,
    match: /^local\/ids\/([TDB]-[A-Z]{2,4})\.json$/,
    fields: { high: { t: 'int', min: 0, max: LIMITS.idNumber } },
  }),
});

// Machine data (spec §5.3, `${CLAUDE_PLUGIN_DATA}`): projects.json maps a repository's real path to its linked
// state directory, a decline time and the developer's handle; config.json holds this user's overrides of capability
// flags and executor preferences (SD-38: machine overrides), edited by hand. Threshold overrides are per repository:
// they cite its decisions.
export const MACHINE_KINDS = Object.freeze({
  projects: defineKind('projects', 1, {
    dir: '',
    file: () => 'projects.json',
    match: /^projects\.json$/,
    fields: {
      projects: {
        t: 'map', max: LIMITS.projects, key: str(LIMITS.path, { re: PATTERNS.absPath }),
        v: { t: 'obj', opt: ['stateDir', 'declinedAt', 'handle'], f: { stateDir: str(LIMITS.path, { re: PATTERNS.absPath }), declinedAt: time, handle: token(PATTERNS.handle) } },
      },
    },
  }),
  machineConfig: defineKind('machineConfig', 1, {
    dir: '',
    file: () => 'config.json',
    match: /^config\.json$/,
    fields: { flags: flagsMap, executors },
    opt: ['flags', 'executors'],
  }),
  // T-MG-77: the gate sets and threshold overrides this machine trusts, per repository (lib/state/trust.mjs).
  trust: defineKind('trust', 1, {
    dir: '',
    file: () => 'trust.json',
    match: /^trust\.json$/,
    fields: {
      repos: {
        t: 'map', max: LIMITS.projects, key: str(32, { re: /^[0-9a-f]{32}$/ }),
        v: {
          t: 'obj', opt: ['adoptedAt'],
          f: { gates: { t: 'arr', max: 50, of: str(64, { re: PATTERNS.sha256 }) }, overrides: { t: 'arr', max: 50, of: str(64, { re: PATTERNS.sha256 }) }, adoptedAt: time },
        },
      },
    },
  }),
});

// Append-only logs of the store (spec §5.2): one JSON object per line, each at most entryBytes (store.append).
export const LOGS = Object.freeze({
  shadow: Object.freeze({ file: 'local/shadow.jsonl', entryBytes: LIMITS.logEntryBytes }),
});
