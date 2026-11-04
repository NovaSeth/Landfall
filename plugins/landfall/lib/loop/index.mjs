// Loop unit (spec §4.2, §5.2, §7.7, SD-17, SC6, SC7, GC4, RF3): the successor of the 1.x tick.mjs. One tick:
//   1. measure outside the store lock what only grows or is not the store's: the cost since the loop started
//      (lib/receipts costSince; not measured when the wall time or tick cap ends this tick: those are checked first),
//      the git heads (every local branch and worktree HEAD), the developer's git email
//   2. under the store lock, in one section (store.update of local/loop.json): read the loop document (none: start one
//      with the default caps); a recorded exit → return it, write nothing; read the tasks, the team, the run records
//      and the files under tasks/ (a consistent snapshot: every task write takes the same lock); compute the steps
//      (table.mjs), the fingerprint and the decision (decide.mjs); write the document, its exit included
//   3. return the result; the caller prints it only after the write.
// No read error keeps a tick from counting (GC4): a cost that cannot be measured is partial, a task state that cannot
// be read becomes one repair step, an unreadable directory is part of the fingerprint; the caps and the stall
// detector then end the loop. Reads of the state directory are plain file reads; every write goes through lib/state.
//   tick({ cwd, env, names, now, plan }) → { where, plan, ...result } · tickStore(store, { where, names, now, plan, probe }) (the core, with the
//   probe of step 1 passed in) · startLoop · stopLoop · showLoop. Errors are StateErrors (the CLI maps their exit).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { git } from '../git/index.mjs';
import { costSince, readRuns } from '../receipts/index.mjs';
import { KINDS, StateError, emailHash, open, resolve } from '../state/index.mjs';
import { billingMode } from './billing.mjs';
import { readRunRecords, runsStore } from '../runs/index.mjs';
import { usageLimit } from './limits.mjs';
import { CONSENT, consentAllows, consumeConsent } from '../hooks/prompt-consent.mjs';
import { cheapCap, clock, decide, effectiveCaps, newLoop, parseCaps } from './decide.mjs';
import { CAP_RANGE, CARRIED_PLAN, DEFAULT_CAPS, LOOP, LOOP_ID, STALL, TERMINAL, UNMEASURED, fixedPrompt } from './kind.mjs';
import { DEFAULT_BUDGET_MIN, budgetOf, readBudgets } from './budget.mjs';
import { OUTSIDE_MAX, STATUS_MIN, TABLE_RULES, WAIT_S, nextSteps, parsePlan, readWatch } from './table.mjs';

export { DEFAULT_BUDGET_MIN, budgetOf, readBudgets };
export { billingMode, CAP_RANGE, CARRIED_PLAN, DEFAULT_CAPS, LOOP, LOOP_ID, STALL, STATUS_MIN, TABLE_RULES, TERMINAL, UNMEASURED, WAIT_S, cheapCap, decide, fixedPrompt, newLoop, nextSteps, parseCaps, parsePlan };
export const STORE_KINDS = Object.freeze({ ...KINDS, [LOOP.name]: LOOP });

const PLAN_MAX = 1024 * 1024;
const TREE_MAX = 20000;
const FILE_HASH_MAX = 8 * 1024 * 1024;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const inactive = (where, names) => new StateError('inactive', 'REFUSED', `${where.repo} is not active: the loop runs on the project state`, { hint: `'${names.bin} init' activates it` });
const userDecision = (message, names) => new StateError('user-decision', 'REFUSED', message, { hint: `run it in a terminal, or send \`${names.bin} loop start [--caps k=v,…]\` as your own prompt (one start within 10 min): caps never extend automatically` });

function activeStore({ cwd, env, names }) {
  const where = resolve({ cwd, env, names });
  if (!where.active) throw inactive(where, names);
  return { where, store: open(where.dir, { names, kinds: STORE_KINDS }) };
}

// { path (shown), entries } of a plan file: relative to the repository root (the worktree's: a plan is a file of the
// checkout, as the wakeup guard checks it) or absolute, a regular file ≤ 1 MB.
function readPlan(repo, file) {
  const abs = isAbsolute(file) ? file : join(repo, file);
  let st = null;
  try { st = statSync(abs); } catch { /* reported below */ }
  if (!st || !st.isFile()) throw new StateError('plan-missing', 'USAGE', `no plan file ${file}`, { hint: 'give an existing plan, relative to the repository root or absolute' });
  if (st.size > PLAN_MAX) throw new StateError('limit-exceeded', 'USAGE', `${file} has ${st.size} bytes; a plan is at most ${PLAN_MAX}`, { hint: 'split the plan' });
  const rel = relative(repo, abs);
  const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs;
  return { path, entries: parsePlan(readFileSync(abs, 'utf8')) };
}

// [[path, sha256]] of the files under dir, sorted; links and other entries are recorded, never followed.
function hashTree(dir) {
  const out = [];
  const walk = (rel, depth) => {
    let entries;
    try { entries = readdirSync(rel ? join(dir, rel) : dir).sort(); } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') out.push([rel || '.', `unreadable ${err.code}`]);
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || out.length >= TREE_MAX) continue; // temporary files of writers
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r), { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory() && depth < 6) walk(r, depth + 1);
      else if (st.isFile()) {
        let h;
        try { h = st.size <= FILE_HASH_MAX ? sha256(readFileSync(join(dir, r))) : `size ${st.size} at ${st.mtimeMs}`; } catch (err) { h = `unreadable ${err.code}`; }
        out.push([r, h]);
      } else out.push([r, st.isSymbolicLink() ? 'link' : 'other']);
    }
  };
  walk('', 0);
  return out;
}

// Spec §7.7 step 4: sha256 of the git heads, the files under tasks/ and the run statuses.
const fingerprint = (heads, files, runs) => sha256(JSON.stringify({ heads, files, runs: runs.map((r) => `${r.runId} ${r.status}`).sort() }));

// What the tick reads under the lock. A state error of the tasks becomes `problem` (one repair step).
function snapshot(store, where) {
  const files = hashTree(join(where.dir, 'tasks'));
  try {
    return {
      files,
      runs: readRuns(join(where.local, 'runs')).runs,
      tasks: store.list('task').map((id) => store.read('task', id)),
      team: store.list('team').map((h) => store.read('team', h)),
      lanesOn: store.read('config', null)?.flags?.lanes === 'on',
      problem: null,
    };
  } catch (err) {
    if (!(err instanceof StateError) && typeof err?.code !== 'string') throw err;
    return { files, runs: [], tasks: [], team: [], lanesOn: false, problem: { message: err.message, hint: err.hint ?? '' } };
  }
}

// Paths under an in-repository state directory that git reports as changed or untracked (local/ excluded).
function stateChanges(where, env) {
  const rel = relative(where.repo, where.dir);
  if (where.linked || !rel || rel.startsWith('..') || isAbsolute(rel)) return [];
  const posix = rel.split(sep).join('/');
  const r = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', posix], { cwd: where.repo, env });
  if (r.status !== 0) return [`${posix} (git status failed: ${r.error ?? r.status})`];
  const items = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const path = items[i].slice(3);
    if (/^[RC]/.test(items[i])) i++; // -z: a rename is followed by its old path
    if (!path.startsWith(`${posix}/local/`)) out.push(path);
  }
  return out.sort();
}

// Tasks merged outside the plugin (T-MG-80): done, a recorded branch, no `merged` event, and the branch tip is an ancestor of
// the target. The target is what `task merge` merges into: HEAD of the main checkout (the first worktree), asked there and
// never in a task worktree, where its own branch is always an ancestor of HEAD. Every candidate is checked with one git
// call (the branches merged into HEAD, then a set lookup; fix round 1, F6); only the display is limited (OUTSIDE_MAX).
export { OUTSIDE_MAX };
export function outsideMerges({ where, env, tasks }) {
  const candidates = tasks.filter((t) => t.status === 'done' && t.branch && !(t.events ?? []).some((e) => e.event === 'merged'))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (candidates.length === 0) return [];
  const list = git(['worktree', 'list', '--porcelain'], { cwd: where.repo, env });
  const main = list.status === 0 ? /^worktree (.+)$/m.exec(list.stdout)?.[1] : null;
  if (!main) return [];
  const merged = git(['for-each-ref', '--merged=HEAD', '--format=%(refname)', 'refs/heads/'], { cwd: main, env });
  if (merged.status !== 0) return [];
  const set = new Set(merged.stdout.split('\n').filter(Boolean));
  return candidates.filter((t) => typeof t.branch === 'string' && !t.branch.startsWith('-') && set.has(`refs/heads/${t.branch}`)).map((t) => t.id);
}

// Step 1 of the tick, measured in the repository.
export function gitProbe(where, env, names) {
  const text = (r) => (r.status === 0 ? r.stdout : `error ${r.error ?? r.status}`);
  return {
    heads: () => {
      const refs = git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], { cwd: where.repo, env });
      const trees = git(['worktree', 'list', '--porcelain'], { cwd: where.repo, env });
      return `${text(refs)}\n${trees.status === 0 ? trees.stdout.split('\n').filter((l) => /^(worktree|HEAD) /.test(l)).join('\n') : text(trees)}`;
    },
    email: () => {
      const r = git(['config', '--get', 'user.email'], { cwd: where.repo, env });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    cost: (startedAt) => costSince(startedAt, { env, names, where }),
    dirty: () => stateChanges(where, env),
    outside: (tasks) => outsideMerges({ where, env, tasks }),
    // the run records carry the provider's last line (the tick's snapshot of runs does not); nothing here throws
    limits: ({ since, now = Date.now() }) => {
      let records = [];
      try { records = readRunRecords(runsStore(where.dir, names)); } catch { /* no records: no external limit */ }
      return usageLimit({ repo: where.repo, env, names, now, since, runs: records });
    },
  };
}

// The cost since `loop` started, or null when its wall time or tick cap ends this tick (checked first, so nothing that
// can fail stands before them). A measurement that throws is not measurable, never a failed tick (GC4).
function measure(probe, loop, now) {
  if (cheapCap(loop, now)) return null;
  try {
    return probe.cost(loop.startedAt);
  } catch (err) {
    return { costMicroUsd: 0, partial: true, unmeasurable: true, problems: [{ code: 'cost-unreadable', message: `the cost since the loop started could not be measured: ${String(err?.message ?? err).slice(0, 200)}`, hint: 'check the transcripts and the run records' }] };
  }
}

// The usage limit of the plan seen now, or null; read only when no cap ends the tick, and an error is no limit (GC4).
function readLimit(probe, loop, runs, now) {
  if (typeof probe.limits !== 'function') return null;
  try {
    const l = probe.limits({ since: loop.startedAt, runs, now });
    return l && typeof l === 'object' && typeof l.kind === 'string' ? l : null;
  } catch {
    return null;
  }
}

const NOT_RECORDED = Object.freeze({ mode: 'unknown', source: 'not recorded in the loop' });

// One tick on an open store. probe: { heads() → text, email() → text | null, cost(startedAt) → { costMicroUsd, partial,
// unmeasurable, problems }, dirty() → [path] }. Returns { result, reason, nextTickS, repeated, loop, steps, info,
// costPartial, costProblems }.
export function tickStore(store, { where, names, now, plan = null, probe, watch = [], billing = null, signal = null }) {
  const pre = store.read(LOOP.name, null);
  const measured = pre && !pre.exit ? { id: pre.id, startedAt: pre.startedAt, cost: measure(probe, pre, now) } : null;
  const heads = probe.heads();
  const email = probe.email();
  const hash = email ? emailHash(email) : null;
  let out = null;
  store.update(LOOP.name, null, (cur) => {
    if (cur?.exit) {
      out = { ...decide(cur, {}), loop: cur, steps: [], info: [], costPartial: false, costProblems: [] };
      return undefined;
    }
    let loop = cur ?? newLoop({ now, billing: typeof billing === 'function' ? billing() : billing }); // the mode is decided here, once; later ticks use the stored one
    // one-way ratchet (F2): the tick environment may tighten the stored mode to api, never loosen it
    if (cur && signal?.mode === 'api' && cur.billing?.mode !== 'api') loop = { ...cur, billing: { mode: 'api', source: `${signal.source} (at tick ${cur.ticks + 1})`.slice(0, 120) } };
    // a loop started by this tick has spent nothing; a loop replaced since the measurement is measured again
    const cost = cur === null ? { costMicroUsd: 0, partial: false }
      : measured && measured.id === cur.id && measured.startedAt === cur.startedAt ? measured.cost : measure(probe, cur, now);
    const snap = snapshot(store, where);
    const me = snap.team.find((d) => d.emailSha256 === hash)?.handle ?? null;
    const table = nextSteps({
      tasks: snap.tasks, runs: snap.runs, handles: snap.team.map((d) => d.handle), me, plan, lanesOn: snap.lanesOn,
      caps: effectiveCaps(loop), now, bin: names.bin, budgets: readBudgets(where.dir, snap.tasks), problem: snap.problem, dirty: probe.dirty, watch,
      outside: snap.problem ? [] : probe.outside?.(snap.tasks) ?? [],
    });
    const obs = {
      now, fingerprint: fingerprint(heads, snap.files, snap.runs), costMicroUsd: cost?.costMicroUsd ?? null, unmeasurable: cost?.unmeasurable === true,
      liveRuns: table.liveRuns, outcome: table.outcome, nextTickS: table.nextTickS,
    };
    // the limit is read only when no cap of any kind ends this tick: decide without it first (it is pure)
    const plain = decide(loop, obs);
    const limit = plain.doc.exit === 'BUDGET' ? null : readLimit(probe, loop, snap.runs, now);
    const d = limit ? decide(loop, { ...obs, limit }) : plain;
    const info = limit?.kind === 'codex' && !d.doc.exit
      ? [...table.info, { task: limit.provider ?? 'codex', state: `${limit.provider ?? 'codex'} usage limit ${Number.isFinite(limit.resetAt) ? `until ${clock(limit.resetAt)}` : '(reset time unknown)'}: send reviews and implementations to Claude until then`, step: null, rules: [], kind: 'limit' }]
      : table.info;
    out = { ...d, loop: d.doc, steps: table.steps, info, costPartial: cost?.partial === true, costProblems: cost?.problems ?? [] };
    return d.doc;
  });
  const { doc, ...result } = out;
  return { ...result, billing: result.loop.billing ?? NOT_RECORDED };
}

// plan: the plan's path as shown (relative to the repository root when inside it), or null.
export function tick({ cwd, env, names, now = Date.now(), plan = null, readings = null }) {
  const { where, store } = activeStore({ cwd, env, names });
  const planDoc = plan === null ? null : readPlan(where.worktree, plan);
  return { where, plan: planDoc?.path ?? null, ...tickStore(store, { where, names, now, plan: planDoc, probe: gitProbe(where, env, names), watch: readWatch({ names, env, now, readings }), billing: () => billingMode({ env, names }), signal: billingMode({ env, names, envOnly: true }) }) }; // billing: only a loop this tick creates stores it; signal: may tighten a stored one
}

// A new loop with `caps` over the defaults. A running loop is never replaced; after an ended one (DONE, `loop stop`
// included, STALLED or BUDGET), and for a cap above its default, only the user starts one, so caps never extend by
// themselves (SD-17, GC4). The user: byUser (a terminal is attached), or a consent the user's own prompt recorded
// (lib/hooks/prompt-consent.mjs, T-MG-149), consumed here once: same repository, not expired, the caps within the
// consented ones. A consent is consumed only when the start needs it, after the running-loop check; a refused start
// leaves it unused. Session: the Bash environment carries no session id, so the consent matches the repository.
export function startLoop({ cwd, env, names, now = Date.now(), caps = {}, byUser = false }) {
  const raised = Object.keys(caps).filter((k) => caps[k] > DEFAULT_CAPS[k]);
  const where = resolve({ cwd, env, names });
  const store = where.active ? open(where.dir, { names, kinds: { ...STORE_KINDS, [CONSENT.name]: CONSENT } }) : null;
  const ask = { repo: where.repo, caps, now };
  const raiseRefused = () => userDecision(`raising ${raised.join(', ')} above the default is the user's decision`, names);
  if (raised.length && !byUser && !(store && consentAllows(store.read(CONSENT.name, null), ask).ok)) throw raiseRefused();
  if (!store) throw inactive(where, names);
  const running = (cur) => new StateError('loop-running', 'FAIL', `loop ${cur.id} is running (tick ${cur.ticks} of ${cur.caps.ticks})`, { hint: `'${names.bin} loop stop' ends it first` });
  const ended = (cur) => userDecision(`the last loop ended with ${cur.exit}: a new loop after an ended one is the user's decision`, names);
  const seen = store.read(LOOP.name, null);
  if (seen && !seen.exit) throw running(seen);
  let user = byUser;
  if (!user && (raised.length || seen)) {
    user = consumeConsent(store, ask);
    if (!user) throw raised.length ? raiseRefused() : ended(seen);
  }
  let replaced = null;
  const billing = billingMode({ env, names, byUser: user });
  const loop = store.update(LOOP.name, null, (cur) => {
    if (cur && !cur.exit) throw running(cur);
    if (cur && !user) throw ended(cur);
    replaced = cur;
    return newLoop({ now, caps: { ...DEFAULT_CAPS, ...caps }, byUser: user, billing });
  });
  return { where, loop, replaced, billing: loop.billing, consented: user && !byUser };
}

// Ends a running loop: exit DONE with the reason "stopped"; no loop or an ended one is left as it is.
export function stopLoop({ cwd, env, names, now = Date.now() }) {
  const { where, store } = activeStore({ cwd, env, names });
  let stopped = false;
  const loop = store.update(LOOP.name, null, (cur) => {
    if (!cur || cur.exit) return undefined;
    stopped = true;
    return { ...cur, exit: 'DONE', exitAt: iso(now), reason: `stopped with '${names.bin} loop stop'` };
  });
  return { where, loop, stopped };
}

// The loop document (null: none, or an inactive repository). Reads only.
export function showLoop({ cwd, env, names }) {
  const where = resolve({ cwd, env, names });
  return { where, loop: where.active ? open(where.dir, { names, kinds: STORE_KINDS }).read(LOOP.name, null) : null, billing: billingMode({ env, names }) }; // billing: the detected mode, shown when no loop exists; a loop shows its stored one
}
