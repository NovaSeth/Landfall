// `<bin> exec --task <id> --role <r> [--provider <p>]` and the hidden `<bin> run-supervise <run>` (spec §7.12, §8.5,
// §7.8). exec selects the provider (select.mjs), writes the run record {status: starting} and starts one detached
// supervisor per run (lib/proc start: stdin ignored, pipes closed), then prints {runId}. The supervisor takes the
// `external` lease itself (status queued while waiting), runs the adapter argv through sched.supervise in its own
// process group under the wall cap (SIGTERM, grace, SIGKILL), feeds the brief on stdin, streams stdout through
// adapter.parse into the record (at most once a second) and the log, writes the outcome, and releases the lease only
// after the group is gone. A reviewer runs read-only in the repository checkout; the out file lives in a private temp
// directory (0700). The program is the absolute path exec resolved on the absolute PATH entries and recorded as `bin`;
// the provider's PATH keeps only absolute entries (B-2). The temp directory is bound to the run by its device and inode
// (outDirId) and the out file is out.json in it (SF-AB-10). The review brief is read through the state's lstat walk and
// without following a link, a regular file of at most 64 KiB (SF-AB-1). An implementer (T-MG-64) runs in the task's
// recorded worktree, which must be a linked worktree of this repository, under the adapter's implementer sandbox; its
// brief is the task brief (the same lstat walk) or --brief <file> (a regular file, no link, at most 64 KiB), and the
// record pins the sha256 of what the provider gets (briefSha256), checked again by the supervisor.
// Exit (exec) 0 · 1 no such task, no brief, no task worktree, a live run of the task and role · 2 bad role or provider,
// a provider without the role's sandbox · 7 inactive repository, newer schema · 8 provider missing or logged out.
import { tolerateClosedStreams } from '../cli/output.mjs';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EXIT } from '../cli/commands.mjs';
import { createExclusive, readRegularFile } from '../fsx/index.mjs';
import { start } from '../proc/index.mjs';
import { OUT_NAME, capFor, dirIdOf, liveRun, nextRunId, ownOutDir, runsStore, LOG_LINE, LOG_LINES } from '../runs/index.mjs';
import { SYSTEM, acquireWait, attachChild, identify, release, supervise } from '../sched/index.mjs';
import { KINDS, TASK_TEXTS, checkedPath, resolve, taskTextFile } from '../state/index.mjs';
import { adapters, chooseProvider, detectProviders } from './index.mjs';
import { projectRedactions, redact } from '../verify/redact.mjs';
import { LAST_LINE, ROLES } from './kind.mjs';
import { checkValue } from './generic.mjs';
import { cleanLine, which } from './probe.mjs';

const GRACE_MS = 2000;
const FLUSH_MS = 1000;
const WAIT_MS = 3600e3;
const fail = (code, message, hint) => ({ code: EXIT.FAIL, errors: [{ code, message, hint }] });

// The provider's PATH: only absolute entries, so neither an empty entry nor "." can find a program in the repository.
export const childPath = (path) => String(path ?? '').split(delimiter).filter((d) => isAbsolute(d)).join(delimiter);

// The absolute path of the adapter's program on the absolute entries of PATH (probe which), or null (B-2).
const programOf = (adapter, env) => {
  const name = adapter?.bins?.[0];
  const path = typeof name === 'string' ? which(name, env) : null;
  return path && isAbsolute(path) ? path : null;
};

// A record's model: null, or a plain value (generic checkValue: no bypass or full-access word, no leading "-", 1-40 of
// [A-Za-z0-9._:=/-]) (B-3).
const modelOk = (model) => model === null || checkValue(model) === null;

// The provider's environment (B-6): the base variables (PATH as childPath keeps it), LANG and LC_*, the lease
// variables, and the adapter's own envNames (NAME or a NAME_* prefix); nothing else of the parent passes.
const BASE_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'];
export function childEnv(adapter, parent, lease = {}) {
  const names = (adapter?.envNames ?? []).filter((n) => typeof n === 'string');
  const own = (k) => BASE_ENV.includes(k) || /^LC_[A-Z0-9_]+$/.test(k) || names.some((n) => (n.endsWith('*') ? k.startsWith(n.slice(0, -1)) : k === n));
  const out = {};
  for (const [k, v] of Object.entries(parent ?? {})) if (typeof v === 'string' && k !== 'PATH' && own(k)) out[k] = v;
  if (typeof parent?.PATH === 'string') out.PATH = childPath(parent.PATH);
  for (const [k, v] of Object.entries(lease ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

// A task text exec gives a provider (the review brief; the task brief once implementer runs exist): every component
// from the state directory checked by lstat (no link, no case alias: state checkedPath), then the file opened without
// following a link, a regular file of at most BRIEF_MAX bytes (writeTaskText's own cap) (SF-AB-1). { text } (null when
// absent) or { refused } with the code <what>-unsafe.
const BRIEF_MAX = 65536;
function readBrief(dir, rel, what, bin) {
  try {
    return { text: readRegularFile(checkedPath(dir, rel), { max: BRIEF_MAX }).toString('utf8') };
  } catch (err) {
    if (err?.code === 'ENOENT') return { text: null };
    return { refused: fail(`${what}-unsafe`, `${rel}: ${String(err?.message ?? err).slice(0, 200)}`, `replace it with a plain file: ${bin} ${what === 'review-brief' ? 'review brief' : 'brief'} <id> --write --force`) };
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The task's recorded worktree (the data of its last started event), real path, when it is a linked worktree of this
// repository: git names it as its own top level, its project and state directory are this repository's, and it is not
// the main checkout. null otherwise (implementer-no-worktree).
function taskWorktree(task, w, names, env) {
  const path = [...(Array.isArray(task?.events) ? task.events : [])].reverse().find((e) => e?.event === 'started')?.data?.worktree;
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    const real = realpathSync(path);
    const t = resolve({ cwd: real, env, names });
    return t.worktree === real && t.repo === w.repo && t.dir === w.dir && real !== w.repo ? real : null;
  } catch { return null; }
}

// The implementer's brief: --brief <file> (a regular file, no link, at most BRIEF_MAX bytes) or the task brief.
function implementerBrief(flags, io, w, taskDir, id, bin) {
  if (flags.brief === undefined) {
    const read = readBrief(w.dir, join(taskDir, taskTextFile('brief')), 'task-brief', bin);
    if (read.refused || read.text) return read;
    return { refused: fail('brief-missing', `${id} has no saved task brief`, `${bin} brief ${id} --write, or pass --brief <file>`) };
  }
  const file = resolvePath(io.cwd, String(flags.brief));
  try {
    return { text: readRegularFile(file, { max: BRIEF_MAX }).toString('utf8') };
  } catch (err) {
    if (err?.code === 'ENOENT') return { refused: fail('brief-missing', `${String(flags.brief).slice(0, 200)}: no such file`, 'pass the path of a saved brief') };
    return { refused: fail('brief-unsafe', String(err?.message ?? err).slice(0, 300), `pass a plain file of at most ${BRIEF_MAX} bytes, not a link`) };
  }
}

const roleUnavailable = (provider, role) => ({ code: EXIT.USAGE, errors: [{ code: 'role-unavailable', message: `${provider}: no ${role} sandbox is declared`, hint: role === 'implementer' ? `declare one: providers add ${provider} --sandbox-map reviewer=…,implementer=… (codex workspace-write, gemini auto_edit)` : 'pick another provider' }] });

function where(io, names) {
  const w = resolve({ cwd: io.cwd, env: io.env, names });
  if (!w.active) return { refused: { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${w.repo} is not active`, hint: `'${names.bin} init' activates it` }] } };
  return { w, store: runsStore(w.dir, names) };
}

export function exec({ flags, names, io, pluginRoot }) {
  const { bin } = names;
  const role = flags.role;
  if (!ROLES.includes(role)) return { code: EXIT.USAGE, errors: [{ code: 'invalid-value', message: `--role ${String(role ?? '').slice(0, 40)}: expected ${ROLES.join(' or ')}`, hint: `${bin} exec --task <id> --role reviewer` }] };
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
  let brief;
  let wt = null;
  if (role === 'implementer') {
    wt = taskWorktree(task, w, names, io.env);
    if (!wt) return fail('implementer-no-worktree', `${id} has no recorded worktree that is a linked worktree of ${w.repo}`, `${bin} task start ${id} records one`);
    const read = implementerBrief(flags, io, w, taskDir, id, bin);
    if (read.refused) return read.refused;
    brief = read.text;
  } else {
    const got = reviewBrief(asked, store, w, taskDir, id, bin);
    if (got.refused) return got.refused;
    brief = got.text;
  }
  const live = liveRun(store, id, role);
  if (live) return fail('run-live', `${live.runId} is ${live.status} for ${id} as ${role}`, 'wait for it to end');
  if (role === 'implementer' && flags.provider !== undefined) {
    const named = adapters({ names, env: io.env }).find((a) => a.id === flags.provider);
    if (named && !named.sandboxes?.[role]) return roleUnavailable(named.id, role);
  }
  const row = chooseProvider({ role, rows: detectProviders({ names, env: io.env }).rows, explicit: flags.provider });
  const adapter = adapters({ names, env: io.env }).find((a) => a.id === row.id);
  // The detection cache can list a role the adapter no longer maps (providers.json edited by hand): no run without one.
  if (typeof adapter?.sandboxes?.[role] !== 'string') return { code: EXIT.ENV, errors: [{ code: 'role-unavailable', message: `${row.id} has no sandbox mapping for the ${role} role`, hint: `${bin} providers --refresh` }] };
  const program = programOf(adapter, io.env);
  if (!program) return { code: EXIT.ENV, errors: [{ code: 'provider-missing', message: `${row.id}: ${String(adapter?.bins?.[0] ?? '?').slice(0, 80)} is not an executable file in an absolute PATH directory`, hint: 'install it in a directory on PATH (an absolute entry), or pick another provider' }] };
  const capS = capFor(role, io.env, names.envPrefix);
  const outDir = mkdtempSync(join(tmpdir(), `${bin}-run-`)); // 0700
  const dirSt = lstatSync(outDir, { bigint: true });
  const input = role === 'implementer'
    ? `${brief}\n## External run\nYou run as ${row.id}:implementer with the task's worktree ${wt} as your working directory, in the ${adapter.sandboxes.implementer} sandbox: change files only inside it. The orchestrator reviews and commits the result.\n`
    : `${brief}\n## External run (overrides the Output section above)\nYou run as ${row.id}:reviewer in a read-only sandbox: write no file. Your final message is the review JSON object alone, with "reviewer": {"kind": "external", "id": "${row.id}:reviewer"}, per the schema the Output section names. The orchestrator records it from the run's out file with \`${bin} review record ${id} --kind external --run <run ID>\`.\n`;
  const briefFile = join(outDir, 'brief.md');
  if (!createExclusive(briefFile, input, { mode: 0o600 })) throw Object.assign(new Error(`${briefFile}: file already exists`), { code: 'EEXIST' });
  const runId = nextRunId(store, row.id, id, role);
  const record = {
    runId, task: id, role, provider: row.id, adapterVersion: row.version ?? null, model: null, sandbox: adapter.sandboxes[role], cwd: wt ?? w.repo,
    pid: null, pidStart: null, pidMethod: null, lease: null, status: 'starting', queuedAt: new Date().toISOString(), startedAt: null, endedAt: null,
    elapsedMs: 0, capS, tokens: null, tokensReason: null, costMicroUsd: null, lastLine: null, unknownEvents: 0, outFile: join(outDir, OUT_NAME), exit: null, error: null, bin: program,
    outDirId: dirIdOf(dirSt), ...(role === 'implementer' ? { briefSha256: sha256(input) } : {}),
  };
  store.create('run', runId, record);
  store.create('runLog', runId, { runId, lines: [] });
  const child = start(process.execPath, [join(pluginRoot, 'bin', bin), 'run-supervise', runId, '--yes'], { unit: 'providers', cwd: io.cwd, env: io.env, detached: true, stdin: 'ignore' });
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  return { data: { runId, status: 'starting', provider: row.id, capS }, text: `${runId}: starting (${row.id}, ${role}, cap ${capS} s)\n` };
}

// The reviewer's pinned review brief: the round asked for or the highest stored one.
function reviewBrief(asked, store, w, taskDir, id, bin) {
  const pattern = new RegExp(`^${TASK_TEXTS['review-brief'].replace('.', '\\.').replace('<k>', '([1-9][0-9]{0,2})')}$`);
  let round;
  try {
    round = asked ?? Math.max(0, ...store.entries(taskDir).map((file) => Number(pattern.exec(file)?.[1] ?? 0)));
  } catch (err) {
    return { refused: fail('review-brief-unsafe', String(err?.message ?? err).slice(0, 300), `replace it with a plain file: ${bin} review brief ${id} --write --force`) };
  }
  const read = round ? readBrief(w.dir, join(taskDir, taskTextFile('review-brief', { round })), 'review-brief', bin) : { text: null };
  if (read.refused) return read;
  if (!read.text) return { refused: fail('review-brief-missing', `${id} has no saved review brief${asked === undefined ? '' : ` for round ${asked}`}`, `${bin} review brief ${id} --write`) };
  return read;
}

const patch0 = (store, runId, fields) => store.update('run', runId, (cur) => (cur ? { ...cur, ...fields } : undefined));

// The run's out file: the bound out directory (lib/runs ownOutDir, the check review record --run makes too, SF-AB-10)
// and the out file absent or one plain file (no link, no second name). Anything else: the record was rewritten.
function ownOutFile(rec) {
  try {
    if (!ownOutDir(rec)) return false;
    const out = lstatSync(rec.outFile, { throwIfNoEntry: false, bigint: true });
    return !out || (out.isFile() && out.nlink === 1n);
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
  // An implementer's cwd is the task's worktree, checked again (a linked worktree of this repository).
  const cwd = rec.role === 'reviewer' ? w.repo : rec.role === 'implementer' ? taskWorktree(store.read('task', rec.task), w, names, io.env) ?? undefined : undefined;
  // An implementer's pinned brief is the one whose sha256 exec recorded.
  const briefOk = (text) => text !== null && (rec.role !== 'implementer' || (typeof rec.briefSha256 === 'string' && sha256(text) === rec.briefSha256));
  const tampered = () => {
    patch0(store, runId, { status: 'failed', endedAt: new Date().toISOString(), error: 'run-tampered' });
    return fail('run-tampered', `${runId}: the run record or pinned brief does not match its role, the repository, its temp directory or the provider program, or its model is not a plain value`, 'start the run again with exec');
  };
  // The program is the recorded absolute path, still what PATH resolves the adapter's program to; a record without it
  // (2.4.1) is refused too (B-2). The model is null or a plain value (B-3).
  const binOk = () => typeof rec.bin === 'string' && programOf(adapter, io.env) === rec.bin;
  if (!adapter || !sandbox || !cwd || rec.sandbox !== sandbox || rec.cwd !== cwd || !binOk() || !modelOk(rec.model) || !ownOutFile(rec) || !briefOk(pinnedBrief(rec.outFile))) return tampered();
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
  // Checked again after the wait; the adapter's argv must start with its program, which runs by the recorded path.
  const pinned = ownOutFile(rec) && binOk() ? pinnedBrief(rec.outFile) : null;
  const brief = briefOk(pinned) ? pinned : null;
  const argv = brief === null ? [] : adapter.argv({ sandbox, cwd, outFile: rec.outFile, schemaFile: rec.role === 'reviewer' ? join(pluginRoot, 'templates', 'review.schema.json') : undefined, model: rec.model ?? undefined });
  if (brief === null || argv[0] !== adapter.bins[0]) {
    release(got.lease, opts);
    return tampered();
  }
  const began = Date.now();
  const child = start(rec.bin, argv.slice(1), { unit: 'providers', cwd, env: childEnv(adapter, io.env, got.env), detached: true, stdin: 'pipe' });
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
