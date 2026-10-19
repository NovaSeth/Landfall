// Leases (spec §7.8, §7.8a, §5.3, SD-19): machine-wide slots per kind in ${CLAUDE_PLUGIN_DATA}/leases/<kind>-<slot>.json,
// created exclusively. One acquire is one section of the scheduler lock: reap, then check capacity and admission,
// then create the lease (the check and its write never split). A lease carries the port block [41000 + 10·k, +9]
// and the test-DB name <codename>_<repoHash6>_<k>, with k fixed per (kind, slot), so blocks never overlap.
// A process holder or child is judged by its identity (machine.mjs: pid, start, method; never the pid alone): gone
// or its pid reused → the holder is gone; unknown (the process table unreadable, or read another way) is never dead:
// nothing is reaped or signalled on it, only the TTL frees such a lease. Reaping a stale lease of a gone holder first
// ends the process group of the child it recorded (its members by group id and start, also after the child itself
// exited), checked again right before each signal: the orphan supervisor of §7.8a.
// Exclusive kinds (heavy, e2e) take a FIFO ticket in <kind>-queue/, one per worktree: only the tickets at the head,
// as many as there are free slots, may take a slot (in any order among them: findings r1 9, by design), so no waiter
// behind them overtakes. A ticket records its deadline; past it any caller removes the ticket, whatever its owner
// (findings r1 8).
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createExclusive, makeDirs, removeTree, sweepTemps, writeAtomic } from '../fsx/index.mjs';
import { topLevel } from '../git/index.mjs';
import { StateError } from '../state/index.mjs';
import { admissionReasons, rateLimitReasons } from './admission.mjs';
import { ensureCalibration } from './calibration.mjs';
import { dataDirOf, entries, locked, readDoc, toText } from './files.mjs';
import { DEFAULTS, FIFO_KINDS, KIND_NAMES, LEASE, MAX_SLOTS, TASK, TICKET, blockOf, portsOf } from './kinds.mjs';
import { SYSTEM, groupMembers, identify, identityIn, judge, readings, recordOf } from './machine.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(pause, 0, 0, ms);
const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const leaseFile = (dir, kind, slot) => join(dir, LEASE.path(`${kind}-${slot}`));
const ticketKey = (kind, worktree) => `${kind}-queue/${sha(worktree).slice(0, 16)}`;
const ticketFile = (dir, key) => join(dir, TICKET.path(key));
const REAP_GRACE_MS = 1000;
const WITHDRAW_MS = 60e3;
// Whether a ticket recorded for `rec` is this holder's: the same pid, unless both starts are known and differ (one pid
// never names two live processes, so a recorded owner with this pid is this process or gone).
const mine = (rec, me) => rec.pid === me.pid && !(rec.start !== null && me.start !== null && rec.method === me.method && rec.start !== me.start);
const isGone = (verdict) => verdict === 'gone' || verdict === 'other';

// This process as a holder; kept once known (a reading through an injected system is never kept).
let own = null;
function self(system) {
  if (system !== SYSTEM) return recordOf(identify([process.pid], system).get(process.pid));
  if (!own?.start) own = recordOf(identify([process.pid], system).get(process.pid));
  return own;
}

function checkKind(kind) {
  if (!KIND_NAMES.includes(kind)) throw usage('invalid-value', `unknown lease kind: ${kind}`, `kinds: ${KIND_NAMES.join(', ')}`);
}
function checkTask(task) {
  if (task === undefined || task === null) return null;
  if (typeof task !== 'string' || !TASK.test(task)) throw usage('invalid-value', `task ${JSON.stringify(task).slice(0, 90)}: expected 1-80 letters, digits or . _ : -`, 'such as T-AB-1');
  return task;
}
// A process holder { pid, start, method } (default: this process; a bare { pid } is identified now) or, for agent
// leases, a session holder { sessionId, key }.
function holderOf(kind, owner, system) {
  if (owner === undefined) return self(system);
  if (Number.isInteger(owner?.pid) && owner.start === undefined) return recordOf(identify([owner.pid], system).get(owner.pid));
  if (Number.isInteger(owner?.pid)) return { pid: owner.pid, start: owner.start ?? null, method: owner.method ?? null };
  if (kind === 'agent' && typeof owner?.sessionId === 'string' && typeof owner?.key === 'string') return { sessionId: owner.sessionId, key: owner.key, agentId: owner.agentId ?? null };
  throw usage('invalid-value', `a ${kind} lease needs a process holder { pid }${kind === 'agent' ? ' or a session holder { sessionId, key }' : ''}`);
}
// The repository (git top level) of cwd as a real path; cwd itself outside a repository.
function projectOf(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw usage('invalid-value', 'pass the working directory (cwd) as an absolute path');
  let top = null;
  try { top = topLevel(cwd); } catch { /* outside git */ }
  try {
    return realpathSync.native(top ?? cwd);
  } catch {
    throw usage('not-found', `${cwd} does not exist`);
  }
}
const holderShapeOk = (o) => (o.pid !== undefined
  ? o.start !== undefined && o.method !== undefined && o.sessionId === undefined && o.key === undefined && o.agentId === undefined
  : o.sessionId !== undefined && o.key !== undefined && o.agentId !== undefined && o.start === undefined && o.method === undefined);

// live · stale (findings r1 5): a known holder that runs holds its lease whatever the clock says; the TTL frees only an
// agent lease (heartbeat) and a lease whose holder, or whose gone holder's child group, stayed unknown past it (no
// signal). A gone holder's lease is stale, and orphan while verified members of its recorded child's group run.
function leaseStatus(l, ids, table, now) {
  const { owner, child } = l.doc;
  const expired = now - Date.parse(l.doc.heartbeatAt) > l.doc.ttlS * 1000;
  if (owner.pid === undefined) return expired ? 'stale' : 'live'; // an agent: heartbeat and TTL
  const holder = judge(owner, ids.get(owner.pid));
  if (holder === 'same') return 'live';
  if (holder === 'unknown') return expired ? 'stale' : 'live';
  if (!child) return 'stale';
  const members = groupMembers(child, table);
  if (members === null) return expired ? 'stale' : 'live';
  l.orphan = members.length > 0;
  return 'stale';
}

// Every lease and ticket with its status: live · stale (gone holder or TTL) · invalid · newer (never touched).
function scan(dir, now, system) {
  const leases = [];
  for (const name of entries(join(dir, 'leases'))) {
    const key = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!LEASE.keyPattern.test(key)) continue;
    const [kind, slot] = key.split('-');
    const found = readDoc(LEASE, join(dir, 'leases', name));
    if (found.missing) continue;
    if (found.doc && !found.newer && (found.doc.kind !== kind || found.doc.slot !== Number(slot) || !holderShapeOk(found.doc.owner))) found.invalid = 'kind, slot or holder do not match the file';
    leases.push({ key, kind, slot: Number(slot), file: join(dir, 'leases', name), ...found });
  }
  const tickets = [];
  for (const kind of FIFO_KINDS) {
    for (const name of entries(join(dir, `${kind}-queue`))) {
      const key = name.endsWith('.json') ? `${kind}-queue/${name.slice(0, -5)}` : '';
      if (!TICKET.keyPattern.test(key)) continue;
      const found = readDoc(TICKET, ticketFile(dir, key));
      if (found.missing) continue;
      if (found.doc && !found.newer && found.doc.kind !== kind) found.invalid = 'kind does not match the queue';
      tickets.push({ key, kind, file: ticketFile(dir, key), ...found });
    }
  }
  const valid = (x) => x.doc && !x.newer && !x.invalid;
  const pids = [...new Set([
    ...leases.filter(valid).map((l) => l.doc.owner.pid),
    ...tickets.filter(valid).map((t) => t.doc.owner.pid),
  ].filter(Number.isInteger))];
  const table = pids.length ? system.table() : null; // one reading of the process table
  const ids = new Map(pids.map((pid) => [pid, identityIn(table, pid, system.alive)]));
  for (const l of leases) l.status = l.newer ? 'newer' : l.invalid ? 'invalid' : leaseStatus(l, ids, table, now);
  const ticketGone = (t) => now > Date.parse(t.doc.deadline) || isGone(judge(t.doc.owner, ids.get(t.doc.owner.pid)));
  for (const t of tickets) t.status = t.newer ? 'newer' : t.invalid ? 'invalid' : ticketGone(t) ? 'stale' : 'live';
  return { leases, tickets };
}

// Ends the process group of an orphan: SIGTERM, up to REAP_GRACE_MS for it to go, then SIGKILL. Each signal only
// while members of the group are verified right before it (none left, the id reused or unknown: no signal).
function endGroup(child, system) {
  const verified = () => (groupMembers(child, system.table()) ?? []).length > 0;
  const signal = (sig) => { try { system.kill(-child.pid, sig); } catch { /* the group is gone */ } };
  if (!verified()) return;
  signal('SIGTERM');
  for (const until = Date.now() + REAP_GRACE_MS; Date.now() < until;) {
    sleep(100);
    if (!verified()) return;
  }
  if (verified()) signal('SIGKILL');
}

function reap(dir, state, system) {
  for (const l of state.leases.filter((x) => x.status === 'stale' || x.status === 'invalid')) {
    if (l.orphan) endGroup(l.doc.child, system);
    removeTree(l.file);
  }
  for (const t of state.tickets.filter((x) => x.status === 'stale' || x.status === 'invalid')) removeTree(t.file);
  sweepTemps(join(dir, 'leases'));
  for (const kind of FIFO_KINDS) sweepTemps(join(dir, `${kind}-queue`));
  state.leases = state.leases.filter((x) => x.status === 'live' || x.status === 'newer');
  state.tickets = state.tickets.filter((x) => x.status === 'live' || x.status === 'newer');
}

const queueOf = (state, kind) => state.tickets.filter((t) => t.kind === kind && t.status === 'live').sort((a, b) => a.doc.seq - b.doc.seq);

// The ticket of this worktree (created when absent) and its place in the queue.
function enqueue(dir, state, { kind, worktree, holder, task, now, deadline }) {
  const key = ticketKey(kind, worktree);
  const found = state.tickets.find((t) => t.key === key);
  if (found && (found.newer || !mine(found.doc.owner, holder))) {
    throw new StateError('already-queued', 'FAIL', `${worktree} already has an entry in the ${kind} queue${found.doc?.owner?.pid ? ` (pid ${found.doc.owner.pid})` : ''}`, { hint: 'one entry per worktree: wait for that run to finish' });
  }
  if (!found) {
    const seq = Math.max(now, ...state.tickets.filter((t) => t.kind === kind && t.doc && !t.newer).map((t) => t.doc.seq + 1));
    const doc = { schema: TICKET.version, kind, seq, worktree, owner: holder, task, at: iso(now), deadline: iso(deadline) };
    makeDirs(join(dir, `${kind}-queue`));
    if (!createExclusive(ticketFile(dir, key), toText(TICKET, doc))) throw new StateError('already-queued', 'FAIL', `${worktree} already has an entry in the ${kind} queue`);
    state.tickets.push({ key, kind, file: ticketFile(dir, key), doc, status: 'live' });
  }
  const queue = queueOf(state, kind);
  const position = queue.findIndex((t) => t.key === key);
  return { key, seq: queue[position].doc.seq, position };
}

const dbName = (names, project, kind, slot) => `${names.codename.replace(/-/g, '_')}_${sha(project).slice(0, 6)}_${blockOf(kind, slot)}`;

// Env injected into runs and briefs (spec §7.8): <PREFIX>PORT_BASE, PORT_MAX, DB_NAME, SLOT.
export function leaseEnv(lease, names) {
  const p = names.envPrefix;
  return { [`${p}PORT_BASE`]: String(lease.ports[0]), [`${p}PORT_MAX`]: String(lease.ports[1]), [`${p}DB_NAME`]: lease.db, [`${p}SLOT`]: `${lease.kind}-${lease.slot}` };
}

function create(dir, state, { kind, holder, project, task, ttlS, names, now }) {
  const used = new Set(state.leases.filter((l) => l.kind === kind).map((l) => l.slot));
  makeDirs(join(dir, 'leases'));
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    if (used.has(slot)) continue;
    const doc = {
      schema: LEASE.version, id: randomBytes(8).toString('hex'), kind, slot, owner: holder, project, task,
      ports: portsOf(kind, slot), db: dbName(names, project, kind, slot), at: iso(now), heartbeatAt: iso(now), ttlS, child: null,
    };
    if (createExclusive(leaseFile(dir, kind, slot), toText(LEASE, doc))) return doc;
  }
  throw new StateError('no-free-slot', 'INTERNAL', `no free ${kind} slot file although the count allows one`);
}

// One attempt. opts: { names, env, cwd, task, owner, mode ('shadow' default | 'on'), ttlS, readings (an object, or a
// function read once per attempt), transcriptPath, lockTimeoutMs, deadline (ms, of a ticket: default now +
// DEFAULTS.ticketS), system (machine.mjs SYSTEM, injected by tests) }. Result: { ok: true, lease, env, shadow:
// [admission reasons not enforced] } or { ok: false, reasons: [{ code, message }], position, seq } (exclusive kinds keep
// their ticket until dequeue or its deadline).
export function acquire(kind, opts = {}) {
  checkKind(kind);
  const dir = dataDirOf(opts);
  const mode = opts.mode ?? 'shadow';
  if (mode !== 'shadow' && mode !== 'on') throw usage('invalid-value', `admission mode ${mode}: expected shadow or on`);
  const task = checkTask(opts.task);
  const system = opts.system ?? SYSTEM;
  const holder = holderOf(kind, opts.owner, system);
  if (FIFO_KINDS.includes(kind) && holder.pid === undefined) throw usage('invalid-value', `a ${kind} lease needs a process holder`);
  const ttlS = opts.ttlS ?? DEFAULTS.ttlS[kind];
  const deadline = opts.deadline ?? Date.now() + DEFAULTS.ticketS * 1000;
  if (!Number.isFinite(deadline)) throw usage('invalid-value', `deadline ${deadline}: expected a time in ms`);
  const project = projectOf(opts.cwd);
  const r = typeof opts.readings === 'function' ? opts.readings() : opts.readings ?? readings();
  const quota = opts.transcriptPath ? rateLimitReasons(opts.transcriptPath) : [];
  return locked(dir, () => {
    const cal = ensureCalibration(dir, r);
    const now = Date.now();
    const state = scan(dir, now, system);
    reap(dir, state, system);
    const held = state.leases.filter((l) => l.kind === kind).length;
    const max = cal.max[kind];
    const capacity = [];
    let ticket = null;
    if (FIFO_KINDS.includes(kind)) {
      ticket = enqueue(dir, state, { kind, worktree: project, holder, task, now, deadline });
      if (ticket.position >= max - held) capacity.push({ code: 'queued', message: `${kind} ${held}/${max} in use, ${ticket.position} ahead in the queue` });
    } else if (held >= max) {
      capacity.push({ code: 'capacity', message: `${kind} ${held}/${max} in use` });
    }
    const admission = [...admissionReasons(r, cal), ...quota];
    if (capacity.length || (mode === 'on' && admission.length)) return { ok: false, reasons: [...capacity, ...admission], position: ticket?.position ?? null, seq: ticket?.seq ?? null };
    const lease = create(dir, state, { kind, holder, project, task, ttlS, names: opts.names, now });
    if (ticket) removeTree(ticketFile(dir, ticket.key));
    return { ok: true, lease, env: leaseEnv(lease, opts.names), shadow: mode === 'on' ? [] : admission };
  }, { timeoutMs: opts.lockTimeoutMs, names: opts.names });
}

// Removes this process's ticket of the worktree at cwd from the queue of an exclusive kind; true when removed.
export function dequeue(kind, opts = {}) {
  if (!FIFO_KINDS.includes(kind)) throw usage('invalid-value', `${kind} has no queue`);
  const dir = dataDirOf(opts);
  const holder = holderOf(kind, opts.owner, opts.system ?? SYSTEM);
  const file = ticketFile(dir, ticketKey(kind, projectOf(opts.cwd)));
  return locked(dir, () => {
    const found = readDoc(TICKET, file);
    if (!found.doc || found.newer || !mine(found.doc.owner, holder)) return false;
    removeTree(file);
    return true;
  }, { timeoutMs: opts.lockTimeoutMs, names: opts.names });
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); });

// Withdraws this process's ticket, retried while another call holds the lock (up to WITHDRAW_MS); a ticket still left
// is past its deadline, so the next caller removes it.
async function withdraw(kind, opts, pollMs) {
  for (const until = Date.now() + WITHDRAW_MS; ;) {
    try {
      dequeue(kind, opts);
      return;
    } catch (err) {
      if (err?.code !== 'scheduler-busy' || err.exit !== 'ENV' || Date.now() >= until) return;
    }
    await wait(pollMs);
  }
}

// Attempts until a lease is granted or timeoutMs passes (then the ticket, whose deadline is that moment, is withdrawn
// and the last reasons end with wait-timeout). onWait(result) is called after each refused attempt.
export async function acquireWait(kind, opts = {}) {
  const { timeoutMs = 590e3, pollMs = 1000, onWait } = opts;
  const until = Date.now() + timeoutMs;
  try {
    for (;;) {
      let r;
      try {
        r = acquire(kind, { ...opts, deadline: until });
      } catch (err) {
        if (err?.code !== 'scheduler-busy' || err.exit !== 'ENV') throw err; // a live holder: retry; a gone one: refused
        r = { ok: false, reasons: [{ code: 'busy', message: err.message }], position: null, seq: null };
      }
      if (r.ok) return r;
      if (Date.now() >= until) {
        if (FIFO_KINDS.includes(kind)) await withdraw(kind, opts, pollMs);
        return { ...r, reasons: [...r.reasons, { code: 'wait-timeout', message: `no ${kind} slot within ${Math.ceil(timeoutMs / 1000)} s` }] };
      }
      onWait?.(r);
      await wait(Math.min(pollMs, until - Date.now()));
    }
  } catch (err) {
    if (FIFO_KINDS.includes(kind) && err?.code !== 'already-queued') await withdraw(kind, opts, pollMs);
    throw err;
  }
}

// Read-modify-write of the leases matching `match` (one section of the lock); true when one was changed.
function update(opts, kinds, match, change) {
  const dir = dataDirOf(opts);
  return locked(dir, () => {
    for (const kind of kinds) {
      for (let slot = 1; slot <= MAX_SLOTS; slot++) {
        const file = leaseFile(dir, kind, slot);
        const found = readDoc(LEASE, file);
        if (!found.doc || found.newer || !match(found.doc)) continue;
        const next = change(found.doc); // null: remove · undefined: keep as it is · a document: write it
        if (next === null) removeTree(file);
        else if (next !== undefined) writeAtomic(file, toText(LEASE, next));
        return true;
      }
    }
    return false;
  }, { timeoutMs: opts.lockTimeoutMs, names: opts.names });
}

// Releases the lease if the file still holds it (same id); true when removed.
export const release = (lease, opts = {}) => update(opts, [lease.kind], (d) => d.id === lease.id && d.slot === lease.slot, () => null);

// Records the child process the holder runs under the lease, with its identity, for the orphan reaper.
export function attachChild(lease, pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw usage('invalid-value', `pid ${pid}: expected a positive integer`);
  const child = recordOf(identify([pid], opts.system ?? SYSTEM).get(pid));
  return update(opts, [lease.kind], (d) => d.id === lease.id, (d) => ({ ...d, child }));
}

// Agent leases (spec §7.8 admission points): PostToolUse binds the agentId to the lease keyed by tool_use_id;
// hooks carrying that agent_id refresh its heartbeat (at most once a minute); SubagentStop releases it.
export const bindAgent = ({ key, agentId }, opts = {}) => update(opts, ['agent'], (d) => d.owner.key === key, (d) => ({ ...d, owner: { ...d.owner, agentId } }));
export const heartbeatAgent = (agentId, opts = {}) => update(opts, ['agent'], (d) => d.owner.agentId === agentId,
  (d) => (Date.now() - Date.parse(d.heartbeatAt) < (opts.minIntervalMs ?? 60e3) ? undefined : { ...d, heartbeatAt: iso(Date.now()) }));
export const releaseAgent = (agentId, opts = {}) => update(opts, ['agent'], (d) => d.owner.agentId === agentId, () => null);

// Read-only view for `slots`: { leases, queues, used, queued }. Nothing is reaped or written.
export function snapshot(opts = {}) {
  const state = scan(dataDirOf(opts), Date.now(), opts.system ?? SYSTEM);
  const leases = state.leases.map((l) => (l.doc && !l.newer && !l.invalid
    ? { ...l.doc, schema: undefined, status: l.status, orphan: Boolean(l.orphan) }
    : { kind: l.kind, slot: l.slot, status: l.status }));
  const queues = Object.fromEntries(FIFO_KINDS.map((kind) => {
    const live = queueOf(state, kind);
    const all = state.tickets.filter((t) => t.kind === kind && t.doc && !t.newer && !t.invalid).sort((a, b) => a.doc.seq - b.doc.seq);
    return [kind, all.map((t) => ({ ...t.doc, schema: undefined, status: t.status, position: t.status === 'live' ? live.indexOf(t) : null }))];
  }));
  const count = (list, kind) => list.filter((x) => x.kind === kind && (x.status === 'live' || x.status === 'newer')).length;
  return { leases, queues, used: (kind) => count(state.leases, kind), queued: (kind) => count(state.tickets, kind) };
}
