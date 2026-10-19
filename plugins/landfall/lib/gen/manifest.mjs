// The generator's record in the state directory (spec §5.1 `generated/`, §7.14, SD-35): one document,
// generated/manifest.json, written only through lib/state (lock, schema checks, atomic replace). Per target path:
//   target, template, templateVersion   what produced it; templateVersion is the plugin version last applied
//   baseSha256, base                    the last generated version ("base" of the 3-way merge) as its lines, and
//                                       its hash; both null while the file's origin is unknown (REV-57)
//   generatedAt                         when the base was last set
//   side                                the side file gen wrote and still awaits the user: { fileSha256 (the side
//                                       file's content), theirsSha256 (the generated version it proposes), at }
//   pending (optional)                  write-ahead intent of a run (findings-r1 5), recorded before its file
//                                       writes and replaced by the committed entry after them: { preSha256 /
//                                       resultSha256 (the target before / after; null = absent / not written),
//                                       sideSha256 (side file written; null = none), removeSide, theirsSha256,
//                                       advance (the base becomes theirs), templateVersion, at }
// Base content lives inside this one document rather than in separate files, so a base and its record are
// replaced in one atomic write and can never disagree. State strings carry no control characters, so the base
// is stored as its lines (the text split on "\n"); generator options are checked to the same rule.
import { createHash } from 'node:crypto';
import { KINDS, PATTERNS, defineKind, open } from '../state/index.mjs';

const sha256 = { t: 'str', max: 64, re: PATTERNS.sha256 };
const REL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/;

export const MANIFEST = defineKind('generated', 1, {
  dir: 'generated',
  file: () => 'generated/manifest.json',
  match: /^generated\/manifest\.json$/,
  fields: {
    files: {
      t: 'map',
      max: 64,
      key: { t: 'str', max: 200, re: REL_PATH },
      v: {
        t: 'obj',
        f: {
          target: { t: 'str', max: 40, re: PATTERNS.kebab },
          template: { t: 'str', min: 1, max: 120 },
          templateVersion: { t: 'str', max: 40, re: PATTERNS.semver },
          baseSha256: { ...sha256, null: true },
          generatedAt: { t: 'time' },
          side: { t: 'obj', null: true, f: { fileSha256: sha256, theirsSha256: sha256, at: { t: 'time' } } },
          base: { t: 'arr', max: 20000, null: true, of: { t: 'str', max: 4096 } },
          pending: {
            t: 'obj',
            f: {
              preSha256: { ...sha256, null: true },
              resultSha256: { ...sha256, null: true },
              sideSha256: { ...sha256, null: true },
              removeSide: { t: 'enum', of: [true, false] },
              theirsSha256: sha256,
              advance: { t: 'enum', of: [true, false] },
              templateVersion: { t: 'str', max: 40, re: PATTERNS.semver },
              at: { t: 'time' },
            },
          },
        },
        opt: ['pending'],
      },
    },
  },
});

export const GEN_KINDS = Object.freeze({ ...KINDS, generated: MANIFEST });

// The state store of `dir` (from lib/state resolve) with the generator's kind added.
export const openStore = (dir, names) => open(dir, { names, kinds: GEN_KINDS });

export const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// The manifest document ({ schema, files }); an absent one is empty. Newer or invalid state throws StateError.
export function readManifest(store) {
  return store.read('generated', null) ?? { schema: MANIFEST.version, files: {} };
}

// The base text of an entry, or null when the entry has no base or its base fails its hash (then the file's
// origin is unknown: the safest reading, REV-57).
export function baseOf(entry) {
  if (!entry || entry.base === null || entry.baseSha256 === null) return null;
  const text = entry.base.join('\n');
  return sha(text) === entry.baseSha256 ? text : null;
}

// A committed entry (no pending intent); generatedAt moves only with the base.
export function makeEntry({ target, version, base, side, at, previous }) {
  const keepBase = previous && baseOf(previous) === base;
  return {
    target: target.id,
    template: target.template,
    templateVersion: version,
    baseSha256: base === null ? null : sha(base),
    generatedAt: keepBase ? previous.generatedAt : at,
    side,
    base: base === null ? null : base.split('\n'),
  };
}
