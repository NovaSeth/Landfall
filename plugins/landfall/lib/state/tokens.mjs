// Role capability tokens (SEC-13, spec 2026-11-05): the machine-local kind `token` (local/token.json) holds the sha256 of
// the session's orchestrator token and of each reviewer's one-use token, each bound to the Claude Code process that hosts
// the session ({ pid, start }). Hooks mint and revoke; the CLI authorizes `task set dispatched|self-verified` and
// `review record` by what stdin brings (`--token -`). A token is never stored, logged or printed; every change is one
// locked read-modify-write. Unreadable, corrupt or newer store: `token-store`, refused (fail closed).
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isAlive } from '../fsx/index.mjs';
import { run } from '../proc/index.mjs';
import { identify, identityIn, processTable } from '../sched/machine.mjs';
import { StateError } from './errors.mjs';
import { KINDS, PATTERNS, defineKind } from './kinds.mjs';
import { open } from './store.mjs';

const sha = { t: 'str', max: 64, re: PATTERNS.sha256 };
const entry = { hash: sha, session: { t: 'str', max: 128, re: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ }, at: { t: 'time' }, until: { t: 'time' } };
export const TOKEN_KIND = defineKind('token', 1, {
  dir: 'local', file: () => 'local/token.json', match: /^local\/token\.json$/,
  fields: {
    orchestrator: { t: 'obj', null: true, f: { ...entry, holder: { t: 'obj', f: { pid: { t: 'int', min: 1, max: 2147483647 }, start: { t: 'str', max: 32 } } } } },
    agents: { t: 'arr', max: 64, of: { t: 'obj', f: { ...entry, role: { t: 'enum', of: ['reviewer', 'security-reviewer'] }, agent: { t: 'str', max: 128, re: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ } } } },
  },
});
const DAY = 86400000;
const hashOf = (token) => createHash('sha256').update(token).digest('hex');
const same = (a, b) => a.pid === b.pid && a.start === b.start;
const refused = (code, message, hint = '') => new StateError(code, 'REFUSED', message, { hint });
const open_ = (dir, names, lockTimeoutMs) => open(dir, { names, kinds: { ...KINDS, token: TOKEN_KIND }, lockTimeoutMs });
const empty = { schema: 1, orchestrator: null, agents: [] };
// A holder is alive when its pid runs with the recorded start; a process the table cannot place is not called dead.
const alive = (table, h) => { const i = identityIn(table, h.pid, isAlive); return i.state === 'running' ? i.start === h.start : i.state === 'unknown'; };
// The entries still valid at `now` (an agent entry also needs the live orchestrator of its session).
function prune(doc, now, table) {
  const o = doc.orchestrator && Date.parse(doc.orchestrator.until) > now && alive(table, doc.orchestrator.holder) ? doc.orchestrator : null;
  return { ...doc, orchestrator: o, agents: doc.agents.filter((a) => o && a.session === o.session && Date.parse(a.until) > now) };
}
function read(dir, names, now) {
  try {
    const raw = open_(dir, names).read('token', null);
    return { ...prune(raw ?? empty, now, processTable()), raw };
  } catch (e) {
    throw refused('token-store', `${dir}/local/token.json cannot be read (${e.code ?? 'error'}): a call is refused while the role tokens are unknown`, 'repair or remove local/token.json, or update the plugin when its schema is newer');
  }
}

// { token } minted for `role` ('orchestrator', 'reviewer', 'security-reviewer'), or { none: held | no-orchestrator | full | busy
// | unreadable } (never a throw: the hook says why). host: the holder of the hook's session ({ pid, start }).
export function mint({ dir, names, role, session, agent, host, now = new Date(), lockMs = 300 }) {
  const token = `lf1_${randomBytes(32).toString('base64url')}`;
  const base = { hash: hashOf(token), session, at: now.toISOString() };
  const table = processTable();
  let none = null;
  try {
    open_(dir, names, lockMs).update('token', null, (cur) => {
      const doc = prune(cur ?? empty, now, table);
      if (role === 'orchestrator') {
        if (doc.orchestrator && !same(doc.orchestrator.holder, host)) none = 'held';
        else return { ...doc, orchestrator: { ...base, until: new Date(+now + 7 * DAY).toISOString(), holder: host }, agents: [] };
      } else if (!doc.orchestrator || doc.orchestrator.session !== session || !same(doc.orchestrator.holder, host)) none = 'no-orchestrator';
      else if (doc.agents.filter((a) => a.agent !== agent).length >= 64) none = 'full';
      else return { ...doc, agents: [...doc.agents.filter((a) => a.agent !== agent), { ...base, role, agent, until: new Date(+now + 2 * 3600000).toISOString() }] };
      return doc;
    });
  } catch (e) {
    none = e.code === 'locked' || e.code === 'lock-timeout' ? 'busy' : 'unreadable';
  }
  return none ? { none } : { token };
}

// The live orchestrator entry, or null.
export const live = ({ dir, names, now = new Date() }) => read(dir, names, now).orchestrator;

// A session hook wrote local/session/<id>.json within 24 hours: a missing token store is then not a fresh repository.
const seenSession = (dir, now) => { try { return readdirSync(join(dir, 'local', 'session')).some((f) => +now - statSync(join(dir, 'local', 'session', f)).mtimeMs < DAY); } catch { return false; } };

// What the call may do: { hash, role } for a valid token of the role needed ('orchestrator', or 'reviewer' for either
// reviewer role), { warn: true } for no token while nothing is live. Otherwise REFUSED: token-required (an orchestrator
// is live), token-unknown, token-expired, token-role, token-store.
export function authorize({ dir, names, token, need, now = new Date() }) {
  const doc = read(dir, names, now);
  if (doc.raw === null && seenSession(dir, now)) throw refused('token-store-missing', `${dir}/local/token.json is missing although a session ran here: a call is refused while the role tokens are unknown`, 'the session token store is gone: compact or resume the session so its hook mints it again');
  if (token === undefined) {
    const o = doc.orchestrator;
    if (!o) return { warn: true };
    throw refused('token-required', `session ${o.session} (process ${o.holder.pid}) holds ${dir}: this call needs its token`, 'run it from that session (the token is in its context), or end that session');
  }
  const hash = hashOf(token);
  const found = doc.orchestrator?.hash === hash ? { role: 'orchestrator' } : doc.agents.find((a) => a.hash === hash);
  if (!found) {
    const was = doc.raw; // the one read of this call: a failure of it is token-store above
    const old = was?.orchestrator?.hash === hash || was?.agents.some((a) => a.hash === hash);
    throw refused(old ? 'token-expired' : 'token-unknown', old ? 'the token has expired or its session ended' : 'the token is not known here (spent, released or never minted)', 'a reviewer asks the orchestrator to dispatch again');
  }
  if ((need === 'orchestrator') !== (found.role === 'orchestrator')) throw refused('token-role', `a ${found.role} token does not serve this call (it needs ${need === 'orchestrator' ? 'the orchestrator' : 'a reviewer'} token)`);
  return { hash, role: found.role };
}

// Spends the one-use token `hash` under the lock and returns its entry (token-unknown when it is gone).
export function consume({ dir, names, hash }) {
  let spent = null;
  open_(dir, names).update('token', null, (cur) => {
    spent = cur?.agents.find((a) => a.hash === hash) ?? null;
    return spent ? { ...cur, agents: cur.agents.filter((a) => a !== spent) } : undefined;
  });
  if (!spent) throw refused('token-unknown', 'the token was spent meanwhile', 'a reviewer reports to the orchestrator, who dispatches again');
  return spent;
}
// Gives a spent entry back when the write it paid for failed (the reviewer retries).
export const restore = ({ dir, names, entry }) => open_(dir, names).update('token', null, (cur) => (cur ? { ...cur, agents: [...cur.agents, entry] } : undefined));

// SubagentStop: the entries of agent `agent` go.
export function revoke({ dir, names, agent, lockMs = 300 }) {
  open_(dir, names, lockMs).update('token', null, (cur) => (cur?.agents.some((a) => a.agent === agent) ? { ...cur, agents: cur.agents.filter((a) => a.agent !== agent) } : undefined));
}

const SHELL = /^(?:sh|bash|zsh|dash)$/;
const ps = (pid) => {
  const r = run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { unit: 'state', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' }, timeoutMs: 2000 });
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout);
  return m && { ppid: Number(m[1]), comm: basename(m[2]).replace(/^-/, '') };
};
// The holder { pid, start } of a hook running as a child of `pid`: that process, or its parent when it is a shell (at
// most two levels up); null when it is not running.
export function holderOf(pid = process.ppid, info = ps) {
  for (let i = 0; i < 2; i++) {
    const p = info(pid);
    if (!p || !SHELL.test(p.comm)) break;
    pid = p.ppid;
  }
  const id = identify([pid]).get(pid);
  return id.state === 'running' ? { pid, start: id.start } : null;
}
