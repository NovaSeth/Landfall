// Generated targets (spec §7.14, §7.4 capabilities, §7.19 NICE 1): each target has an ID, the capability flag
// that enables it (config.json `flags`), its template under templates/, its path in the repository and how it is
// owned: `file` (the whole file is generated) or `block` (only the managed block, see block.mjs). The rendered text
// of a block target is the block content without markers. `locations` lists where an existing file is looked for,
// in the order GitHub reads CODEOWNERS (a CODEOWNERS file elsewhere would be ignored while one of these exists).
// The AGENTS.md block (SD-39) is for agent harnesses other than Claude Code: gate commands, task and decision ID
// conventions, the plugin CLI through npx, and the IDs of the always-on method rules (lib/method).
// Values reach the templates escaped for their format: YAML double-quoted strings, POSIX shell single quotes,
// Markdown code spans. Names come from lib/name.json, so no file here spells the codename.
import { readFileSync } from 'node:fs';
import { openMethod } from '../method/index.mjs';
import { assertOptions } from './options.mjs';
import { renderTemplate } from './template.mjs';

const AGENTS_MD = 'agents-md';

export const TARGETS = Object.freeze([
  Object.freeze({ id: 'ci', capability: 'ci-gate', template: 'ci/workflow.yml', mode: 'file', fileMode: 0o644, path: (names) => `.github/workflows/${names.codename}.yml` }),
  Object.freeze({ id: 'pre-push', capability: 'pre-push', template: 'githooks/pre-push', mode: 'file', fileMode: 0o755, path: () => '.githooks/pre-push' }),
  Object.freeze({ id: 'codeowners', capability: 'codeowners', template: 'codeowners/CODEOWNERS', mode: 'block', comment: '#', fileMode: 0o644, path: () => 'CODEOWNERS', locations: Object.freeze(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) }),
  Object.freeze({ id: 'pr-template', capability: 'pr-template', template: 'pr/pull_request_template.md', mode: 'file', fileMode: 0o644, path: () => '.github/pull_request_template.md' }),
  Object.freeze({ id: AGENTS_MD, capability: AGENTS_MD, template: 'agents-md/AGENTS.md', mode: 'block', comment: '<!--', commentEnd: '-->', fileMode: 0o644, path: () => 'AGENTS.md' }),
]);

export const sideSuffix = (names) => `.${names.codename}-new`;

// The capability flags that enable targets: config.json `flags`, where agents-md is on while the profile fact
// otherHarnesses names another harness (spec §7.19, SD-39); a value set in config.json wins either way.
export function targetFlags(flags, facts) {
  const harnesses = Array.isArray(facts?.otherHarnesses) ? facts.otherHarnesses : [];
  return harnesses.length ? { [AGENTS_MD]: 'on', ...flags } : { ...flags };
}

const yamlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const shellWord = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const regexLiteral = (s) => s.replace(/[.[\]*^$\\]/g, '\\$&');
function codeSpan(s) {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

let coreRules = null; // the always-on rule IDs of the method index, read once
const alwaysRules = () => (coreRules ??= openMethod().index.always.join(', '));

function view(options, names) {
  return {
    bin: names.bin,
    codename: names.codename,
    displayName: names.displayName,
    sideSuffix: sideSuffix(names),
    sideSuffixRegex: regexLiteral(sideSuffix(names)),
    branch: options.branch,
    branchYaml: yamlString(options.branch),
    hasGates: options.gates.length > 0,
    gates: options.gates.map((g) => ({ nameYaml: yamlString(g.name), cmd: g.cmd, nameShell: shellWord(g.name), cmdShell: shellWord(g.cmd), nameCode: codeSpan(g.name), cmdCode: codeSpan(g.cmd) })),
    hasPackage: options.package !== undefined,
    packageShell: options.package === undefined ? '' : shellWord(options.package),
    cli: options.package === undefined ? names.bin : `npx --yes --package ${shellWord(options.package)} ${names.bin}`,
    coreRules: alwaysRules(),
    hasOwners: options.owners.length > 0,
    owners: options.owners.join(' '),
  };
}

const source = (target) => readFileSync(new URL(`../../templates/${target.template}`, import.meta.url), 'utf8');

// The new version ("theirs") of a target for these options.
export function render(target, options, names) {
  assertOptions(options);
  return renderTemplate(source(target), view(options, names), `templates/${target.template}`);
}
