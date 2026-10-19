// `<bin> doctor` (spec §7.19 NICE 3, SD-4, SD-5, U3, §7.14a): the health report. Read-only always: it runs `claude`
// through lib/proc and git through lib/git, reads the state through lib/state and lib/profile and the settings files
// for the permission advice, and writes nothing.
// data.checks are the v0 checks, as the install e2e test pins them: Claude Code at or above the floor, the plugin
// installed and enabled, every hook event of the registry registered; `side-files` appears only when a generated side
// file is tracked. data.rows are the rest of the report, one row per item, { id, status, detail, hint }; status is
// ok, warn (advice: the exit code stays), fail (a problem: an error, exit 1) or skip (not checked, or unknown):
//   release      the installed version vs the newest <plugin>--v<x.y.z> tag of the marketplace source (git ls-remote,
//                capped at 2 s; offline, no tag or no git source → skip "unknown"); a newer tag warns (SD-4)
//   heartbeat    hook heartbeat per event: no hook writes one in this version → skip "not recorded"
//   bin-path     the first <bin> on PATH is this launcher (Claude Code puts the plugin's bin/ on the Bash tool PATH)
//   state        state.json schema vs this plugin: newer or invalid → fail (writes are refused)
//   profile      profile freshness (lib/profile scanDue): a scan due → warn
//   flags        the capability flags (lib/config: machine overrides, config.json, defaults); a machine entry that is
//                no rollout capability, or a repository value that would lower a protective capability (ignored) → warn
//   providers    provider detection (write: false): the providers found and their auth; none found → warn
//   scheduler    calibration (saved or default) and the live leases; no saved calibration → warn
//   context      the always-on cost from the one `claude plugin details` call the hooks check reads: over the SC3
//                budget → warn
//   permissions  the permission rules U3 advises, looked up in the user and project settings (never written)
//   protection   branch protection of the claim refs needs gh, which only lib/mirror may run (spec §4.3), not in this
//                version → skip
// Exit 0 healthy · 1 a check or row failed · 8 claude or git missing or not runnable (the report is still listed).
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { flagsOf, readConfig } from '../config/index.mjs';
import { trackedSideFiles } from '../gen/index.mjs';
import { git } from '../git/index.mjs';
import { HOOKS } from '../hooks/registry.mjs';
import { run } from '../proc/index.mjs';
import { detectProviders } from '../providers/index.mjs';
import { readProfile } from '../profile/index.mjs';
import { currentCalibration, snapshot } from '../sched/index.mjs';
import { KINDS, StateError, open as openStore, resolve as resolveRepo } from '../state/index.mjs';
import { EXIT } from './commands.mjs';

// SD-5: the oldest Claude Code version CI runs (tests/cli-contract.test.mjs keeps the two equal).
export const CLAUDE_CODE_FLOOR = '2.1.300';
const TIMEOUT_MS = 30000;
// Offline-safe release check: a source that does not answer within this is "unknown".
export const RELEASE_TIMEOUT_MS = 2000;
// SC3: `claude plugin details` "Always-on" ≤ 1,000 tok.
export const ALWAYS_ON_BUDGET = 1000;

export function parseVersion(text) {
  const m = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// `claude plugin details <plugin>` text: hook events and the always-on token cost; null when unrecognised.
export function parseDetails(text) {
  const s = String(text ?? '');
  const hooks = /^\s*Hooks \((\d+)\)(.*)$/m.exec(s);
  const cost = /^\s*Always-on:\s*~?\s*(\d[\d,]*(?:\.\d+)?)\s*(k?)\s*tok\b/m.exec(s);
  if (!hooks || !cost) return null;
  const hookEvents = hooks[2].replace(/\([^)]*\)\s*$/, '').split(',').map((e) => e.trim()).filter(Boolean);
  return { hookEvents, alwaysOnTokens: Math.round(Number(cost[1].replace(/,/g, '')) * (cost[2] ? 1000 : 1)) };
}

// The git remote of an entry of `claude plugin marketplace list --json` ({ name, source, repo | url | path }), or null
// when git cannot list its tags: github → its https URL, git → an https, ssh or scp-like URL, directory → an absolute
// path. Any other value (an option, another transport such as ext::) is refused.
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const GIT_URL = /^(?:https:\/\/|ssh:\/\/|git@[\w.-]+:)\S+$/;
export function marketplaceRemote(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.source === 'github' && typeof entry.repo === 'string' && GITHUB_REPO.test(entry.repo)) return `https://github.com/${entry.repo}.git`;
  if (entry.source === 'git' && typeof entry.url === 'string' && GIT_URL.test(entry.url)) return entry.url;
  if (entry.source === 'directory' && typeof entry.path === 'string' && isAbsolute(entry.path)) return entry.path;
  return null;
}

// The newest release version among `git ls-remote --tags` lines: refs/tags/<plugin>--v<x.y.z> (SD-4), pre-releases
// and other names ignored; null when there is none.
export function latestTag(lsRemote, plugin) {
  const re = new RegExp(`^refs/tags/${plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}--v(\\d+)\\.(\\d+)\\.(\\d+)$`);
  let best = null;
  for (const line of String(lsRemote ?? '').split('\n')) {
    const m = re.exec((line.split('\t')[1] ?? '').trim());
    const v = m ? m.slice(1, 4).map(Number) : null;
    if (v && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

// The permission rules U3 advises: background runs call these without a prompt once the user allows them.
export const permissionRules = (bin) => [`Bash(${bin} exec:*)`, `Bash(${bin} wait:*)`];

const firstLine = (text) => String(text ?? '').trim().split('\n')[0].slice(0, 120);
const row = (id, status, detail, hint) => ({ id, status, detail, hint });
const jsonOf = (r) => {
  if (r.error || r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
};

// §7.14a: a tracked side file is a proposal committed by mistake. Reported only when one is tracked (outside a git
// repository there is nothing to check).
function sideFiles({ names, io }) {
  const tracked = trackedSideFiles({ cwd: io.cwd, env: io.env, names }) ?? [];
  if (tracked.length === 0) return { checks: [], errors: [] };
  const list = `${tracked.slice(0, 3).join(', ')}${tracked.length > 3 ? `, … (${tracked.length})` : ''}`;
  const hint = `merge each into its target, then git rm it (${names.bin} gen plan lists the targets)`;
  return {
    checks: [{ id: 'side-files', ok: false, detail: `tracked: ${list}`, hint }],
    errors: [{ code: 'side-file-tracked', message: `generated side files are tracked: ${list}`, hint }],
  };
}

function releaseRow({ names, io, id, installed, marketplaces }) {
  const update = `claude plugin update ${id}, then /reload-plugins`;
  const unknown = (why) => row('release', 'skip', `${installed ?? 'unknown'} installed; latest tag unknown (${why})`, `nothing to fix offline; to update: ${update}`);
  const known = parseVersion(installed);
  if (!known) return unknown('the installed version is not readable');
  if (!Array.isArray(marketplaces)) return unknown('`claude plugin marketplace list --json` not readable');
  const entry = marketplaces.find((m) => m?.name === names.marketplace);
  const remote = marketplaceRemote(entry);
  if (!remote) return unknown(entry ? 'the marketplace source has no git tags' : `marketplace ${names.marketplace} not listed`);
  const r = git(['ls-remote', '--tags', '--refs', remote], { cwd: io.cwd, env: { ...io.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: RELEASE_TIMEOUT_MS });
  if (r.error === 'timeout') return unknown(`no answer within ${RELEASE_TIMEOUT_MS / 1000} s`);
  if (r.error || r.status !== 0) return unknown('the source is not reachable');
  const latest = latestTag(r.stdout, names.plugin);
  // An installed pre-release (x.y.z-beta.n) is current while its own tag is the newest; the release x.y.z supersedes it.
  const preRelease = /^\d+\.\d+\.\d+-/.test(String(installed));
  const ownTag = String(r.stdout).split('\n').some((l) => (l.split('\t')[1] ?? '').trim() === `refs/tags/${names.plugin}--v${installed}`);
  if (!latest) {
    if (preRelease && ownTag) return row('release', 'ok', `${installed} installed (a pre-release; no release tag yet)`, update);
    return unknown(`no ${names.plugin}--v<x.y.z> tag at the source`);
  }
  const order = compareVersions(latest, known);
  if (order > 0 || (preRelease && order === 0)) return row('release', 'warn', `${installed} installed; ${latest.join('.')} is released`, update);
  return row('release', 'ok', `${installed} installed (latest tag ${latest.join('.')})`, update);
}

// Read-only (write: false): the providers found with their auth; none found → warn.
function providersRow({ names, io }) {
  try {
    const detected = detectProviders({ names, env: io.env, write: false, cacheOnly: true });
    if (detected.notProbed) return row('providers', 'ok', 'not probed yet (doctor reads the cache only)', `'${names.bin} providers' detects the provider CLIs`);
    const rows = detected.rows;
    const found = rows.filter((r) => r.found);
    const detail = `${found.length}/${rows.length} found: ${found.map((r) => `${r.id} (auth ${r.auth})`).join(', ') || 'none'}`;
    return row('providers', found.length ? 'ok' : 'warn', detail, `'${names.bin} providers' lists them; install a provider CLI to delegate work`);
  } catch (err) { return row('providers', 'skip', `not readable: ${firstLine(err.message)}`, `'${names.bin} providers --refresh' re-detects`); }
}

// Read-only: the calibration (saved or from the readings) and the live leases.
function schedulerRow({ names, io }) {
  try {
    const opts = { names, env: io.env };
    const c = currentCalibration(opts);
    const live = snapshot(opts).leases.filter((l) => l.status === 'live').length;
    return row('scheduler', c.saved ? 'ok' : 'warn', `calibration ${c.saved ? 'saved' : 'not saved (defaults)'}${c.due ? ', due' : ''}; ${live} live lease${live === 1 ? '' : 's'}`, `'${names.bin} slots calibrate' sets the machine limits`);
  } catch (err) { return row('scheduler', 'skip', `not readable: ${firstLine(err.message)}`, `'${names.bin} slots' shows the scheduler`); }
}

function firstOnPath(name, pathValue) {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}
const realPath = (p) => { try { return realpathSync(p); } catch { return null; } };

function binRow({ names, io, pluginRoot }) {
  const own = join(pluginRoot, 'bin', names.bin);
  const found = firstOnPath(names.bin, io.env?.PATH);
  const hint = 'in Claude Code the plugin\'s bin/ is on the Bash tool PATH once the plugin is enabled (/reload-plugins); a terminal needs it on PATH';
  if (!found) return row('bin-path', 'warn', `${names.bin} is not on PATH`, hint);
  if (realPath(found) === realPath(own)) return row('bin-path', 'ok', found, hint);
  return row('bin-path', 'warn', `${found} comes first on PATH, not ${own}`, `remove that ${names.bin} or put the plugin's bin/ before it on PATH`);
}

const SCAN_DUE = {
  'never-scanned': () => 'never scanned',
  'head-unknown': () => 'the last scanned commit is gone (history rewritten)',
  commits: (s) => `${s.commits} commits since the last scan`,
  days: (s) => `${s.days} days since the last scan`,
};

// "<flag> <mode>" per flag, the source in parentheses unless the repository set it, and the ignored machine entries.
function flagList({ flags, ignored, lowered }) {
  const set = Object.entries(flags).map(([k, f]) => `${k} ${f.mode}${f.source === 'repo' ? '' : ` (${f.source})`}`);
  return [...set, ...ignored.map((k) => `${k} ignored (machine config: not a rollout capability)`),
    ...lowered.map((l) => `${l.name} ${l.mode} in config.json ignored (a committed file never lowers a protective capability; flags set --local does)`)].join(', ');
}

// The state, profile and flags rows of the repository at cwd. A StateError is a failed row (and an error) except
// not-a-repo (rows skipped) and git-missing (an environment error). Returns { rows, repo, env }.
function repoRows({ names, io, id, errors }) {
  const ids = ['state', 'profile', 'flags'];
  const skipAll = (detail, hint) => ids.map((x) => row(x, 'skip', detail, hint));
  let where;
  try {
    where = resolveRepo({ cwd: io.cwd, env: io.env, names });
  } catch (err) {
    if (!(err instanceof StateError)) throw err;
    if (err.code === 'not-a-repo') return { rows: skipAll('not in a git repository', 'run doctor inside a repository to check its state'), repo: null, env: null };
    if (err.code === 'git-missing') return { rows: skipAll('git is not on PATH', err.hint), repo: null, env: err };
    errors.push(err);
    return { rows: [row('state', 'fail', err.message, err.hint), ...skipAll('the machine data is not readable', 'fix the state row first').slice(1)], repo: null, env: null };
  }
  const inactive = skipAll(`not active in ${where.repo}`, `start tracking with /${names.plugin}:start (${names.bin} init)`);
  if (!where.active) return { rows: inactive, repo: where.repo, worktree: where.worktree, env: null };
  const failed = (x, err) => {
    if (!(err instanceof StateError)) throw err;
    errors.push(err);
    return row(x, 'fail', err.message, err.hint);
  };
  const update = `update the plugin (claude plugin update ${id}), then retry`;

  let state = null;
  let stateRow;
  try {
    state = openStore(where.dir, { names }).read('state');
    if (state === null) return { rows: inactive, repo: where.repo, worktree: where.worktree, env: null };
    if (state.schema > KINDS.state.version) {
      const message = `state.json has schema ${state.schema}; this plugin knows schema ${KINDS.state.version} and refuses to write`;
      errors.push({ code: 'schema-newer', message, hint: update });
      stateRow = row('state', 'fail', message, update);
      state = null;
    } else stateRow = row('state', 'ok', `schema ${state.schema} (this plugin: ${KINDS.state.version})`, `a newer schema needs a plugin update: ${update}`);
  } catch (err) {
    stateRow = failed('state', err);
  }

  let profileRow;
  try {
    const p = readProfile(where, { names, env: io.env });
    const s = p.scan;
    const observe = `run ${names.bin} profile observe`;
    if (!p.active) profileRow = row('profile', 'skip', `not active in ${where.repo}`, `start tracking with /${names.plugin}:start`);
    else if (s.due) profileRow = row('profile', 'warn', `scan due: ${SCAN_DUE[s.reason](s)}`, observe);
    else profileRow = row('profile', 'ok', `scanned ${s.days} days and ${s.commits} commits ago`, `${observe} after large changes`);
  } catch (err) {
    profileRow = failed('profile', err);
  }

  let flagsRow = row('flags', 'skip', 'state.json not readable', 'fix the state row first');
  if (state !== null) {
    try {
      const f = flagsOf(readConfig(where, { names, env: io.env }));
      flagsRow = row('flags', f.ignored.length || f.lowered.length ? 'warn' : 'ok', flagList(f), `${names.bin} flags show explains each flag (off | shadow | on); ${names.bin} tier --explain shows what the tier sets`);
    } catch (err) {
      flagsRow = failed('flags', err);
    }
  }
  return { rows: [stateRow, profileRow, flagsRow], repo: where.repo, worktree: where.worktree, env: null };
}

function contextRow(info) {
  if (!info) return row('context', 'skip', 'unknown: `claude plugin details` is not readable', 'install and enable the plugin, then /reload-plugins');
  const n = info.alwaysOnTokens;
  const hint = `report it in an issue with the doctor --json output; the budget is ${ALWAYS_ON_BUDGET} tok always-on (SC3)`;
  if (n > ALWAYS_ON_BUDGET) return row('context', 'warn', `~${n} tok always-on, over the ${ALWAYS_ON_BUDGET} tok budget (SC3)`, hint);
  return row('context', 'ok', `~${n} tok always-on (budget ${ALWAYS_ON_BUDGET} tok)`, hint);
}

// The allow rules of one settings file ([] when absent or unreadable).
function allowRules(file) {
  try {
    const allow = JSON.parse(readFileSync(file, 'utf8'))?.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((r) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

// U3: read-only; the user adds the rules through /permissions, the plugin never writes settings (GC2).
function permissionsRow({ names, io, repo }) {
  const env = io.env ?? {};
  const config = isAbsolute(env.CLAUDE_CONFIG_DIR ?? '') ? env.CLAUDE_CONFIG_DIR : isAbsolute(env.HOME ?? '') ? join(env.HOME, '.claude') : null;
  const files = [config && join(config, 'settings.json'), repo && join(repo, '.claude', 'settings.json'), repo && join(repo, '.claude', 'settings.local.json')];
  const allowed = new Set(files.filter(Boolean).flatMap(allowRules));
  const rules = permissionRules(names.bin);
  const wide = ['Bash', `Bash(${names.bin}:*)`].some((r) => allowed.has(r));
  const missing = wide ? [] : rules.filter((r) => !allowed.has(r));
  const hint = `add ${(missing.length ? missing : rules).join(' and ')} with /permissions (background runs need them; the plugin never writes settings)`;
  if (missing.length) return row('permissions', 'warn', `not allowed: ${missing.join(', ')}`, hint);
  return row('permissions', 'ok', `allowed: ${rules.join(', ')}`, hint);
}

const LABEL = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
const line = (label, id, detail) => `  ${label}  ${id.padEnd(13)}${detail}`;
function render(bin, checks, rows, errors) {
  const warnings = rows.filter((r) => r.status === 'warn').length;
  return [
    `${bin} doctor`,
    ...checks.map((c) => line(c.ok ? LABEL.ok : LABEL.fail, c.id, c.detail)),
    ...rows.flatMap((r) => [line(LABEL[r.status], r.id, r.detail), ...(r.status === 'warn' ? [`        fix: ${r.hint}`] : [])]),
    errors.length ? 'problems found' : warnings ? `healthy, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'healthy',
    '',
  ].join('\n');
}

export function doctor({ names, io, version, pluginRoot }) {
  const id = `${names.plugin}@${names.marketplace}`;
  const opts = { unit: 'cli', cwd: io.cwd, env: io.env, timeoutMs: TIMEOUT_MS };
  const envErrors = []; // exit 8
  const errors = []; // exit 1
  const side = sideFiles({ names, io });
  const rowErrors = [];
  const repo = repoRows({ names, io, id, errors: rowErrors });

  const v = run('claude', ['--version'], opts);
  const claudeRuns = !v.error && v.status === 0;
  let checks = side.checks;
  let data = { claudeCode: { version: null, floor: CLAUDE_CODE_FLOOR } };
  let info = null;
  let entry = null;
  let marketplaces = null;
  if (!claudeRuns) {
    const missing = v.error === 'missing';
    envErrors.push({
      code: missing ? 'claude-missing' : 'claude-failed',
      message: missing ? 'claude is not on PATH' : `claude --version failed: ${v.error ?? `exit ${v.status}`} ${firstLine(v.stderr)}`.trim(),
      hint: `install Claude Code ${CLAUDE_CODE_FLOOR} or newer and put \`claude\` on PATH`,
    });
  } else {
    const ver = parseVersion(v.stdout);
    const floor = parseVersion(CLAUDE_CODE_FLOOR);
    const versionOk = ver !== null && compareVersions(ver, floor) >= 0;
    const versionHint = `update Claude Code (\`claude update\`) to ${CLAUDE_CODE_FLOOR} or newer`;
    if (!ver) errors.push({ code: 'claude-code-version-unknown', message: `cannot read a version from \`claude --version\`: ${firstLine(v.stdout)}`, hint: 'check that `claude --version` prints x.y.z' });
    else if (!versionOk) errors.push({ code: 'claude-code-too-old', message: `Claude Code ${ver.join('.')} is older than the supported floor ${CLAUDE_CODE_FLOOR}`, hint: versionHint });

    const list = jsonOf(run('claude', ['plugin', 'list', '--json'], opts));
    const listReadable = Array.isArray(list);
    entry = listReadable ? list.find((p) => p && p.id === id) ?? null : null;
    const enabled = entry?.enabled === true;
    const pluginHint = `claude plugin install ${names.plugin} --marketplace <owner>/<repo> (or claude plugin enable ${id}), then /reload-plugins`;
    if (!enabled) {
      const why = !listReadable ? '`claude plugin list --json` gave unreadable output' : entry ? `plugin ${id} is installed but disabled` : `plugin ${id} is not installed`;
      errors.push({ code: 'plugin-not-loaded', message: why, hint: pluginHint });
    }

    // One `claude plugin details` call serves the hooks check and the context row.
    const expected = [...new Set(HOOKS.map((h) => h.event))];
    const details = run('claude', ['plugin', 'details', id], opts);
    info = details.status === 0 ? parseDetails(details.stdout) : null;
    const registered = info ? info.hookEvents : [];
    const missing = expected.filter((e) => !registered.includes(e));
    const hooksHint = 'run /reload-plugins or restart Claude Code; reinstall the plugin if it persists';
    if (!info) errors.push({ code: 'hooks-not-registered', message: `cannot read hooks from \`claude plugin details ${id}\`: ${firstLine(details.stderr || details.stdout)}`, hint: 'install and enable the plugin, then /reload-plugins' });
    else if (missing.length) errors.push({ code: 'hooks-not-registered', message: `hook events not registered: ${missing.join(', ')}`, hint: hooksHint });

    marketplaces = jsonOf(run('claude', ['plugin', 'marketplace', 'list', '--json'], opts));
    checks = [
      { id: 'claude-code', ok: versionOk, detail: ver ? `${ver.join('.')} (floor ${CLAUDE_CODE_FLOOR})` : `unknown (floor ${CLAUDE_CODE_FLOOR})`, hint: versionHint },
      { id: 'plugin', ok: enabled, detail: entry ? `${id} ${enabled ? 'enabled' : 'disabled'}, version ${entry.version ?? 'unknown'}` : `${id} not installed`, hint: pluginHint },
      { id: 'hooks', ok: Boolean(info) && missing.length === 0, detail: info ? `${registered.length}/${expected.length} events registered${missing.length ? `; missing ${missing.join(', ')}` : ''}` : 'not readable', hint: hooksHint },
      ...side.checks,
    ];
    data = {
      claudeCode: { version: ver ? ver.join('.') : null, floor: CLAUDE_CODE_FLOOR },
      plugin: { id, enabled, version: entry?.version ?? null },
      hooks: { expected, registered, missing },
      alwaysOnTokens: info ? info.alwaysOnTokens : null,
    };
  }
  if (repo.env) envErrors.push(repo.env);

  const rows = [
    releaseRow({ names, io, id, installed: entry?.version ?? version, marketplaces }),
    row('heartbeat', 'skip', 'not recorded: no hook writes a heartbeat in this version', 'nothing to fix; if hooks seem inactive, run /reload-plugins or restart Claude Code'),
    binRow({ names, io, pluginRoot }),
    ...repo.rows,
    providersRow({ names, io }),
    schedulerRow({ names, io }),
    contextRow(info),
    permissionsRow({ names, io, repo: repo.worktree ?? null }), // the project settings of the checkout Claude Code runs in
    row('protection', 'skip', `${names.claimRefPrefix}* not checked: it needs gh, which this version does not run`,
      `with lanes on, check that the server's branch protection does not block ${names.claimRefPrefix}* (claims are pushed there)`),
  ];
  const all = [...envErrors, ...errors, ...side.errors, ...rowErrors];
  return {
    code: envErrors.length ? EXIT.ENV : all.length ? EXIT.FAIL : EXIT.OK,
    data: { checks, ...data, rows },
    errors: all,
    text: render(names.bin, checks, rows, all),
  };
}
