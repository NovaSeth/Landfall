// Engine signals (spec §7.4): daily series computed from git history and the state, deterministic for a given HEAD
// and date (days are UTC; a value of day d is the state at the end of d, today's is HEAD). Each series holds as
// many days as its rule looks back: a tier signal its dwell, a toggle twice its dwell. Read-only.
//   loc            lines of tracked source files (extensions of the profile stack, all known ones without a stack
//                  fact): `git grep -c` at HEAD, earlier days by the first-parent numstat deltas since then
//   modules        directories directly under src/, packages/ and the workspace roots of package.json at HEAD
//                  (`dir/*` patterns; a literal workspace path is one module), counted per day-end commit
//   contributors30 authors (by email hash; bots excluded by name or email) with commits on `distinctDays` distinct
//                  days (author date) of the `windowDays` days ending that day
//   parallelTasks  tasks in flight (dispatched, implemented, in-review, fix-round): from the first `dispatched`
//                  event; a task no longer in flight counts until its last event (events carry no status, so the
//                  day it left is bounded by its last event; this errs toward in flight)
//   incidents30    revert commits (subject `Revert "…`, commit date) and tasks of kind incident (creation) in the
//                  `windowDays` days ending that day
// Profile facts come from lib/profile (factValues): deployedToUsers sets a floor, the rest select method packs.
// A git call that fails (other than the expected "no HEAD", "no match", "no package.json") is ENV: a signal is
// never read as zero from a failure.
import { git } from '../git/index.mjs';
import { factValues, readProfile } from '../profile/index.mjs';
import { StateError, emailHash, open } from '../state/index.mjs';
import { THRESHOLDS, dayString } from './tiers.mjs';

const DAY_MS = 86400000;
const IN_FLIGHT = new Set(['dispatched', 'implemented', 'in-review', 'fix-round']);
const RS = '\x1e';
const US = '\x1f';
const GLOB = /[*?[\]{}!]/;
const dayOfSeconds = (s) => Math.floor((s * 1000) / DAY_MS);
const dayOfIso = (iso) => Math.floor(Date.parse(iso) / DAY_MS);
// Day numbers oldest first: n days ending today.
const lastDays = (today, n) => Array.from({ length: n }, (_, i) => today - n + 1 + i);
// git with fixed output options; a status outside `ok` (or no status) throws ENV.
function run(repo, env, args, ok = [0]) {
  const r = git(['-c', 'core.quotePath=false', ...args], { cwd: repo, env });
  if (r.error || !ok.includes(r.status)) {
    const why = (r.stderr || r.error || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200);
    throw new StateError('git-failed', 'ENV', `git ${args[0]} failed in ${repo}: ${why}`, { hint: 'check the repository with git fsck; the tier is not evaluated from incomplete history' });
  }
  return r;
}

function headOf(repo, env) {
  const r = run(repo, env, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [0, 1]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Source extensions of the stack; every known one when the stack is unknown.
function extensionsOf(stack, table) {
  const known = Array.isArray(stack) ? stack.filter((s) => Object.hasOwn(table, s)) : [];
  return new Set((known.length ? known : Object.keys(table)).flatMap((s) => table[s]));
}
const isSource = (path, exts) => {
  const m = /\.([^./]+)$/.exec(path);
  return Boolean(m) && exts.has(m[1]);
};

// The first-parent history back to the start of `firstDay`: [{ sha, ct, loc }] newest first, ending with the state
// before the oldest listed commit (its first parent, or the empty repository).
function history(repo, env, head, firstDay, exts) {
  const grep = run(repo, env, ['grep', '--no-color', '-I', '-c', '-e', '', 'HEAD', '--', ...[...exts].map((e) => `*.${e}`)], [0, 1]);
  let loc = 0;
  for (const line of grep.stdout.split('\n')) {
    const i = line.lastIndexOf(':');
    const path = line.slice(5, i); // after `HEAD:`
    if (i > 5 && isSource(path, exts)) loc += Number(line.slice(i + 1)) || 0;
  }
  const since = new Date(firstDay * DAY_MS).toISOString();
  const log = run(repo, env, ['log', '--first-parent', '-m', '--no-renames', '--numstat', '--no-show-signature', `--format=${RS}%H${US}%P${US}%ct`, `--since=${since}`, 'HEAD']);
  const commits = [];
  for (const record of log.stdout.split(RS).slice(1)) {
    const [header, ...rest] = record.split('\n');
    const [sha, parents, ct] = header.split(US);
    let delta = 0;
    for (const line of rest) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
      if (m && isSource(m[3], exts)) delta += Number(m[1]) - Number(m[2]);
    }
    commits.push({ sha, parent: parents.split(' ')[0] || null, ct: Number(ct), delta });
  }
  if (!commits.length) return [{ sha: head, ct: -Infinity, loc }];
  const out = [];
  for (const c of commits) {
    out.push({ sha: c.sha, ct: c.ct, loc });
    loc -= c.delta;
  }
  const oldest = commits[commits.length - 1];
  out.push({ sha: oldest.parent, ct: -Infinity, loc: oldest.parent ? loc : 0 });
  return out;
}

// Module roots and literal module paths from the workspaces of package.json at HEAD.
function workspaces(repo, env) {
  const r = run(repo, env, ['show', 'HEAD:package.json'], [0, 128]); // 128: no package.json at HEAD
  let pkg = null;
  try { pkg = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { pkg = null; }
  const list = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : [];
  const roots = new Set(['src', 'packages']);
  const literals = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p || p.startsWith('/') || p.startsWith('-') || p.split('/').includes('..')) continue;
    const m = /^(.+)\/\*\*?$/.exec(p);
    if (m && !GLOB.test(m[1])) roots.add(m[1]);
    else if (!GLOB.test(p)) literals.add(p);
  }
  return { roots: [...roots], literals: [...literals] };
}

function modulesAt(repo, env, sha, ws) {
  if (!sha) return 0;
  const r = run(repo, env, ['ls-tree', '-d', '--name-only', sha, '--', ...ws.roots.map((d) => `${d}/`), ...ws.literals]);
  return new Set(r.stdout.split('\n').filter(Boolean)).size;
}

// Commits since the start of `firstDay` (by commit date): author day, commit day, email hash, name, subject.
function commitsSince(repo, env, firstDay) {
  const since = new Date(firstDay * DAY_MS).toISOString();
  const r = run(repo, env, ['log', '--no-show-signature', `--format=%at${US}%ct${US}%ae${US}%an${US}%s`, `--since=${since}`, 'HEAD']);
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const [at, ct, email, name, ...subject] = line.split(US);
    if (!ct) continue;
    out.push({ authorDay: dayOfSeconds(Number(at)), commitDay: dayOfSeconds(Number(ct)), email: email ?? '', name: name ?? '', subject: subject.join(US) });
  }
  return out;
}

function contributorSeries(commits, days, { windowDays, distinctDays }, bots) {
  const byAuthor = new Map();
  for (const c of commits) {
    if (bots.some((re) => re.test(c.name) || re.test(c.email))) continue;
    const key = emailHash(c.email);
    if (!byAuthor.has(key)) byAuthor.set(key, new Set());
    byAuthor.get(key).add(c.authorDay);
  }
  const authors = [...byAuthor.values()].map((s) => [...s]);
  return days.map((d) => authors.filter((ds) => ds.filter((x) => x <= d && x > d - windowDays).length >= distinctDays).length);
}

function taskSeries(tasks, days) {
  const spans = [];
  for (const t of tasks) {
    const start = t.events.find((e) => e.event === 'dispatched') ?? (IN_FLIGHT.has(t.status) ? t.events[0] : null);
    if (!start) continue;
    const last = t.events[t.events.length - 1];
    spans.push({ from: Date.parse(start.at), until: IN_FLIGHT.has(t.status) ? Infinity : Date.parse(last.at) });
  }
  return days.map((d) => {
    const end = (d + 1) * DAY_MS;
    return spans.filter((s) => s.from < end && s.until >= end).length;
  });
}

function incidentSeries(commits, tasks, days, windowDays) {
  const at = [
    ...commits.filter((c) => /^Revert "/.test(c.subject)).map((c) => c.commitDay),
    ...tasks.filter((t) => t.kind === 'incident' && t.events.length).map((t) => dayOfIso(t.events[0].at)),
  ];
  return days.map((d) => at.filter((x) => x <= d && x > d - windowDays).length);
}

// { day, head, values, series, facts } of the resolved repository `where` (lib/state resolve) at `now`.
export function readSignals(where, { names, env, now = new Date().toISOString(), thresholds = THRESHOLDS } = {}) {
  const today = dayOfIso(now);
  const { repo } = where;
  const head = headOf(repo, env);
  const profile = where.active ? readProfile(where, { names, env, now }).profile : null;
  const facts = factValues(profile);
  const store = where.active ? open(where.dir, { names }) : null;
  const tasks = store ? store.list('task').map((id) => store.read('task', id)) : [];
  const { loc: locRule, modules: modRule, contributors30: c30 } = thresholds.tierSignals;
  const { parallelTasks: parRule, incidents30: incRule } = thresholds.toggles;
  const series = {};

  const locDays = lastDays(today, Math.max(locRule.dwellDays, modRule.dwellDays));
  if (head) {
    const states = history(repo, env, head, locDays[0], extensionsOf(facts.stack, thresholds.sourceExtensions));
    const ws = workspaces(repo, env);
    const modules = new Map();
    const at = locDays.map((d, i) => (i === locDays.length - 1 ? states[0] : states.find((s) => s.ct < ((d + 1) * DAY_MS) / 1000)));
    const modulesOf = (s) => {
      if (!modules.has(s.sha)) modules.set(s.sha, modulesAt(repo, env, s.sha, ws));
      return modules.get(s.sha);
    };
    series.loc = at.map((s) => s.loc).slice(-locRule.dwellDays);
    series.modules = at.map(modulesOf).slice(-modRule.dwellDays);
  } else {
    series.loc = new Array(locRule.dwellDays).fill(0);
    series.modules = new Array(modRule.dwellDays).fill(0);
  }

  const c30Days = lastDays(today, c30.dwellDays);
  const incDays = lastDays(today, incRule.dwellDays * 2);
  const firstCommitDay = Math.min(c30Days[0] - c30.windowDays + 1, incDays[0] - incRule.windowDays + 1);
  const commits = head ? commitsSince(repo, env, firstCommitDay) : [];
  const bots = thresholds.bots.map((p) => new RegExp(p, 'i'));
  series.contributors30 = contributorSeries(commits, c30Days, c30, bots);
  series.parallelTasks = taskSeries(tasks, lastDays(today, parRule.dwellDays * 2));
  series.incidents30 = incidentSeries(commits, tasks, incDays, incRule.windowDays);

  const last = (k) => series[k][series[k].length - 1];
  const values = {
    loc: last('loc'), modules: last('modules'), contributors30: last('contributors30'),
    parallelTasks: last('parallelTasks'), incidents30: last('incidents30'),
    deployedToUsers: typeof facts.deployedToUsers === 'boolean' ? facts.deployedToUsers : null,
  };
  return { day: dayString(today), head, values, series, facts };
}
