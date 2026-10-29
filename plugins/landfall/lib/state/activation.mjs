// Activation lifecycle (spec §7.2, SD-6, SD-7, SD-36, SC2, REV-58). A repository is unknown, declined or active
// (active: its state directory holds state.json).
//   activationStep: the rule the work skill follows. Trivial work never activates; a declined repository stays
//     vanilla for every class; an active one continues; otherwise a task of class standard or above activates.
//   activate (`init`): explicit activation, also after a decline, which it clears. All checks come first (git
//     email, handle, state directory, schema); then under the store lock .gitignore (local/, .*.tmp) and
//     state.json; then the developer's handle in team/<H>.json. --state-dir links an external directory by the
//     repository's real path in machine data; moving the state of an active repository is refused. A repeated
//     init writes nothing new.
//   decline: the opt-out, in machine data only; refused in an active repository (deactivate removes state).
//   deactivate: removes untracked state (a file tracked by git: refused with the git rm command, nothing
//     removed) or the link of an external directory (its files are kept), then records the opt-out.
// Context comes only from the arguments (target directory, env); a refusal writes nothing.
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { removeEmptyDirs, removeTree } from '../fsx/index.mjs';
import { git } from '../git/index.mjs';
import { checkWrite } from './document.mjs';
import { StateError, guarded } from './errors.mjs';
import { KINDS, LIMITS, PATTERNS } from './kinds.mjs';
import { readProjects, resolve, updateProject } from './resolve.mjs';
import { format, validate } from './schema.mjs';
import { open } from './store.mjs';
import { gitIdentity, handleCandidates, registerHandle } from './team.mjs';

const CLASSES = ['trivial', 'standard', 'critical'];
// The state directory's .gitignore: machine-local state and temporary files of interrupted atomic writes.
const IGNORED = ['local/', 'local.foreign-*/', '.*.tmp'];
const now = () => new Date().toISOString();
const inRepo = (where, names) => join(where.repo, names.stateDir);

// 'continue' | 'vanilla' | 'activate' for a resolved repository ({ active, declined }) and a task class.
export function activationStep(where, cls) {
  if (where?.active) return 'continue';
  if (!CLASSES.includes(cls)) throw new TypeError(`activationStep: the class must be one of ${CLASSES.join('|')}, got ${cls}`);
  if (where?.declined) return 'vanilla';
  return cls === 'trivial' ? 'vanilla' : 'activate';
}

// The directory init uses: --state-dir (relative to cwd; a directory or nothing yet) or the resolved one.
function target(where, options, cwd) {
  if (options.stateDir === undefined) return where.dir;
  const dir = resolvePath(cwd, String(options.stateDir));
  const errors = validate({ t: 'obj', f: { '--state-dir': { t: 'str', max: LIMITS.path, re: PATTERNS.absPath } } }, { '--state-dir': dir });
  if (errors.length) throw new StateError(errors[0].code, 'USAGE', errors[0].message);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new StateError('invalid-value', 'USAGE', `--state-dir: ${dir} is not a directory`, { hint: 'name a directory; a missing one is created' });
  return dir;
}

function ensureIgnored(store) {
  const text = store.readText('.gitignore');
  if (text === null) return store.createText('.gitignore', `${IGNORED.join('\n')}\n`);
  const lines = text.split(/\r?\n/);
  const missing = IGNORED.filter((line) => !lines.includes(line));
  if (missing.length) store.writeText('.gitignore', `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
  return missing.length > 0;
}

// `init`: { repo, dir, linked, activated, handle, registered }. options: { stateDir, handle } (CLI flags).
export function activate({ cwd, env, names, version, options = {}, at = now() } = {}) {
  return guarded(() => {
    const where = resolve({ cwd, env, names });
    const { name, email } = gitIdentity(where.repo, { env });
    if (!email) throw new StateError('email-required', 'USAGE', 'a git user.email is needed to register your handle', { hint: 'set it with: git config user.email <address>' });
    if (options.handle !== undefined) KINDS.team.path(options.handle);
    else if (handleCandidates(name, email).length === 0) throw new StateError('handle-required', 'USAGE', 'no handle can be derived from the git user.name or email', { hint: 'choose one with --handle <2-4 letters A-Z>' });
    const dir = target(where, options, cwd);
    if (dir !== where.dir && where.active) throw new StateError('already-active', 'FAIL', `${where.repo} is already active with its state in ${where.dir}`, { hint: `run '${names.bin} deactivate' first to move it` });
    const store = open(dir, { names });
    const kind = store.kind('state');
    const doc = { schema: kind.version, codename: names.codename, createdWith: version, activatedAt: at };
    checkWrite(kind, doc, { where: join(dir, kind.path()) });
    store.assertWritable();
    if (dir !== where.dir) updateProject({ repo: where.repo, dataDir: where.dataDir, names, patch: { stateDir: dir === inRepo(where, names) ? null : dir } });
    const activated = store.locked(() => {
      store.checks(kind, kind.path());
      ensureIgnored(store);
      return store.readText(kind.path()) === null && store.createText(kind.path(), format(kind.spec, doc));
    });
    const { handle, created } = registerHandle(store, { name, email, handle: options.handle, at });
    if (where.declined) updateProject({ repo: where.repo, dataDir: where.dataDir, names, patch: { declinedAt: null } });
    return { repo: where.repo, dir, linked: dir !== inRepo(where, names), activated, handle, registered: created };
  });
}

// `decline`: { repo, declinedAt, changed }; an earlier opt-out keeps its time.
export function decline({ cwd, env, names, at = now() } = {}) {
  return guarded(() => {
    const where = resolve({ cwd, env, names });
    if (where.active) throw new StateError('active', 'FAIL', `${where.repo} is active (state in ${where.dir})`, { hint: `'${names.bin} deactivate' removes its state and remembers the opt-out` });
    if (where.declined) return { repo: where.repo, declinedAt: readProjects(where.dataDir, names).projects[where.repo]?.declinedAt ?? null, changed: false };
    const entry = updateProject({ repo: where.repo, dataDir: where.dataDir, names, patch: { declinedAt: at } });
    return { repo: where.repo, declinedAt: entry.declinedAt, changed: true };
  });
}

// Removes the in-repository state directory when git tracks none of its files; true when it existed.
function removeState(where, env, names) {
  const store = open(where.dir, { names });
  store.abs(''); // the directory itself is no symbolic link
  if (!existsSync(where.dir)) return false;
  const rel = relative(where.repo, where.dir);
  const tracked = () => {
    const r = git(['ls-files', '-z', '--', rel], { cwd: where.repo, env });
    if (r.status !== 0) throw new StateError('git-failed', 'ENV', `git ls-files failed in ${where.repo}: ${r.stderr.trim() || r.error}`, { hint: 'run it inside a working git repository' });
    const files = r.stdout.split('\0').filter(Boolean);
    if (files.length) {
      throw new StateError('state-tracked', 'FAIL', `${files.length} file(s) under ${where.dir} are tracked by git; deactivate removes only untracked state`, {
        hint: `run 'git rm -r ${rel}' and commit it, then '${names.bin} deactivate' again`,
      });
    }
  };
  tracked();
  store.locked(() => {
    tracked();
    // state.json first: from then on the repository is inactive. The lock (local/lock*) goes with its release.
    for (const entry of store.entries('').sort((a, b) => (b === 'state.json') - (a === 'state.json'))) {
      if (entry !== 'local') removeTree(store.abs(entry));
    }
    for (const entry of store.entries('local')) if (!entry.startsWith('lock')) removeTree(store.abs(`local/${entry}`));
  });
  removeEmptyDirs(join(where.dir, 'local'), where.dir);
  removeEmptyDirs(where.dir, where.dir);
  return true;
}

// `deactivate`: { repo, dir, removed, unlinked, declinedAt }.
export function deactivate({ cwd, env, names, at = now() } = {}) {
  return guarded(() => {
    const where = resolve({ cwd, env, names });
    if (!where.dataDir) throw new StateError('no-machine-data', 'ENV', 'the machine data directory is unknown, so the opt-out cannot be remembered', { hint: 'set CLAUDE_PLUGIN_DATA or HOME' });
    const removed = where.linked ? false : removeState(where, env, names);
    const patch = { ...(where.linked ? { stateDir: null } : {}), ...(where.declined ? {} : { declinedAt: at }) };
    const entry = Object.keys(patch).length
      ? updateProject({ repo: where.repo, dataDir: where.dataDir, names, patch })
      : readProjects(where.dataDir, names).projects[where.repo];
    return { repo: where.repo, dir: where.dir, removed, unlinked: where.linked, declinedAt: entry?.declinedAt ?? null };
  });
}
