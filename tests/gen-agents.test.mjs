// AGENTS.md block (spec §7.19 NICE 1, SD-39, §7.14, GC9): a managed block between HTML comment markers in AGENTS.md,
// for agent harnesses other than Claude Code. Parsed, not compared as text (REV-56): the markers through the
// generator's own block parser, gate names and commands through CommonMark code spans, the CLI lines of the fenced
// block through the explicit npx form and the command table, rule IDs through the method index; the block holds no
// decision citation (it would fail `decisions check`) and stays within 60 lines. Lossless regeneration: the user's
// text outside the markers stays byte-identical and an edit inside survives a new version (3-way); a second run
// writes nothing. Commands: the capability is on while the profile names another harness; an explicit flag wins;
// gates come from the profile and the npx spec from name.json `repository` and the plugin version.
// This file never spells the codename: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// git (through lib/git and the launcher) runs with a throwaway HOME and global config, without the calling session.
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function locate() {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return { pluginDir: join(plugins, hits[0]), names: JSON.parse(readFileSync(join(plugins, hits[0], 'lib', 'name.json'), 'utf8')) };
}
const { pluginDir, names } = locate();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const gen = await lib('gen/index.mjs');
const { extract } = await lib('gen/block.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');
const { openMethod } = await lib('method/index.mjs');
const { citationPattern } = await lib('decisions/index.mjs');
const profileUnit = await lib('profile/index.mjs');
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));

const ID = 'agents-md';
const target = () => gen.TARGETS.find((x) => x.id === ID);
const SIDE = gen.sideSuffix(names);
const VERSION = '2.0.0';
// The npx package spec the commands use: the repository of name.json at the release tag of this plugin version.
const SPEC = `${names.repository}#${names.plugin}--v${PLUGIN_VERSION}`;
// Commands the block names that are not in the command table yet (the verify unit lands separately). Shrink only:
// the test below fails as soon as one of them exists, so the entry is removed then.
const PENDING = [];

const GATE_SETS = [
  [],
  [{ name: 'test', cmd: 'npm test' }],
  [
    { name: 'unit: "fast" \\ slow', cmd: 'npm test -- --grep "a: b" # not a comment' },
    { name: 'lint `strict`', cmd: "printf '%s\\n' \"$HOME\" | tr a-z A-Z && echo 'it''s'" },
    { name: 'types', cmd: '`which tsc` --noEmit && echo ``` && echo $GITHUB_SHA' },
  ],
  Array.from({ length: 20 }, (_, i) => ({ name: `gate-${i}`, cmd: `npm run gate-${i} -- --with-a-long-argument-list ${'x'.repeat(200)}` })),
];
const PACKAGES = [undefined, `github:example-org/example-repo#${names.plugin}--v2.0.0`];
const COMBINATIONS = GATE_SETS.flatMap((gates) => PACKAGES.map((pkg) => ({ ...gen.DEFAULT_OPTIONS, gates, ...(pkg ? { package: pkg } : {}) })));
const label = (o) => `gates=${o.gates.length} package=${o.package ?? '-'}`;

// CommonMark code spans of one line: a run of n backticks opens, the next run of exactly n closes; one space is
// stripped from each side when both are spaces and the content is not only spaces.
function codeSpans(line) {
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    let n = 0;
    while (line[i + n] === '`') n++;
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== '`') { j++; continue; }
      let m = 0;
      while (line[j + m] === '`') m++;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) { i += n; continue; }
    let content = line.slice(i + n, close);
    if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
    spans.push(content);
    i = close + n;
  }
  return spans;
}

// The sections of the block: "### <title>" → its lines.
function sections(block) {
  const out = new Map();
  let cur = null;
  for (const line of block.split('\n')) {
    const h = /^### (.+)$/.exec(line);
    if (h) { cur = h[1]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}
const sectionOf = (block, re) => {
  const hit = [...sections(block)].find(([title]) => re.test(title));
  assert.ok(hit, `a section matching ${re}`);
  return hit[1];
};

test('agents-md is a managed block in AGENTS.md with HTML comment markers; its template has its own directory', () => {
  const t = target();
  assert.ok(t, 'the generator knows the agents-md target');
  assert.deepEqual([t.capability, t.mode, t.path(names), t.template, t.fileMode], [ID, 'block', 'AGENTS.md', 'agents-md/AGENTS.md', 0o644]);
  assert.deepEqual(gen.blockMarkers(t, names), { begin: `<!-- ${names.codename}:begin -->`, end: `<!-- ${names.codename}:end -->` });
  assert.deepEqual(readdirSync(join(pluginDir, 'templates', 'agents-md')), ['AGENTS.md']);
  // templates/agents/ holds the plugin's subagent sources (scripts/gen-names.mjs renders each into agents/).
  assert.ok(!readdirSync(join(pluginDir, 'templates', 'agents')).includes('AGENTS.md'), 'not among the subagent sources');
});

test('the block parses for every option combination: markers, ≤ 60 lines, gates round-trip, explicit CLI lines', () => {
  const t = target();
  const always = openMethod().index.always;
  const rules = openMethod().index.rules;
  for (const o of COMBINATIONS) {
    const at = label(o);
    const block = gen.render(t, o, names);
    const file = gen.wrapBlock(t, names, block);
    // Markers: the generator's block parser finds exactly this block back.
    const x = extract(t, names, file);
    assert.deepEqual([x.state, x.block], ['ok', block], `${at}: one marker pair around the block`);
    assert.ok(file.split('\n').length - 1 <= 60, `${at}: ${file.split('\n').length - 1} lines with the markers (≤ 60)`);
    assert.match(block, /^## \S/, `${at}: a heading first`);
    const fences = block.split('\n').filter((l) => l.startsWith('```'));
    assert.ok(fences.length % 2 === 0, `${at}: fenced blocks are closed`);

    // Gates: one list item per gate, its name and command in code spans that round-trip exactly.
    const gateItems = sectionOf(block, /^Gates$/).filter((l) => l.startsWith('- '));
    if (o.gates.length) assert.deepEqual(gateItems.map(codeSpans), o.gates.map((g) => [g.name, g.cmd]), `${at}: gate names and commands`);
    else assert.equal(gateItems.length, 1, `${at}: one line saying no gate is recorded`);

    // Conventions: task and decision ID forms are named, and no decision ID is cited (decisions check reads every
    // tracked file).
    const conventions = sectionOf(block, /^Tasks and decisions$/).join('\n');
    assert.match(conventions, /`T-<handle>-<n>`/, at);
    assert.match(conventions, /`D-<handle>-<n>`/, at);
    if (o.gates === GATE_SETS[0] || o.gates === GATE_SETS[1]) assert.doesNotMatch(block, citationPattern(), `${at}: no decision citation`);

    // CLI lines: the fenced block holds one line per command, in the explicit npx form when a package spec is given.
    const cliLines = sectionOf(block, /CLI/);
    const open = cliLines.findIndex((l) => l.startsWith('```'));
    const close = cliLines.findIndex((l, i) => i > open && l.startsWith('```'));
    assert.ok(open >= 0 && close > open, `${at}: a fenced block of commands`);
    const prefix = o.package ? `npx --yes --package '${o.package}' ${names.bin} ` : `${names.bin} `;
    const used = cliLines.slice(open + 1, close).map((line) => {
      assert.ok(line.startsWith(prefix), `${at}: "${line}" starts with "${prefix}"`);
      const rest = line.slice(prefix.length);
      const known = [...COMMANDS.map((c) => c.name), ...PENDING].filter((n) => rest === n || rest.startsWith(`${n} `));
      assert.equal(known.length, 1, `${at}: "${rest}" names one command`);
      return known[0];
    });
    assert.deepEqual(used, ['verify', 'decisions check', 'rule'], `${at}: verify, decisions check and rule lookup`);
    const r = spawnSync('sh', ['-n'], { input: cliLines.slice(open + 1, close).join('\n'), encoding: 'utf8' });
    assert.equal(r.status, 0, `${at}: sh -n accepts the command lines\n${r.stderr}`);

    // Core rules: IDs only, exactly the always-on rules of the method index.
    const core = sectionOf(block, /^Core rules$/).join('\n');
    assert.deepEqual(core.match(/\b[A-Z]{3}-\d+\b/g), always, `${at}: the always-on rule IDs`);
    for (const id of always) assert.ok(!block.includes(rules[id].summary), `${at}: ${id} is a pointer, not its text`);
  }
});

test('the command lines name commands of the command table; pending ones are still missing from it (shrink only)', () => {
  for (const name of ['decisions check', 'rule']) assert.ok(COMMANDS.some((c) => c.name === name), name);
  for (const name of PENDING) assert.ok(!COMMANDS.some((c) => c.name === name), `${name} exists now: remove it from PENDING`);
});

test('packageSpec: the repository of name.json at the release tag <plugin>--v<version>; a valid generator option', () => {
  assert.equal(gen.packageSpec(names, '2.0.0'), `${names.repository}#${names.plugin}--v2.0.0`);
  assert.deepEqual(gen.checkOptions({ ...gen.DEFAULT_OPTIONS, package: gen.packageSpec(names, PLUGIN_VERSION) }), []);
});

test('targetFlags: agents-md is on while the profile names another harness; a flag set in the state wins', () => {
  assert.deepEqual(gen.targetFlags({}, {}), {});
  assert.deepEqual(gen.targetFlags({}, { otherHarnesses: [] }), {});
  assert.deepEqual(gen.targetFlags({}, { otherHarnesses: ['codex'] }), { [ID]: 'on' });
  assert.deepEqual(gen.targetFlags({ [ID]: 'off', ci: 'on' }, { otherHarnesses: ['codex'] }), { [ID]: 'off', ci: 'on' });
  assert.deepEqual(gen.targetFlags({ [ID]: 'on' }, {}), { [ID]: 'on' });
});

// ---------------------------------------------------------------------------------------------------------------
// Lossless regeneration of the block (spec §7.14 last paragraph, GC9).

let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 15, 0, 0, 0, tick++)).toISOString();
function workspace(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'gen-agents-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = gen.openStore(join(parent, names.stateDir), names);
  store.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: now() });
  return { root: parent, store };
}
const OPTS = (gates, pkg) => ({ ...gen.DEFAULT_OPTIONS, gates, ...(pkg ? { package: pkg } : {}) });
const items = (ws, options) => gen.targetItems({ root: ws.root, store: ws.store, names, options, targets: [target()] });
const applyIn = (ws, options) => gen.applyGen({ root: ws.root, store: ws.store, names, version: VERSION, items: items(ws, options), now });
const read = (ws) => readFileSync(join(ws.root, 'AGENTS.md'), 'utf8');
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      const st = lstatSync(p, { bigint: true });
      out[relative(dir, p)] = `${st.ino}:${st.mtimeNs}:${st.mode}:${st.size}${st.isDirectory() ? '' : `:${readFileSync(p).toString('base64')}`}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

test('block survival: text outside the markers stays byte-identical, an edit inside survives a new version', (t) => {
  const ws = workspace(t);
  const T = target();
  const { begin, end } = gen.blockMarkers(T, names);
  const v1 = OPTS([{ name: 'test', cmd: 'npm test' }], PACKAGES[1]);
  const v2 = OPTS([{ name: 'test', cmd: 'npm test' }, { name: 'lint', cmd: 'npm run lint' }], PACKAGES[1]);
  let r = applyIn(ws, v1);
  assert.deepEqual([r.results[0].action, r.written], ['create', ['AGENTS.md']]);
  assert.equal(read(ws), gen.wrapBlock(T, names, gen.render(T, v1, names)));

  // The user writes around the block (CRLF and no final newline too) and adds a line inside it.
  const head = '# My project\r\n\r\nOwn instructions for every agent.\n\n';
  const tail = '\n## Mine\nkeep me';
  const anchor = '### Tasks and decisions\n';
  const mine = '- Also name the ticket number in commit messages.\n';
  const inside = gen.render(T, v1, names).replace(anchor, `${anchor}${mine}`);
  writeFileSync(join(ws.root, 'AGENTS.md'), `${head}${begin}\n${inside}${end}\n${tail}`);

  r = applyIn(ws, v2);
  assert.equal(r.results[0].action, 'merge');
  const expected = gen.render(T, v2, names).replace(anchor, `${anchor}${mine}`);
  assert.equal(read(ws), `${head}${begin}\n${expected}${end}\n${tail}`, 'outside untouched, the user line kept, the new gate in');
  assert.ok(!existsSync(join(ws.root, `AGENTS.md${SIDE}`)));

  // Idempotence: the same version again writes nothing at all (files, modes, times, the state directory included).
  const before = snapshot(ws.root);
  r = applyIn(ws, v2);
  assert.deepEqual([r.results[0].action, r.written, r.manifest], ['unchanged', [], false]);
  assert.deepEqual(snapshot(ws.root), before);
});

test('an AGENTS.md written by the user before the first run stays; the block is proposed in the side file', (t) => {
  const ws = workspace(t);
  const T = target();
  const own = '# Agents\n\nRun `make check` before every commit.\n';
  writeFileSync(join(ws.root, 'AGENTS.md'), own);
  const o = OPTS([{ name: 'test', cmd: 'npm test' }]);
  const r = applyIn(ws, o);
  assert.deepEqual([r.results[0].action, r.ok], ['unknown-origin', false]);
  assert.equal(read(ws), own, 'the user file is byte-identical');
  assert.equal(readFileSync(join(ws.root, `AGENTS.md${SIDE}`), 'utf8'), `${own}${gen.wrapBlock(T, names, gen.render(T, o, names))}`);
  const before = snapshot(ws.root);
  applyIn(ws, o);
  assert.deepEqual(snapshot(ws.root), before, 'a second run writes nothing');
});

// ---------------------------------------------------------------------------------------------------------------
// The commands: `gen plan` / `gen apply` read the profile (gates, otherHarnesses) and the plugin version.

const LAUNCHER = join(pluginDir, 'bin', names.bin);
const cli = (args, cwd) => spawnSync(process.execPath, [LAUNCHER, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: ISO.env });
const show = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const envelope = (r) => {
  assert.equal(r.stderr, '', show(r));
  return JSON.parse(r.stdout);
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: ISO.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
function repo(t, { flags = {}, files = {} } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gen-agents-cli-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, '-c', 'init.defaultBranch=main', 'init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
  const store = gen.openStore(join(base, names.stateDir), names);
  store.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: now() });
  if (Object.keys(flags).length) store.write('config', null, { flags });
  git(base, 'add', '-A');
  git(base, 'commit', '-qm', 'base');
  return base;
}
const planned = (dir) => {
  const r = cli(['gen', 'plan', '--json'], dir);
  assert.equal(r.status, 0, show(r));
  return envelope(r).data.targets.map((x) => [x.id, x.action]);
};
const NODE_PROJECT = { 'package.json': `${JSON.stringify({ name: 'demo', scripts: { test: 'node --test', lint: 'eslint .' } })}\n` };

test('gen apply: another harness in the profile turns agents-md on; the block carries the profile gates and the npx spec', (t) => {
  const dir = repo(t, { files: { ...NODE_PROJECT, '.codex/config.toml': 'model = "x"\n' } });
  assert.deepEqual(planned(dir), [], 'nothing before the profile names a harness');
  let r = cli(['profile', 'observe', '--yes', '--json'], dir);
  assert.equal(r.status, 0, show(r));
  const profile = profileUnit.openStore(join(dir, names.stateDir), names).read('profile');
  assert.deepEqual(profile.facts.otherHarnesses.value, ['codex']);
  assert.ok(profile.gates.length >= 2, 'gates observed from package.json');

  assert.deepEqual(planned(dir), [[ID, 'create']]);
  r = cli(['gen', 'apply', '--yes', '--json'], dir);
  assert.equal(r.status, 0, show(r));
  assert.deepEqual(envelope(r).data.written, ['AGENTS.md']);
  const T = target();
  const options = { ...gen.DEFAULT_OPTIONS, gates: profile.gates.map((g) => ({ name: g.name, cmd: g.cmd })), package: SPEC };
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(text, gen.wrapBlock(T, names, gen.render(T, options, names)));
  for (const g of profile.gates) assert.ok(text.includes(`\`${g.cmd}\``), `gate ${g.cmd} listed`);
  assert.ok(text.includes(`npx --yes --package '${SPEC}' ${names.bin} decisions check\n`), 'the npx spec of name.json repository at this version');

  // A second run changes nothing; the existing AGENTS.md is now also observed as a harness.
  const before = snapshot(dir);
  r = cli(['gen', 'apply', '--yes', '--json'], dir);
  assert.equal(r.status, 0, show(r));
  assert.deepEqual(envelope(r).data.targets.map((x) => [x.id, x.action]), [[ID, 'unchanged']]);
  assert.deepEqual(snapshot(dir), before);
});

test('gen plan: no harness → agents-md off; an explicit flag wins over the profile in both directions', (t) => {
  const plain = repo(t, { files: NODE_PROJECT });
  assert.equal(cli(['profile', 'observe', '--yes', '--json'], plain).status, 0);
  assert.deepEqual(planned(plain), [], 'no other harness: not generated');

  const forced = repo(t, { flags: { [ID]: 'on' }, files: NODE_PROJECT });
  assert.deepEqual(planned(forced), [[ID, 'create']], 'flag on without a harness');

  const declined = repo(t, { flags: { [ID]: 'off' }, files: { ...NODE_PROJECT, 'GEMINI.md': '# Gemini\n' } });
  assert.equal(cli(['profile', 'observe', '--yes', '--json'], declined).status, 0);
  assert.deepEqual(planned(declined), [], 'flag off with a harness');
});

test('gen apply: a profile gate the generator cannot render stops the run with exit 1; nothing is written', (t) => {
  const dir = repo(t, { flags: { [ID]: 'on' } });
  const store = profileUnit.openStore(join(dir, names.stateDir), names);
  store.write('profile', null, { ...profileUnit.emptyProfile(), gates: [{ name: 'test', cmd: ' npm test', timeoutS: 600, kind: 'test' }] });
  const before = snapshot(dir);
  const r = cli(['gen', 'apply', '--yes', '--json'], dir);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(envelope(r).errors.map((e) => e.code), ['invalid-options']);
  assert.deepEqual(snapshot(dir), before);
});
