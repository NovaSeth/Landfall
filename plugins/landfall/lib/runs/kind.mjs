// Run record kinds (spec §8.5, ruling R70): local/runs/<runId>.json, the record of one external run, and
// local/runs/<runId>.log, a JSON document holding the last output lines (state strings refuse line breaks). Both are
// lib/state kinds: written through a store opened with RUN_KINDS (validated, atomic, locked, refused for a newer schema).
// Additions to §8.5: money and time are whole micro-dollars and milliseconds (costMicroUsd, elapsedMs: R70); pid,
// pidStart and pidMethod are the supervisor's identity (lib/sched machine.mjs), so a detached supervisor is found again
// by record and identity, never by name; capS is the wall cap; unknownEvents counts output lines the adapter did not
// recognise (U8); bin (B-2) is the provider program's absolute path, resolved by exec and the only program
// run-supervise starts; outDirId (SF-AB-10) is "<dev>:<ino>" of the run's private temp directory, made by exec, which
// run-supervise checks before it starts the provider. Both are optional for the schema: a record without them, written
// by 2.4.1, is refused as tampered.
import { LAST_LINE, PROVIDER_ID, ROLES } from '../providers/kind.mjs';
import { LIMITS, PATTERNS, defineKind } from '../state/index.mjs';

export const STATUSES = Object.freeze(['queued', 'starting', 'running', 'done', 'failed', 'timeout', 'stopped']);
export const TERMINAL = Object.freeze(['done', 'failed', 'timeout', 'stopped']);
const RUN_SOURCE = '[a-z0-9]{1,20}-T-[A-Z]{2,4}-[1-9]\\d{0,5}-(?:reviewer|implementer)-[1-9]\\d{0,5}';
export const RUN_ID = new RegExp(`^${RUN_SOURCE}$`);
export const runIdOf = (provider, task, role, n) => `${provider}-${task}-${role}-${n}`;
// Wall caps per role (a cross-provider review: 15 min), the log of the last lines.
export const CAP_S = Object.freeze({ reviewer: 900, implementer: 2700 });
export const CAP_MAX_S = 7200;
export const LOG_LINES = 200;
export const LOG_LINE = 500;

const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
const time = { t: 'time' };
const count = { t: 'int', min: 0, max: Number.MAX_SAFE_INTEGER };
const nullable = (spec) => ({ ...spec, null: true });

export const RUN = defineKind('run', 1, {
  dir: 'local/runs',
  keyPattern: RUN_ID,
  file: (id) => `local/runs/${id}.json`,
  match: new RegExp(`^local/runs/(${RUN_SOURCE})\\.json$`),
  key: 'runId',
  fields: {
    runId: str(80, { re: RUN_ID }),
    task: str(LIMITS.token, { re: PATTERNS.taskId }),
    role: { t: 'enum', of: ROLES },
    provider: str(20, { re: PROVIDER_ID }),
    adapterVersion: nullable(str(80)),
    model: nullable(str(80)),
    sandbox: str(40, { min: 1 }),
    cwd: str(LIMITS.path, { re: PATTERNS.absPath }),
    pid: nullable({ t: 'int', min: 1, max: 2 ** 22 }),
    pidStart: nullable(str(64)),
    pidMethod: { t: 'enum', of: ['ps', 'proc'], null: true },
    lease: nullable(str(40, { re: /^[a-z0-9]+-\d{1,2}$/ })),
    status: { t: 'enum', of: STATUSES },
    queuedAt: time,
    startedAt: nullable(time),
    endedAt: nullable(time),
    elapsedMs: count,
    capS: { t: 'int', min: 1, max: CAP_MAX_S },
    tokens: { t: 'obj', null: true, f: { input: count, output: count, cached: count } },
    tokensReason: nullable(str(LIMITS.reason)),
    costMicroUsd: nullable(count),
    lastLine: nullable(str(LAST_LINE)),
    unknownEvents: count,
    outFile: nullable(str(LIMITS.path, { re: PATTERNS.absPath })),
    exit: nullable({ t: 'int', min: -255, max: 255 }),
    error: nullable(str(300)),
    bin: str(LIMITS.path, { re: PATTERNS.absPath }),
    outDirId: str(41, { re: /^[0-9]{1,20}:[0-9]{1,20}$/ }),
  },
  opt: ['bin', 'outDirId'],
});

export const RUN_LOG = defineKind('runLog', 1, {
  dir: 'local/runs',
  keyPattern: RUN_ID,
  file: (id) => `local/runs/${id}.log`,
  match: new RegExp(`^local/runs/(${RUN_SOURCE})\\.log$`),
  key: 'runId',
  fields: {
    runId: str(80, { re: RUN_ID }),
    lines: { t: 'arr', max: LOG_LINES, of: str(LOG_LINE) },
  },
});

export const RUN_KINDS = Object.freeze({ [RUN.name]: RUN, [RUN_LOG.name]: RUN_LOG });
