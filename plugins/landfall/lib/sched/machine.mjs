// Machine readings (spec §7.8, U12): cores, RAM, available memory, load and process identities. Reads only.
// Available memory (U12): os.freemem() under-reports reclaimable pages on macOS, so the larger of it and the
// platform reading counts: vm_stat (free + inactive + speculative pages) on darwin, MemAvailable on linux.
// Process identity (lesson I2.1, findings r1 3, 4): { pid, start, method }. start comes from one reading of the process
// table: 'proc' (where /proc exists): clock ticks since boot, field 22 of /proc/<pid>/stat; 'ps' elsewhere: epoch
// seconds of `ps -o lstart` read in UTC. Starts compare only within one method. A reading that fails, a pid that
// kill(0) finds but the table lacks, or an unreadable start is unknown, and unknown is never dead: the scheduler never
// reaps or signals on it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { isAlive } from '../fsx/index.mjs';
import { run } from '../proc/index.mjs';

const toolEnv = () => ({ PATH: `${process.env.PATH ? `${process.env.PATH}:` : ''}/bin:/usr/bin`, LC_ALL: 'C', TZ: 'UTC' });

export const cores = () => Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

// Bytes available from vm_stat text; null when the page size or the free/inactive counts are missing.
export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(String(text));
  const pages = (name) => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(String(text));
    return m ? Number(m[1]) : null;
  };
  const free = pages('free');
  const inactive = pages('inactive');
  if (!size || free === null || inactive === null) return null;
  return (free + inactive + (pages('speculative') ?? 0)) * Number(size[1]);
}

// Bytes of MemAvailable from /proc/meminfo text; null when absent.
export function parseMeminfo(text) {
  const m = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(String(text));
  return m ? Number(m[1]) * 1024 : null;
}

// U12: the larger of os.freemem() and the platform reading, never above RAM.
export const availableBytes = (freemem, platformBytes, totalBytes) => Math.min(totalBytes, Math.max(freemem, platformBytes ?? 0));

function platformMemory() {
  if (process.platform === 'darwin') {
    const r = run('vm_stat', [], { unit: 'sched', env: toolEnv(), timeoutMs: 5000 });
    return { bytes: r.error === null && r.status === 0 ? parseVmStat(r.stdout) : null, method: 'vm_stat' };
  }
  if (process.platform === 'linux') {
    try {
      return { bytes: parseMeminfo(readFileSync('/proc/meminfo', 'utf8')), method: 'meminfo' };
    } catch {
      return { bytes: null, method: 'meminfo' };
    }
  }
  return { bytes: null, method: 'freemem' };
}

export const freePct = (r) => Math.floor((r.availBytes * 100) / r.totalBytes);

// { cores, load1 (null when unmeasurable), loadMeasurable, totalBytes, availBytes, freePct, memMethod }.
export function readings() {
  const totalBytes = os.totalmem();
  const mem = platformMemory();
  const load = os.loadavg();
  const loadMeasurable = process.platform !== 'win32' && Number.isFinite(load[0]);
  const r = {
    cores: cores(),
    load1: loadMeasurable ? Math.round(load[0] * 10) / 10 : null,
    loadMeasurable,
    totalBytes,
    availBytes: availableBytes(os.freemem(), mem.bytes, totalBytes),
    memMethod: mem.bytes === null ? 'freemem' : mem.method,
  };
  return { ...r, freePct: freePct(r) };
}

// The process table: { method, rows: Map pid → { pgid, zombie, start (null when unreadable) } }, or null when it
// cannot be read.
export function processTable() {
  if (existsSync('/proc/self/stat')) return procTable();
  const r = run('ps', ['-A', '-o', 'pid=,pgid=,stat=,lstart='], { unit: 'sched', env: toolEnv(), timeoutMs: 5000 });
  if (r.error !== null || r.status !== 0) return null;
  const rows = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const at = Date.parse(`${m[4].replace(/\s+/g, ' ')} UTC`);
    rows.set(Number(m[1]), { pgid: Number(m[2]), zombie: /^[ZX]/.test(m[3]), start: Number.isFinite(at) ? String(at / 1000) : null });
  }
  return rows.size ? { method: 'ps', rows } : null;
}

function procTable() {
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const rows = new Map();
  for (const name of names.filter((n) => /^\d+$/.test(n))) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // f[0] state (field 3), f[2] pgrp (5), f[19] starttime (22)
      rows.set(Number(name), { pgid: Number(f[2]), zombie: /^[ZX]/.test(f[0]), start: /^\d+$/.test(f[19] ?? '') ? f[19] : null });
    } catch { /* exited meanwhile */ }
  }
  return rows.size ? { method: 'proc', rows } : null;
}

// What the scheduler reads and does to other processes; tests inject their own.
export const SYSTEM = Object.freeze({ table: processTable, alive: isAlive, kill: (pid, sig) => process.kill(pid, sig) });

// The identity of pid in a table: { pid, state: 'running', start, method, pgid } · { pid, state: 'gone' } (kill(0)
// fails, or a zombie) · { pid, state: 'unknown' }.
export function identityIn(table, pid, alive) {
  if (!alive(pid)) return { pid, state: 'gone' };
  const row = table?.rows.get(pid);
  if (row?.zombie) return { pid, state: 'gone' };
  if (!row || row.start === null) return { pid, state: 'unknown' };
  return { pid, state: 'running', start: row.start, method: table.method, pgid: row.pgid };
}

// The identities of pids from one reading of the process table: Map pid → identity.
export function identify(pids, system = SYSTEM) {
  const table = system.table();
  return new Map(pids.map((pid) => [pid, identityIn(table, pid, system.alive)]));
}

// A recorded identity { pid, start, method } against the current one: 'same' · 'other' (the pid names another
// process now) · 'gone' · 'unknown' (either side unreadable, or read by different methods).
export function judge(record, current) {
  if (current.state === 'gone') return 'gone';
  if (current.state !== 'running' || record.start === null || record.method !== current.method) return 'unknown';
  return current.start === record.start ? 'same' : 'other';
}

// Members of the process group led by the recorded child { pid, start, method } (findings r1 7; the group id is the
// child's pid): pids with that group id that started no earlier than the child. [] when the group is gone or its id
// now names another process (a group id is not reused while a member lives); null when it cannot be told (no table,
// another method, a start that cannot be read).
export function groupMembers(child, table) {
  if (!table || child.start === null || child.method !== table.method) return null;
  const leader = table.rows.get(child.pid);
  if (leader && !leader.zombie && leader.start !== child.start) return leader.start === null ? null : [];
  const members = [];
  for (const [pid, row] of table.rows) {
    if (row.pgid !== child.pid || row.zombie) continue;
    if (row.start === null) return null;
    if (Number(row.start) >= Number(child.start)) members.push(pid);
  }
  return members;
}

// The record of an identity as a holder or child: { pid, start, method } (start and method null when unknown).
export const recordOf = (id) => ({ pid: id.pid, start: id.start ?? null, method: id.method ?? null });
