// `<bin> exec --task <id> --role <r> [--provider <p>]` and the hidden `<bin> run-supervise <run>` (spec §7.12, §8.5,
// §7.8). exec selects the provider (select.mjs), writes the run record {status: starting} and starts one detached
// supervisor per run (lib/proc start: stdin ignored, pipes closed), then prints {runId}. The supervisor takes the
// `external` lease itself (status queued while waiting), runs the adapter argv through sched.supervise in its own
// process group under the wall cap (SIGTERM, grace, SIGKILL), feeds the brief on stdin, streams stdout through
// adapter.parse into the record (at most once a second) and the log, writes the outcome, and releases the lease only
// after the group is gone. A reviewer runs read-only in the repository checkout; the out file lives in a private temp
// directory (0700). Implementer runs (a worktree from the task base) are not in this slice: exit 2.
// Exit (exec) 0 · 1 no such task, no brief, a live run of the task and role · 2 bad role or provider · 7 inactive
// repository, newer schema · 8 provider missing or logged out.
import { tolerateClosedStreams } from '../cli/output.mjs';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EXIT } from '../cli/commands.mjs';
import { createExclusive } from '../fsx/index.mjs';
import { start } from '../proc/index.mjs';
import { capFor, liveRun, nextRunId, runsStore, LOG_LINE, LOG_LINES } from '../runs/index.mjs';
import { SYSTEM, acquireWait, attachChild, identify, release, supervise } from '../sched/index.mjs';
import { KINDS, TASK_TEXTS, resolve, taskTextFile } from '../state/index.mjs';
import { adapters, chooseProvider, detectProviders } from './index.mjs';
import { projectRedactions, redact } from '../verify/redact.mjs';
import { LAST_LINE, ROLES } from './kind.mjs';
import { cleanLine } from './probe.mjs';

const GRACE_MS = 2000;
const FLUSH_MS = 1000;
const WAIT_MS = 3600e3;
const fail = (code, message, hint) => ({ code: EXIT.FAIL, errors: [{ code, message, hint }] });

function where(io, names) {
  const w = resolve({ cwd: io.cwd, env: io.env, names });
  if (!w.active) return { refused: { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${w.repo} is not active`, hint: `'${names.bin} init' activates it` }] } };
  return { w, store: runsStore(w.dir, names) };
}

export function exec({ flags, names, io, pluginRoot }) {
  const { bin } = names;
  const role = flags.role;
  if (!ROLES.includes(role)) return { code: EXIT.USAGE, errors: [{ code: 'invalid-value', message: `--role ${String(role ?? '').slice(0, 40)}: expected ${ROLES.join(' or ')}`, hint: `${bin} exec --task <id> --role reviewer` }] };
  if (role === 'implementer') return { code: EXIT.USAGE, errors: [{ code: 'role-unsupported', message: 'implementer runs (a worktree from the task base) are not available yet', hint: 'run a reviewer' }] };
  const asked = flags.round === undefined ? undefined : Number(flags.round);
  if (asked !== undefined && (!/^[0-9]+$/.test(String(flags.round)) || !Number.isInteger(asked) || asked < 1 || asked > 999)) return { code: EXIT.USAGE, errors: [{ code: 'invalid-value', message: '--round: expected an integer from 1 to 999', hint: 'pass --round <k>' }] };
  const id = flags.task;
  KINDS.task.path(id); // a malformed ID is a usage error (invalid-key)
  const r = where(io, names);
  if (r.refused) return r.refused;
  const { w, store } = r;
  const task = store.read('task', id);
  if (!task) return fail('task-unknown', `no task ${id} in ${w.dir}`, `'${bin} task list' lists the tasks`);
  const taskDir = dirname(KINDS.task.path(id));
  const pattern = new RegExp(`^${TASK_TEXTS['review-brief'].replace('.', '\\.').replace('<k>', '([1-9][0-9]{0,2})')}$`);
  const round = asked ?? Math.max(0, ...store.entries(taskDir).map((file) => Number(pattern.exec(file)?.[1] ?? 0)));
  const brief = round ? store.readText(join(taskDir, taskTextFile('review-brief', { round }))) : null;
  if (!brief) return fail('review-brief-missing', `${id} has no saved review brief${asked === undefined ? '' : ` for round ${asked}`}`, `${bin} review brief ${id} --write`);
  const live = liveRun(store, id, role);
  if (live) return fail('run-live', `${live.runId} is ${live.status} for ${id} as ${role}`, 'wait for it to end');
  const row = chooseProvider({ role, rows: detectProviders({ names, env: io.env }).rows, explicit: flags.provider });
  const adapter = adapters({ names, env: io.env }).find((a) => a.id === row.id);
  const capS = capFor(role, io.env, names.envPrefix);
  const outDir = mkdtempSync(join(tmpdir(), `${bin}-run-`)); // 0700
  const input = `${brief}\n## External run (overrides the Output section above)\nYou run as ${row.id}:reviewer in a read-only sandbox: write no file. Your final message is the review JSON object alone, with "reviewer": {"kind": "external", "id": "${row.id}:reviewer"}, per the schema the Output section names. The orchestrator records it from the run's out file with \`${bin} review record ${id} --from <out file>\`.\n`;
  const briefFile = join(outDir, 'brief.md');
  if (!createExclusive(briefFile, input, { mode: 0o600 })) throw Object.assign(new Error(`${briefFile}: file already exists`), { code: 'EEXIST' });
  const runId = nextRunId(store, row.id, id, role);
  const record = {
    runId, task: id, role, provider: row.id, adapterVersion: row.version ?? null, model: null, sandbox: adapter.sandboxes[role], cwd: w.repo,
    pid: null, pidStart: null, pidMethod: null, lease: null, status: 'starting', queuedAt: new Date().toISOString(), startedAt: null, endedAt: null,
    elapsedMs: 0, capS, tokens: null, tokensReason: null, costMicroUsd: null, lastLine: null, unknownEvents: 0, outFile: join(outDir, 'out.json'), exit: null, error: null,
  };
  store.create('run', runId, record);
  store.create('runLog', runId, { runId, lines: [] });
  const child = start(process.execPath, [join(pluginRoot, 'bin', bin), 'run-supervise', runId, '--yes'], { unit: 'providers', cwd: io.cwd, env: io.env, detached: true, stdin: 'ignore' });
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  return { data: { runId, status: 'starting', provider: row.id, capS }, text: `${runId}: starting (${row.id}, ${role}, cap ${capS} s)\n` };
}

const patch0 = (store, runId, fields) => store.update('run', runId, (cur) => (cur ? { ...cur, ...fields } : undefined));

// out.json directly inside a real 0700 directory of ours under the temp directory, neither of them a link.
function ownOutFile(f) {
  try {
    if (typeof f !== 'string') return false;
    const dir = dirname(f);
    return realpathSync(dir) === join(realpathSync(tmpdir()), basename(dir)) && (lstatSync(dir).mode & 0o777) === 0o700 && !lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink();
  } catch { return false; }
}

const clip = (s, max) => (s.length > max ? s.slice(0, max) : s);

// Pending characters of one output stream: a longer line is cut there and counts as truncated (B-5, SF-AB-7).
export const PENDING_MAX = 64 * 1024;

// What a provider prints, as a state string: hidden characters (escapes, controls, tabs) removed, secrets masked by
// the shared redaction, then cut to max code points ('' when nothing visible is left). Cleaned whole first, so a
// secret is masked before a cut could show a prefix of it.
export const safeLine = (text, max, extra = []) => cleanLine(redact(cleanLine(text, PENDING_MAX) ?? '', extra), max) ?? '';

// A line splitter for one stream: feed(chunk) calls onLine(line, truncated) per complete line; end() emits the rest.
// At most PENDING_MAX characters stay pending; past it the rest of the line is dropped.
export function lineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let dropping = false;
  const emit = () => {
    const line = rest;
    const truncated = dropping;
    rest = '';
    dropping = false;
    onLine(line, truncated);
  };
  const take = (s) => {
    for (let at = 0; ;) {
      const nl = s.indexOf('\n', at);
      const part = nl < 0 ? s.slice(at) : s.slice(at, nl);
      if (!dropping) {
        const room = PENDING_MAX - rest.length;
        if (part.length > room) { rest += part.slice(0, room); dropping = true; } else rest += part;
      }
      if (nl < 0) return;
      at = nl + 1;
      emit();
    }
  };
  return {
    feed: (chunk) => take(decoder.write(chunk)),
    end: () => { take(decoder.end()); if (rest || dropping) emit(); },
    pending: () => rest.length,
  };
}

// Open without following a link or blocking on a FIFO, then check the opened file itself.
function pinnedBrief(outFile) {
  let fd;
  try {
    fd = openSync(join(dirname(outFile), 'brief.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export async function runSupervise({ args, names, io, pluginRoot }) {
  tolerateClosedStreams(); // the parent closed the pipes
  const r = where(io, names);
  if (r.refused) return r.refused;
  const { w, store } = r;
  const runId = args.run;
  const rec = store.read('run', runId);
  if (!rec) return fail('run-unknown', `no run ${runId} in ${w.dir}`, 'exec writes the record first');
  // The sandbox and the cwd come from the role and the repository, the out file from the run's own private temp
  // directory; a record that says otherwise was rewritten.
  const adapter = adapters({ names, env: io.env }).find((a) => a.id === rec.provider);
  const sandbox = ROLES.includes(rec.role) ? adapter?.sandboxes?.[rec.role] : undefined;
  const cwd = rec.role === 'reviewer' ? w.repo : undefined;
  const tampered = () => {
    patch0(store, runId, { status: 'failed', endedAt: new Date().toISOString(), error: 'run-tampered' });
    return fail('run-tampered', `${runId}: the run record or pinned brief does not match its role, the repository or its temp directory`, 'start the run again with exec');
  };
  if (!adapter || !sandbox || !cwd || rec.sandbox !== sandbox || rec.cwd !== cwd || !ownOutFile(rec.outFile) || pinnedBrief(rec.outFile) === null) return tampered();
  // The project's redaction patterns, read once as verify reads them; a file that cannot be read fails closed: no
  // provider starts, so no output is stored unredacted.
  let extra;
  try {
    extra = projectRedactions(w);
  } catch (err) {
    patch0(store, runId, { status: 'failed', endedAt: new Date().toISOString(), error: 'project-patterns-unreadable' });
    return fail('project-patterns-unreadable', String(err?.message ?? err).slice(0, 300), err?.hint ?? 'fix or remove the project pattern file');
  }
  const me = identify([process.pid], SYSTEM).get(process.pid);
  const patch = (fn) => store.update('run', runId, (cur) => (cur ? fn(cur) : undefined));
  patch((cur) => ({ ...cur, pid: process.pid, pidStart: me?.start ?? null, pidMethod: me?.method ?? null, status: 'queued', lastLine: 'waiting for an external slot' }));
  const opts = { names, env: io.env, cwd: io.cwd, task: rec.task, ttlS: rec.capS + GRACE_MS / 1000 + 60 };
  const got = await acquireWait('external', { ...opts, timeoutMs: WAIT_MS, onWait: (x) => patch((cur) => ({ ...cur, lastLine: clip(x.reasons.map((y) => y.message).join('; '), LAST_LINE) })) });
  if (!got.ok) {
    patch((cur) => ({ ...cur, status: 'failed', endedAt: new Date().toISOString(), error: clip(got.reasons.map((x) => x.message).join('; '), 300) }));
    return fail('wait-timeout', `no external slot within ${WAIT_MS / 1000} s`, 'retry later');
  }
  const brief = ownOutFile(rec.outFile) ? pinnedBrief(rec.outFile) : null;
  if (brief === null) {
    release(got.lease, opts);
    return tampered();
  }
  const argv = adapter.argv({ sandbox, cwd, outFile: rec.outFile, schemaFile: rec.role === 'reviewer' ? join(pluginRoot, 'templates', 'review.schema.json') : undefined, model: rec.model ?? undefined });
  const began = Date.now();
  const child = start(argv[0], argv.slice(1), { unit: 'providers', cwd, env: { ...io.env, ...got.env }, detached: true, stdin: 'pipe' });
  child.stdin.on('error', () => {});
  child.stdin.end(brief);
  let live = { tokens: null, lastLine: null, unknownEvents: 0, lines: [] };
  let dirty = false;
  // Each line is cleaned and redacted before the adapter, the record or the log sees it (B-1, SF-AB-6, SF-AB-8); a
  // line that still cannot be handled counts as unknown, never throws out of a stream callback.
  const onLine = (raw) => {
    try {
      const line = safeLine(raw, PENDING_MAX, extra);
      if (!line) return;
      const parsed = adapter.parse(line) ?? {};
      if (parsed.tokens) live.tokens = parsed.tokens;
      if (parsed.lastLine) live.lastLine = safeLine(parsed.lastLine, LAST_LINE, extra) || live.lastLine;
      if (!Object.keys(parsed).length) live.unknownEvents += 1;
      live.lines.push(safeLine(line, LOG_LINE, extra));
      if (live.lines.length > LOG_LINES) live.lines = live.lines.slice(-LOG_LINES);
    } catch {
      live.unknownEvents += 1;
    }
    dirty = true;
  };
  const streams = { out: lineSplitter(onLine), err: lineSplitter(onLine) };
  // flush catches its own errors: a failed write is tried again at the next flush, never a dead supervisor.
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    try {
      patch((cur) => ({ ...cur, elapsedMs: Date.now() - began, tokens: live.tokens, lastLine: live.lastLine, unknownEvents: live.unknownEvents }));
      store.write('runLog', runId, { runId, lines: live.lines });
    } catch {
      dirty = true;
    }
  };
  const timer = setInterval(flush, FLUSH_MS);
  try {
    patch((cur) => ({ ...cur, status: 'running', startedAt: new Date().toISOString(), lease: `external-${got.lease.slot}`, lastLine: null }));
    const abort = new AbortController();
    const onStop = () => abort.abort();
    process.once('SIGTERM', onStop);
    process.once('SIGINT', onStop);
    const done = supervise(child, { timeoutMs: rec.capS * 1000, idleMs: rec.capS * 1000, graceMs: GRACE_MS, out: (d) => streams.out.feed(d), err: (d) => streams.err.feed(d), signal: abort.signal });
    if (Number.isInteger(child.pid)) attachChild(got.lease, child.pid, opts);
    const result = await done.finally(() => { process.off('SIGTERM', onStop); process.off('SIGINT', onStop); });
    streams.out.end();
    streams.err.end();
    clearInterval(timer);
    flush();
    const status = result.ended === 'aborted' ? 'stopped' : result.ended === 'timeout' || result.ended === 'idle' ? 'timeout' : result.status === 0 ? 'done' : 'failed';
    const error = result.error ? `could not start: ${result.error}` : status === 'failed' ? (result.signal ? `ended by ${result.signal}` : `exited with ${result.status}`) : status === 'timeout' ? `wall cap ${rec.capS} s reached; the process group was stopped` : status === 'stopped' ? 'stopped by runs stop' : null;
    patch((cur) => ({ ...cur, status, exit: result.status, endedAt: new Date().toISOString(), elapsedMs: Date.now() - began, tokensReason: cur.tokens ? null : 'not reported', error }));
    return { data: { runId, status, exit: result.status } };
  } catch (err) {
    // Any supervisor failure ends the run as failed: the group is killed here, the lease released below.
    try { if (Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
    try {
      patch((cur) => ({ ...cur, status: 'failed', endedAt: new Date().toISOString(), elapsedMs: Date.now() - began, error: safeLine(`supervisor failed: ${err?.message ?? err}`, 300, extra) || 'supervisor failed' }));
    } catch { /* the record cannot be written; the lease is still released */ }
    return fail('supervisor-failed', `${runId}: the supervisor failed`, 'start the run again with exec');
  } finally {
    clearInterval(timer);
    release(got.lease, opts); // supervise resolved: the group is gone or got SIGKILL
  }
}
