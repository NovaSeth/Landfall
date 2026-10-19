// Scheduler constants and machine data files (spec §5.3, §7.8, SD-19): lease kinds, defaults, port blocks and the
// schemas of leases/<kind>-<slot>.json, <kind>-queue/<worktree hash>.json and calibration.json, checked with the
// lib/state schema checker (strict objects, length limits, no control or bidi characters).
import { defineKind } from '../state/index.mjs';

export const KIND_NAMES = Object.freeze(['agent', 'external', 'e2e', 'heavy']);
// Exclusive kinds wait in a FIFO queue, one ticket per worktree (§7.8a); the others are admitted or not at once.
export const FIFO_KINDS = Object.freeze(['e2e', 'heavy']);
// Slots per kind are capped so each (kind, slot) owns a fixed port block and DB number: k = base + slot.
export const MAX_SLOTS = 20;
const BLOCK_BASE = Object.freeze({ agent: 0, external: 20, e2e: 40, heavy: 60 });
export const PORT_BASE = 41000;
export const blockOf = (kind, slot) => BLOCK_BASE[kind] + slot;
export const portsOf = (kind, slot) => [PORT_BASE + 10 * blockOf(kind, slot), PORT_BASE + 10 * blockOf(kind, slot) + 9];

// Spec §7.8 defaults [all calibrate]: LOAD_MAX = 1.7 × cores, FREE_MIN = 30 %, per-kind max; agent TTL 10 min.
export const DEFAULTS = Object.freeze({
  loadFactor: 1.7,
  freeMinPct: 30,
  max: Object.freeze({ agent: 3, external: 2, e2e: 1, heavy: 1 }),
  ttlS: Object.freeze({ agent: 600, external: 3600, e2e: 3600, heavy: 3600 }),
  ticketS: 3600, // deadline of a ticket taken by one acquire without a deadline of its own (acquireWait passes its own)
  recalibrateDays: 30,
});

export const TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ABS = /^\/(?!.*\/\.\.?(?:\/|$))/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const time = { t: 'time' };
const pid = { t: 'int', min: 1, max: 2 ** 22 };
const start = { t: 'str', max: 64, null: true };
const method = { t: 'enum', of: ['ps', 'proc'], null: true };
const identity = { pid, start, method };
const kindsMax = { t: 'obj', f: Object.fromEntries(KIND_NAMES.map((k) => [k, { t: 'int', min: 1, max: MAX_SLOTS }])) };

export const LEASE = defineKind('lease', 1, {
  dir: 'leases',
  keyPattern: new RegExp(`^(?:${KIND_NAMES.join('|')})-(?:[1-9]|1\\d|20)$`),
  file: (k) => `leases/${k}.json`,
  match: new RegExp(`^leases/((?:${KIND_NAMES.join('|')})-(?:[1-9]|1\\d|20))\\.json$`),
  fields: {
    id: { t: 'str', max: 16, re: /^[0-9a-f]{16}$/ },
    kind: { t: 'enum', of: KIND_NAMES },
    slot: { t: 'int', min: 1, max: MAX_SLOTS },
    // A process ({ pid, start, method }: lib/sched/machine.mjs identity) or an agent of a session ({ sessionId,
    // key: tool_use_id, agentId }).
    owner: {
      t: 'obj', opt: ['pid', 'start', 'method', 'sessionId', 'key', 'agentId'],
      f: { ...identity, sessionId: { t: 'str', max: 128, re: TOKEN }, key: { t: 'str', max: 128, re: TOKEN }, agentId: { t: 'str', max: 128, re: TOKEN, null: true } },
    },
    project: { t: 'str', max: 4096, re: ABS },
    task: { t: 'str', max: 80, re: TASK, null: true },
    ports: { t: 'arr', max: 2, of: { t: 'int', min: 1024, max: 65535 } },
    db: { t: 'str', max: 64, re: /^[a-z][a-z0-9_]{0,40}_[0-9a-f]{6}_\d{1,3}$/ },
    at: time,
    heartbeatAt: time,
    ttlS: { t: 'int', min: 1, max: 7 * 86400 },
    child: { t: 'obj', null: true, f: identity }, // leads its own process group: the group id is its pid
  },
});

export const TICKET = defineKind('ticket', 1, {
  dir: '',
  keyPattern: new RegExp(`^(?:${FIFO_KINDS.join('|')})-queue/[0-9a-f]{16}$`),
  file: (k) => `${k}.json`,
  match: new RegExp(`^((?:${FIFO_KINDS.join('|')})-queue/[0-9a-f]{16})\\.json$`),
  fields: {
    kind: { t: 'enum', of: FIFO_KINDS },
    seq: { t: 'int', min: 1, max: Number.MAX_SAFE_INTEGER },
    worktree: { t: 'str', max: 4096, re: ABS },
    owner: { t: 'obj', f: identity },
    task: { t: 'str', max: 80, re: TASK, null: true },
    at: time,
    deadline: time, // after it any caller removes the ticket (findings r1 8)
  },
});

export const CALIBRATION = defineKind('calibration', 1, {
  dir: '',
  file: () => 'calibration.json',
  match: /^calibration\.json$/,
  fields: {
    at: time,
    cores: { t: 'int', min: 1, max: 4096 },
    totalMemBytes: { t: 'int', min: 1, max: Number.MAX_SAFE_INTEGER },
    memMethod: { t: 'enum', of: ['vm_stat', 'meminfo', 'freemem'] },
    loadMeasurable: { t: 'enum', of: [true, false] },
    loadMax: { t: 'str', max: 8, re: /^(?:off|\d{1,5}\.\d)$/ },
    freeMinPct: { t: 'int', min: 1, max: 95 },
    max: kindsMax,
    overrides: {
      t: 'obj', opt: ['loadMax', 'freeMinPct', 'max'],
      f: { loadMax: { t: 'str', max: 8, re: /^(?:off|\d{1,5}\.\d)$/ }, freeMinPct: { t: 'int', min: 1, max: 95 }, max: { ...kindsMax, opt: KIND_NAMES } },
    },
  },
});
