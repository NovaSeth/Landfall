#!/usr/bin/env node
// Generates every file that carries the plugin's published names from plugins/<plugin>/lib/name.json
// (SD-30, REV-54): .claude-plugin/marketplace.json, plugins/<plugin>/.claude-plugin/plugin.json, the
// launcher entry of package.json "bin" (other package.json fields stay as they are) and
// plugins/<plugin>/settings.json (subagentStatusLine), plugins/<plugin>/hooks/hooks.json (hooks from lib/hooks/registry.mjs, command prefix from the bin name), and the
// skills and agents, which name the CLI: templates/skills/<name>.md → skills/<name>/SKILL.md and
// templates/agents/<name>.md → agents/<name>.md, where "{{<key>}}" is a name.json value. Every file in skills/ and
// agents/ has a source; a file there without one is an error.
// A changed name also moves plugins/<old>/ and bin/<old> (git mv when tracked). The plugin version is
// package.json "version".
//
// Usage: node scripts/gen-names.mjs [--check] [--root <dir>]
//   --check       write nothing; list what is stale
//   --root <dir>  repository root (default: the repository holding this script)
// Exit: 0 up to date or written · 1 stale (--check) · 2 usage error, invalid name.json, plugin tree or template ·
// 70 internal error
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SLUG = /^[a-z][a-z0-9-]*$/;
const KEYS = {
  codename: SLUG,
  displayName: /^\S(.*\S)?$/,
  plugin: SLUG,
  marketplace: SLUG,
  bin: SLUG,
  stateDir: /^\.[a-z][a-z0-9-]*$/,
  envPrefix: /^[A-Z][A-Z0-9_]*_$/,
  claimRefPrefix: /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*\/$/,
  // The GitHub source of the plugin CLI for npx (SD-21, SD-39): github:<owner>/<repo>.
  repository: /^github:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
};
const DESCRIPTION = 'Sizes the process to each coding task and checks the outcome in code: a task is done only when its gates pass again.';
const OWNER = { name: 'NovaSeth', url: 'https://github.com/NovaSeth' };
const USAGE = 'usage: node scripts/gen-names.mjs [--check] [--root <dir>]\n';

class Invalid extends Error {}

// Plugin components rendered from templates/<kind>/<name><ext>; `existing` lists the names present in the plugin. Skills
// and agents are Markdown with frontmatter; the hooks module, its test and its state contract are code (templates named
// .tmpl so that neither the engine nor `claude plugin test` reads the unrendered source).
const listDir = (dir, keep) => (existsSync(dir) ? readdirSync(dir).filter(keep) : []);
const CODE = /\.(?:[cm]?[jt]sx?|d\.ts)$/;
const COMPONENTS = [
  { kind: 'skills', ext: '.md', output: (n) => `skills/${n}/SKILL.md`, existing: (p) => listDir(join(p, 'skills'), (d) => existsSync(join(p, 'skills', d, 'SKILL.md'))), render: renderComponent },
  { kind: 'agents', ext: '.md', output: (n) => `agents/${n}.md`, existing: (p) => listDir(join(p, 'agents'), (f) => f.endsWith('.md')).map((f) => f.slice(0, -3)), render: renderComponent },
  { kind: 'hooks', ext: '.tmpl', output: (n) => `hooks/${n}`, existing: (p) => listDir(join(p, 'hooks'), (f) => CODE.test(f)), render: renderCode },
  { kind: 'types', ext: '.tmpl', output: (n) => `types/${n}`, existing: (p) => listDir(join(p, 'types'), (f) => CODE.test(f)), render: renderCode },
];

// "{{<key>}}" → the name.json value.
function fill(text, names, sourceRel) {
  return text.replace(/\{\{([^{}]*)\}\}/g, (m, key) => {
    if (!Object.hasOwn(KEYS, key)) throw new Invalid(`${sourceRel}: unknown placeholder ${m} (known: ${Object.keys(KEYS).join(', ')})`);
    return names[key];
  });
}

// A Markdown component: the generated marker is a YAML comment after the opening "---", so it costs no context and the
// frontmatter stays valid.
function renderComponent(text, names, sourceRel) {
  if (!text.startsWith('---\n')) throw new Invalid(`${sourceRel}: must start with a "---" frontmatter block`);
  return fill(text, names, sourceRel).replace('---\n', `---\n# Generated from ${sourceRel} by scripts/gen-names.mjs; do not edit.\n`);
}

// A code component: the marker is the first line.
function renderCode(text, names, sourceRel) {
  return `// Generated from ${sourceRel} by scripts/gen-names.mjs; do not edit.\n${fill(text, names, sourceRel)}`;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw new Invalid(`${file}: ${err.message}`); }
};

function parseArgs(argv) {
  const opts = { check: false, help: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') opts.check = true;
    else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else if (argv[i] === '--root' && i + 1 < argv.length) opts.root = resolve(argv[++i]);
    else throw new Invalid(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
  }
  return opts;
}

// name.json is found by location, so the generator itself holds no plugin name.
function loadNames(root) {
  const plugins = join(root, 'plugins');
  const dirs = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  if (dirs.length !== 1) throw new Invalid(`expected exactly one plugins/*/lib/name.json under ${root}, found ${dirs.length}`);
  const file = join(plugins, dirs[0], 'lib', 'name.json');
  const names = readJson(file);
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw new Invalid(`${file}: expected a JSON object`);
  const problems = [
    ...Object.entries(KEYS).filter(([k, re]) => typeof names[k] !== 'string' || !re.test(names[k])).map(([k]) => `missing or invalid "${k}"`),
    ...Object.keys(names).filter((k) => !(k in KEYS)).map((k) => `unknown key "${k}"`),
  ];
  if (problems.length) throw new Invalid(`${file}: ${problems.join(', ')}`);
  return { names, dir: dirs[0] };
}

// Moves (in order) and file contents that make the tree match name.json.
async function plan(root) {
  const { names, dir } = loadNames(root);
  const pkg = readJson(join(root, 'package.json'));
  const pluginRel = `plugins/${names.plugin}`;
  const moves = [];
  if (dir !== names.plugin) moves.push([`plugins/${dir}`, pluginRel]);
  const binDir = join(root, 'plugins', dir, 'bin');
  const launchers = existsSync(binDir) ? readdirSync(binDir).filter((f) => !f.startsWith('.')) : [];
  if (launchers.length !== 1) throw new Invalid(`plugins/${dir}/bin must hold exactly one launcher, found ${launchers.length}`);
  if (launchers[0] !== names.bin) moves.push([`${pluginRel}/bin/${launchers[0]}`, `${pluginRel}/bin/${names.bin}`]);

  // `types` is the state contract of the hooks module (plugins/<plugin>/types/index.d.ts); `userConfig.dashboard` the pane's mode.
  const manifest = {
    name: names.plugin, version: pkg.version, description: DESCRIPTION, author: OWNER, license: pkg.license,
    types: './types/index.d.ts',
    userConfig: {
      dashboard: {
        type: 'string',
        title: 'Dashboard pane',
        description: `auto opens the ${names.displayName} dashboard beside the transcript when a session starts; command opens it only on /${names.plugin}:dashboard; off draws nothing and sets no status line.`,
        default: 'auto',
        options: ['auto', 'command', 'off'],
      },
    },
  };
  const marketplace = {
    name: names.marketplace,
    description: `${names.displayName} plugin marketplace.`,
    owner: OWNER,
    plugins: [{ name: names.plugin, source: `./${pluginRel}`, description: DESCRIPTION }],
  };
  // package.json: only the launcher entry is generated; entries pointing elsewhere stay.
  const oldBin = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  const bin = Object.fromEntries(Object.entries(oldBin).filter(([, target]) => !target.startsWith(`plugins/${dir}/bin/`)));
  bin[names.bin] = `${pluginRel}/bin/${names.bin}`;
  const files = new Map([
    ['.claude-plugin/marketplace.json', json(marketplace)],
    [`${pluginRel}/.claude-plugin/plugin.json`, json(manifest)],
    ['package.json', json({ ...pkg, bin })],
  ]);
  // hooks.json: exec form through the launcher, as Claude Code expands the plugin root (SD-44).
  const registry = join(root, 'plugins', dir, 'lib', 'hooks', 'registry.mjs');
  if (existsSync(registry)) {
    const { hooksConfig } = await import(pathToFileURL(registry).href);
    files.set(`${pluginRel}/hooks/hooks.json`, json(hooksConfig(`\${CLAUDE_PLUGIN_ROOT}/bin/${names.bin}`)));
  }
  // settings.json: the agent panel rows (subagentStatusLine) run through the launcher.
  files.set(`${pluginRel}/settings.json`, json({ subagentStatusLine: { type: 'command', command: `\${CLAUDE_PLUGIN_ROOT}/bin/${names.bin} ui rows` } }));
  const pluginPath = join(root, 'plugins', dir);
  for (const c of COMPONENTS) {
    const sources = listDir(join(pluginPath, 'templates', c.kind), (f) => f.endsWith(c.ext)).sort();
    for (const f of sources) {
      const sourceRel = `templates/${c.kind}/${f}`;
      files.set(`${pluginRel}/${c.output(f.slice(0, -c.ext.length))}`, c.render(readFileSync(join(pluginPath, sourceRel), 'utf8'), names, sourceRel));
    }
    for (const name of c.existing(pluginPath)) {
      if (!sources.includes(`${name}${c.ext}`)) throw new Invalid(`plugins/${dir}/${c.output(name)} has no source templates/${c.kind}/${name}${c.ext}; add the source or delete the file`);
    }
  }
  return { moves, files };
}

function move(root, from, to) {
  if (existsSync(join(root, to))) throw new Invalid(`cannot move ${from} to ${to}: target exists`);
  const tracked = spawnSync('git', ['ls-files', '--', from], { cwd: root, encoding: 'utf8' });
  if (tracked.status === 0 && tracked.stdout.trim()) {
    const r = spawnSync('git', ['mv', from, to], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Invalid(`git mv ${from} ${to}: ${r.stderr.trim()}`);
  } else {
    renameSync(join(root, from), join(root, to));
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  const { moves, files } = await plan(opts.root);
  const current = (rel) => (existsSync(join(opts.root, rel)) ? readFileSync(join(opts.root, rel), 'utf8') : null);
  if (opts.check) {
    const stale = [
      ...moves.map(([from, to]) => `move ${from} -> ${to}`),
      ...[...files].filter(([rel, content]) => current(rel) !== content).map(([rel]) => `regenerate ${rel}`),
    ];
    for (const line of stale) process.stdout.write(`stale: ${line}\n`);
    if (stale.length) process.stdout.write('run: node scripts/gen-names.mjs\n');
    return stale.length ? 1 : 0;
  }
  for (const [from, to] of moves) { move(opts.root, from, to); process.stdout.write(`moved ${from} -> ${to}\n`); }
  for (const [rel, content] of files) {
    if (current(rel) === content) continue;
    mkdirSync(dirname(join(opts.root, rel)), { recursive: true });
    writeFileSync(join(opts.root, rel), content);
    process.stdout.write(`wrote ${rel}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(err instanceof Invalid ? `gen-names: ${err.message}\n` : `gen-names: internal error: ${err.stack}\n`);
  process.exitCode = err instanceof Invalid ? 2 : 70;
});
