// Generator options (spec §7.14 step 1: "template + profile"): the profile-derived values a template uses. They
// are checked with the state unit's field validator (one rule for strings: no control, zero-width or bidi
// characters, length limits), so a rendered file never holds a character the base store refuses.
//   gates   [{ name, cmd }]  gate commands (profile `gates[]`): CI steps, pre-push checks, PR checklist items
//   owners  [string]         CODEOWNERS owners: @user, @org/team or an e-mail address
//   branch  string           the protected branch CI runs on for pushes
//   package string, optional the npx package spec of this plugin for CI steps (SD-21), e.g.
//                            github:<owner>/<repo>#<plugin>--v<version>, or #<40-hex commit> to pin a commit;
//                            without it CI runs no plugin command
// Values are trimmed single lines; neither a gate name nor a gate command can hold a GitHub Actions expression
// (`${{`): a command is pasted into a `run:` script, where an expression is script injection (audit 2.4.0, G3).
// A package spec is a GitHub spec (owner/repo and a #ref that is a release tag or a full commit SHA, never a
// branch) or an npm name with an optional version, nothing else.
import { check } from '../state/index.mjs';

export const DEFAULT_OPTIONS = Object.freeze({ gates: Object.freeze([]), owners: Object.freeze([]), branch: 'main' });

const TRIMMED = '\\S(?:.*\\S)?';
const RELEASE_REF = '[a-z0-9][a-z0-9-]*--v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';
const COMMIT = /^[0-9a-f]{40}$/;
const SPEC = {
  t: 'obj',
  f: {
    gates: {
      t: 'arr',
      max: 20,
      of: {
        t: 'obj',
        f: {
          name: { t: 'str', min: 1, max: 40, re: new RegExp(`^(?!.*\\$\\{\\{)${TRIMMED}$`) },
          cmd: { t: 'str', min: 1, max: 300, re: new RegExp(`^${TRIMMED}$`) },
        },
      },
    },
    owners: { t: 'arr', max: 20, of: { t: 'str', max: 100, re: /^(?:@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,60})?|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/ } },
    branch: { t: 'str', min: 1, max: 100, re: /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*[/.]$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/ },
    package: { t: 'str', max: 300, re: new RegExp(`^(?:github:[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}#(?:${RELEASE_REF}|[0-9a-f]{40})|(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]{0,213}(?:@[A-Za-z0-9._+-]{1,64})?)$`) },
  },
  opt: ['package'],
};

// The npx package spec of this plugin at a version (SD-21): name.json `repository` at the release tag
// <plugin>--v<version>, such as github:<owner>/<repo>#<plugin>--v2.0.0.
// With a commit (40 lowercase hex digits) the spec pins that commit instead of the tag, which can be moved.
export function packageSpec(names, version, commit) {
  if (commit === undefined) return `${names.repository}#${names.plugin}--v${version}`;
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new Error('generator options: the commit to pin must be 40 lowercase hex digits');
  return `${names.repository}#${commit}`;
}

// [{ path, code, message }]; empty when the options are valid.
export function checkOptions(options) {
  const errors = check({ spec: SPEC }, options);
  const gates = Array.isArray(options?.gates) ? options.gates : [];
  gates.forEach((g, i) => {
    if (typeof g?.cmd === 'string' && g.cmd.includes('${{')) {
      const name = JSON.stringify(String(g.name ?? '').slice(0, 40));
      errors.push({ path: `gates[${i}].cmd`, code: 'expression', message: `gate ${name}: the command holds "\${{", a GitHub Actions expression that would run as script in CI; read the value from an environment variable instead` });
    }
  });
  return errors;
}

export function assertOptions(options) {
  const errors = checkOptions(options);
  if (errors.length) throw new Error(`generator options: ${errors[0].message}`);
}
