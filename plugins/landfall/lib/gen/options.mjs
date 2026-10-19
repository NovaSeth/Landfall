// Generator options (spec §7.14 step 1: "template + profile"): the profile-derived values a template uses. They
// are checked with the state unit's field validator (one rule for strings: no control, zero-width or bidi
// characters, length limits), so a rendered file never holds a character the base store refuses.
//   gates   [{ name, cmd }]  gate commands (profile `gates[]`): CI steps, pre-push checks, PR checklist items
//   owners  [string]         CODEOWNERS owners: @user, @org/team or an e-mail address
//   branch  string           the protected branch CI runs on for pushes
//   package string, optional the npx package spec of this plugin for CI steps (SD-21), e.g.
//                            github:<owner>/<repo>#<plugin>--v<version>; without it CI runs no plugin command
// Values are trimmed single lines; a gate name cannot hold a GitHub Actions expression (`${{`), a command can.
// A package spec is a GitHub spec (owner/repo, optional #ref) or an npm name with an optional version, nothing else.
import { check } from '../state/index.mjs';

export const DEFAULT_OPTIONS = Object.freeze({ gates: Object.freeze([]), owners: Object.freeze([]), branch: 'main' });

const TRIMMED = '\\S(?:.*\\S)?';
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
    package: { t: 'str', max: 300, re: /^(?:github:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:#[A-Za-z0-9._/-]{1,100})?|(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}(?:@[A-Za-z0-9._+-]{1,64})?)$/ },
  },
  opt: ['package'],
};

// The npx package spec of this plugin at a version (SD-21): name.json `repository` at the release tag
// <plugin>--v<version>, such as github:<owner>/<repo>#<plugin>--v2.0.0.
export const packageSpec = (names, version) => `${names.repository}#${names.plugin}--v${version}`;

// [{ path, code, message }]; empty when the options are valid.
export const checkOptions = (options) => check({ spec: SPEC }, options);

export function assertOptions(options) {
  const errors = checkOptions(options);
  if (errors.length) throw new Error(`generator options: ${errors[0].message}`);
}
