// `<bin> gen plan` and `<bin> gen apply [--dry-run] [<target>…]` (spec §7.14, §7.14a, §7.19, §8.2, SD-35, SD-39):
// generated files of the repository at the current directory. Targets: the named ones, else those whose capability
// flag is on (config.json flags; agents-md also while the profile names another harness, lib/gen targetFlags) and
// those already generated (recorded in the manifest; an entry of an unknown target or at a path its target does not
// declare is refused, manifest-path-refused). Options: the gates of the project profile (lib/profile), the
// npx spec of this plugin version (name.json repository), owners and branch from the generator defaults. `gen plan`
// is `gen apply --dry-run`; neither needs consent (they write nothing).
// Exit 0 every target generated, merged or unchanged · 1 a target needs the user (unknown origin, conflict, lost
// hunk, side file edited or foreign, unsafe path, not text, broken block markers), or a profile gate cannot be
// rendered · 2 unknown target · 7 inactive repository, newer state, no consent · 8 not a git repository, git
// missing, a file could not be written.
import { DEFAULT_OPTIONS, TARGETS, applyGen, blockMarkers, checkOptions, openStore, packageSpec, readManifest, targetFlags, targetItems } from '../gen/index.mjs';
import { emptyProfile, factValues, openStore as openProfileStore } from '../profile/index.mjs';
import { StateError, resolve } from '../state/index.mjs';
import { EXIT } from './commands.mjs';

const FS_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EISDIR', 'ENOTDIR', 'EFSUNSUPPORTED']);

export const genPlan = (ctx) => gen(ctx, { dryRun: true, command: 'gen plan' });
export const genApply = (ctx) => gen(ctx, { dryRun: Boolean(ctx.flags.dryRun), command: 'gen apply' });

// The error of a target that needs the user, with the step that clears it.
function problem(r, target, names) {
  const merge = `merge what you want from ${r.sideFile} into ${r.path}, then delete ${r.sideFile}`;
  switch (r.action) {
    case 'unknown-origin': return { message: `${r.path} was not generated here; the generated version goes to ${r.sideFile}`, hint: merge };
    case 'conflict': return { message: `${r.path}: your edits overlap the new version, which goes to ${r.sideFile}`, hint: merge };
    case 'lost-hunk': return { message: `${r.path}: merging would drop one of your edits; the new version goes to ${r.sideFile}`, hint: merge };
    case 'side-modified': return { message: `${r.sideFile} was edited; ${r.path} stays as it is until you finish merging`, hint: `merge ${r.sideFile} into ${r.path}, then delete ${r.sideFile}` };
    case 'side-foreign': return { message: `${r.sideFile} exists and was not written by ${names.bin}; nothing was written for ${r.path}`, hint: `move ${r.sideFile} away, then run again` };
    case 'held': return { message: `${r.path}: not written, because another path of this run is unsafe`, hint: 'fix the unsafe path named in the other error, then run again' };
    case 'unsafe': return { message: `${r.path}: a symbolic link or a non-regular file is on its path; nothing was written`, hint: 'replace it with a plain directory or file, then run again' };
    case 'not-text': return { message: `${r.path} is not UTF-8 text; nothing was written`, hint: 'restore it as text or move it away, then run again' };
    default: {
      const { begin, end } = blockMarkers(target, names);
      return { message: `${r.path}: the "${begin}" and "${end}" lines are missing, repeated or out of order; nothing was written`, hint: 'leave exactly one pair of marker lines, or none, then run again' };
    }
  }
}

function gen({ args, flags: given, names, version, io }, { dryRun, command }) {
  const ids = [...new Set(args.target ?? [])];
  const unknown = ids.find((id) => !TARGETS.some((t) => t.id === id));
  if (unknown !== undefined) {
    return { code: EXIT.USAGE, errors: [{ code: 'unknown-target', message: `unknown target: ${unknown}`, hint: `targets: ${TARGETS.map((t) => t.id).join(', ')}` }] };
  }
  const commit = given.commit;
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
    return { code: EXIT.USAGE, errors: [{ code: 'invalid-commit', message: '--commit needs 40 lowercase hex digits (a full commit SHA)', hint: 'for example: git rev-parse <tag>^{commit}' }] };
  }
  try {
    const where = resolve({ cwd: io.cwd, env: io.env, names });
    if (!where.active) {
      return { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${where.repo} is not active; nothing is generated in a repository before work starts there`, hint: `activate the repository (${names.bin} init), then run again` }] };
    }
    const store = openStore(where.dir, names);
    const profile = openProfileStore(where.dir, names).read('profile') ?? emptyProfile();
    const options = { ...DEFAULT_OPTIONS, gates: profile.gates.map(({ name, cmd }) => ({ name, cmd })), package: packageSpec(names, version, commit) };
    const invalid = checkOptions(options);
    if (invalid.length) {
      return { code: EXIT.FAIL, errors: [{ code: 'invalid-options', message: `the profile gates or the plugin version cannot go into a generated file: ${invalid[0].message}`, hint: `fix that gate in the profile (${names.bin} profile show lists the gates), then run again` }] };
    }
    const flags = targetFlags(store.read('config', null)?.flags ?? {}, factValues(profile));
    const managed = new Set(Object.values(readManifest(store).files).map((e) => e.target));
    const targets = TARGETS.filter((t) => (ids.length ? ids.includes(t.id) : flags[t.capability] === 'on' || managed.has(t.id)));
    const items = targetItems({ root: where.repo, store, names, options, targets });
    const report = applyGen({ root: where.repo, store, names, version, items, dryRun, env: io.env });
    const errors = report.results.filter((r) => !r.ok).map((r) => ({ code: r.action === 'unsafe' ? 'manifest-path-refused' : r.action, ...problem(r, TARGETS.find((t) => t.id === r.id), names) }));
    const head = `${command}${dryRun ? ' (dry run: nothing written)' : ''}`;
    const rows = report.results.map((r) => `  ${r.action.padEnd(15)} ${r.path}${r.sideFile ? ` → ${r.sideFile}` : ''}`);
    const none = targets.length ? [] : [`  no target is enabled; name one (${TARGETS.map((t) => t.id).join(', ')}) or turn its capability flag on`];
    return {
      code: report.ok ? EXIT.OK : EXIT.FAIL,
      data: { dryRun, targets: report.results, written: report.written, removed: report.removed, manifest: report.manifest },
      errors,
      text: `${[head, ...rows, ...none].join('\n')}\n`,
    };
  } catch (err) {
    if (err instanceof StateError) return { code: EXIT[err.exit], errors: [err] };
    if (err?.code === 'ERACED') return { code: EXIT.FAIL, errors: [{ code: 'target-appeared', message: err.message, hint: 'check the new file, then run again' }] };
    if (FS_ERRORS.has(err?.code)) return { code: EXIT.ENV, errors: [{ code: 'write-failed', message: `cannot write a generated file: ${err.message}`, hint: 'fix the permissions or free space, then run again' }] };
    throw err;
  }
}
