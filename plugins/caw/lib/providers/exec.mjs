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
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { start } from '../proc/index.mjs';
import { capFor, liveRun, nextRunId, runsStore, LOG_LINE, LOG_LINES } from '../runs/index.mjs';
import { SYSTEM, acquireWait, attachChild, identify, release, supervise } from '../sched/index.mjs';
import { KINDS, TASK_TEXTS, resolve } from '../state/index.mjs';
import { adapters, chooseProvider, detectProviders } from './index.mjs';
import { LAST_LINE, ROLES } from './kind.mjs';

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
  const id = flags.task;
  KINDS.task.path(id); // a malformed ID is a usage error (invalid-key)
  const r = where(io, names);
  if (r.refused) return r.refused;
  const { w, store } = r;
  const task = store.read('task', id);
  if (!task) return fail('task-unknown', `no task ${id} in ${w.dir}`, `'${bin} task list' lists the tasks`);
  const briefFile = join(w.dir, KINDS.task.path(id).replace(/[^/]+$/, TASK_TEXTS.brief));
  let brief;
  try { brief = readFileSync(briefFile, 'utf8'); } catch { brief = null; }
  if (!brief) return fail('brief-missing', `${id} has no saved brief (${briefFile})`, `${bin} brief ${id} --write`);
  const live = liveRun(store, id, role);
  if (live) return fail('run-live', `${live.runId} is ${live.status} for ${id} as ${role}`, 'wait for it to end');
  const row = chooseProvider({ role, rows: detectProviders({ names, env: io.env }).rows, explicit: flags.provider });
  const adapter = adapters({ names, env: io.env }).find((a) => a.id === row.id);
  const capS = capFor(role, io.env, names.envPrefix);
  const outDir = mkdtempSync(join(tmpdir(), `${bin}-run-`)); // 0700
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

export async function runSupervise({ args, names, io }) {
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
  if (!adapter || !sandbox || !cwd || rec.sandbox !== sandbox || rec.cwd !== cwd || !ownOutFile(rec.outFile)) {
    patch0(store, runId, { status: 'failed', endedAt: new Date().toISOString(), error: 'run-tampered' });
    return fail('run-tampered', `${runId}: the run record does not match its role, the repository or its temp directory`, 'start the run again with exec');
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
  const brief = readFileSync(join(w.dir, KINDS.task.path(rec.task).replace(/[^/]+$/, TASK_TEXTS.brief)), 'utf8');
  const argv = adapter.argv({ sandbox, cwd, outFile: rec.outFile, model: rec.model ?? undefined });
  const began = Date.now();
  const child = start(argv[0], argv.slice(1), { unit: 'providers', cwd, env: { ...io.env, ...got.env }, detached: true, stdin: 'pipe' });
  child.stdin.on('error', () => {});
  child.stdin.end(brief);
  let live = { tokens: null, lastLine: null, unknownEvents: 0, lines: [] };
  let dirty = false;
  let rest = '';
  const onLine = (line) => {
    const parsed = adapter.parse(line) ?? {};
    if (parsed.tokens) live.tokens = parsed.tokens;
    if (parsed.lastLine) live.lastLine = clip(parsed.lastLine, LAST_LINE);
    if (!Object.keys(parsed).length) live.unknownEvents += 1;
    live.lines.push(clip(line, LOG_LINE));
    if (live.lines.length > LOG_LINES) live.lines = live.lines.slice(-LOG_LINES);
    dirty = true;
  };
  const out = (d) => {
    rest += d.toString();
    const parts = rest.split('\n');
    rest = parts.pop();
    for (const line of parts) if (line.trim()) onLine(line);
  };
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    patch((cur) => ({ ...cur, elapsedMs: Date.now() - began, tokens: live.tokens, lastLine: live.lastLine, unknownEvents: live.unknownEvents }));
    store.write('runLog', runId, { runId, lines: live.lines });
  };
  const timer = setInterval(flush, FLUSH_MS);
  try {
    patch((cur) => ({ ...cur, status: 'running', startedAt: new Date().toISOString(), lease: `external-${got.lease.slot}`, lastLine: null }));
    const done = supervise(child, { timeoutMs: rec.capS * 1000, idleMs: rec.capS * 1000, graceMs: GRACE_MS, out, err: out });
    if (Number.isInteger(child.pid)) attachChild(got.lease, child.pid, opts);
    const result = await done;
    if (rest.trim()) onLine(rest);
    clearInterval(timer);
    flush();
    const status = result.ended === 'timeout' || result.ended === 'idle' ? 'timeout' : result.status === 0 ? 'done' : 'failed';
    const error = result.error ? `could not start: ${result.error}` : status === 'failed' ? (result.signal ? `ended by ${result.signal}` : `exited with ${result.status}`) : status === 'timeout' ? `wall cap ${rec.capS} s reached; the process group was stopped` : null;
    patch((cur) => ({ ...cur, status, exit: result.status, endedAt: new Date().toISOString(), elapsedMs: Date.now() - began, tokensReason: cur.tokens ? null : 'not reported', error }));
    return { data: { runId, status, exit: result.status } };
  } finally {
    clearInterval(timer);
    release(got.lease, opts); // supervise resolved: the group is gone or got SIGKILL
  }
}
