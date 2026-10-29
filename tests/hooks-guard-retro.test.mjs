// Bash guard after the Pinwall retro (2026-10 §4.1): the idioms an orchestrator writes all day pass, and what they
// stood in for still blocks. Two baskets of lines modelled on the 172 blocks of that project: "must pass" (reads, data
// that names the state, literal variables, a cd before a read, script arguments, a pipe after a --json command) and
// "must block" (writes into the state through the same idioms, removals, code that writes). The verdicts come from the
// hook registry with an injected active repository. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv({ identity: false });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { runHook } = await lib('hooks/registry.mjs');
const { expandLiterals } = await lib('guard/tokenizer.mjs');
const state = await lib('state/index.mjs');
const S = names.stateDir; // the in-repo state directory, as the lines of that project spelled it
const BIN = names.bin;

// An active repository on a branch with a task, a report and a decision in its state directory, src/ and docs/.
function repo() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'guard-retro-')));
  const git = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('switch', '-q', '-c', 'task/T-AB-1-x');
  const store = state.open(join(d, S), { names });
  const at = '2026-10-22T10:00:00.000Z';
  store.write('state', null, { codename: names.codename, createdWith: '2.1.0', activatedAt: at });
  state.registerHandle(store, { name: 'Dev AB', email: 'ab@example.com', handle: 'AB' });
  store.write('task', 'T-AB-1', { id: 'T-AB-1', kind: 'task', title: 'x', lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [{ at, by: 'AB', event: 'created', data: {} }], base: null, branch: null });
  for (const [rel, text] of [[`${S}/tasks/T-AB-1/report.md`, '---\n---\nStatus: DONE\n'], [`${S}/tasks/T-AB-1/brief.md`, '# brief\n'], [`${S}/decisions/D-AB-1.md`, '---\nid: D-AB-1\nstatus: active\n---\n\nbody\n'],
    ['src/a.js', 'x\n'], ['src/old.js', 'x\n'], ['docs/a.md', '# a\n'], ['scripts/fs-comment.mjs', 'process.exit(0)\n'], ['notes.md', 'x\n'],
    // the plugin's launcher as a checkout holds it (trusted through the environment below), the same bytes in a copy that
    // is not trusted, and two scripts named like the CLI that are not it (2.2.1)
    [`plugins/x/bin/${BIN}`, readFileSync(join(pluginDir, 'bin', BIN), 'utf8')], [`copy/bin/${BIN}`, readFileSync(join(pluginDir, 'bin', BIN), 'utf8')],
    [`evil/bin/${BIN}`, '#!/bin/sh\necho evil\n'], [`tools/${BIN}`, '#!/bin/sh\necho tool\n']]) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  // a planted launcher with the running plugin's lib linked beside it (2.2.1: a sibling directory proves nothing)
  mkdirSync(join(d, 'linked', 'bin'), { recursive: true });
  writeFileSync(join(d, 'linked', 'bin', BIN), '#!/bin/sh\necho linked\n');
  symlinkSync(join(pluginDir, 'lib'), join(d, 'linked', 'lib'));
  // T-MG-95: a plugin root that holds this plugin's name.json is no proof either: a checkout's code is the project's own
  mkdirSync(join(d, 'plugins', 'planted', 'bin'), { recursive: true });
  mkdirSync(join(d, 'plugins', 'planted', 'lib'), { recursive: true });
  writeFileSync(join(d, 'plugins', 'planted', 'lib', 'name.json'), readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
  writeFileSync(join(d, 'plugins', 'planted', 'bin', BIN), '#!/bin/sh\necho planted\n');
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'tracked');
  return d;
}
const DIR = repo();
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const blocks = [];
function judge(command, cwd = DIR) {
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  // the operator trusts the checkout's launcher through the session's environment (2.2.1)
  const r = runHook('guard-bash', input, { deadline: Infinity, env: { ...process.env, CLAUDE_PROJECT_DIR: DIR, [`${names.envPrefix}LAUNCHERS`]: `${DIR}/plugins/x/bin/${BIN}` }, readProjectMode: () => 'solo', shadowLog: (e) => blocks.push(e) });
  if (r.code === 2) return { deny: true, reason: r.stderr.trim() };
  if (!r.stdout) return { deny: false, reason: '' };
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return { deny: o.permissionDecision === 'deny', reason: o.permissionDecisionReason ?? '' };
}

// [line, what it stood in for]
const MUST_PASS = [
  // literal variables assigned in the same line
  [`F=${S}/tasks/T-AB-1/report.md; grep -n Status "$F"`, 'a path in a variable, then a read of it'],
  [`F=${S}/tasks/T-AB-1/report.md; head -5 $F`, 'the same, unquoted'],
  [`T=T-AB-1; ${BIN} task show "$T" --json`, 'a task ID in a variable'],
  // 2.2.1: `time` before the own command; the launcher by its path is the own command, whatever its arguments
  [`time ${BIN} status --json`, 'time before the own command'],
  [`time -p plugins/x/bin/${BIN} task show T-AB-1`, 'time -p before the launcher by path'],
  [`plugins/x/bin/${BIN} commit --yes`, 'the launcher by a relative path with the commit command'],
  [`./plugins/x/bin/${BIN} report T-AB-1 --from notes.md --yes`, 'the launcher by ./ with the report command'],
  [`${DIR}/plugins/x/bin/${BIN} commit --message "state: T-AB-1 done" --yes`, 'the trusted launcher by an absolute path'],
  [`${pluginDir}/bin/${BIN} commit --yes`, 'the launcher of the running plugin itself, by its path'],
  [`node ${pluginDir}/bin/${BIN} report T-AB-1 --from notes.md --yes`, 'the same behind node'],
  [`node plugins/x/bin/${BIN} commit --yes`, 'the launcher behind node'],
  [`plugins/x/bin/${BIN} verify T-AB-1 --yes > out.txt 2>&1; echo $?`, 'the launcher running a gate, its output to a file'],
  [`W=${DIR}/src; cd "$W" && cat a.js`, 'a worktree path in a variable, then cd'],
  [`for t in T-AB-1 T-AB-2; do ${BIN} task show "$t" --json; done`, 'a for loop over literal IDs'],
  [`for f in src/a.js src/old.js; do git log --oneline -1 -- "$f"; done`, 'a for loop over literal paths with git'],
  // the state named in data, not written
  [`curl -s -X POST http://localhost:1234/api -d '{"path": "${S}/tasks/T-AB-1/brief.md"}'`, 'JSON naming a state path'],
  [`sed 's/old/${S.replace(/\//g, '\\/')}\\/x/' notes.md`, 'a sed substitution naming the state'],
  [`grep -rn "${S}/tasks" docs/`, 'a grep for the state path'],
  [`echo "the brief is in ${S}/tasks/T-AB-1/brief.md"`, 'an echo naming the state'],
  [`cp ${S}/tasks/T-AB-1/brief.md /tmp/brief-copy.md`, 'a copy out of the state'],
  [`cat ${S}/tasks/T-AB-1/report.md`, 'a plain read'],
  // a sentence with a guarded word goes to the own command, not to a script (the argument invariant keeps script arguments guarded)
  [`${BIN} task set T-AB-1 status-request --note "review done, no stash left (see notes); commit abc fixed the push bug"`, 'a note with commit, push and stash in it'],
  // a pipe after the own command with --json
  [`${BIN} secrets --json | head -c 200`, 'the exit code is in the envelope'],
  [`${BIN} verify T-AB-1 --json | head -c 300`, 'the same for verify'],
  // cd then a read, with ; instead of &&
  [`cd src; cat ../${S}/tasks/T-AB-1/report.md`, 'a cd with ; before a read of the state'],
  [`cat ${S}/tasks/T-AB-1/report.md | grep -v "^$"`, 'a literal $ before the closing quote (an empty-line filter)'],
  [`grep -c "Status: DONE$" ${S}/tasks/T-AB-1/report.md`, 'a literal $ as an end anchor'],
  [`cd src; ls`, 'a cd with ; before a plain command'],
  // git -C placed
  [`git -C ${DIR} rm --cached src/old.js`, 'git rm in another directory, outside the state'],
  [`git -C ${DIR} log --oneline -3`, 'git log in another directory'],
  [`node -e "console.log(JSON.stringify({ status: 1 }))"`, 'inline code with a common word'],
];

const MUST_BLOCK = [
  [`cp /tmp/report.md ${S}/tasks/T-AB-1/report.md`, 'FLW-7', 'a copy into the state'],
  [`sed -i '' 's/a/b/' ${S}/tasks/T-AB-1/task.json`, 'FLW-7', 'sed in place on a state record'],
  [`sed 's/a/b/w ${S}/tasks/T-AB-1/task.json' notes.md`, 'FLW-7', 'a sed w command writing into the state'],
  [`F=${S}/tasks/T-AB-1/task.json; echo x > "$F"`, 'FLW-7', 'a write through a variable'],
  [`F=${S}/tasks/T-AB-1/task.json; cp /tmp/x "$F"`, 'FLW-7', 'a copy through a variable'],
  [`for f in ${S}/tasks/T-AB-1/task.json; do rm "$f"; done`, 'FLW-7', 'a removal in a for loop'],
  [`cd ${S}; rm tasks/T-AB-1/task.json`, 'FLW-7', 'a removal after a cd into the state'],
  [`cd src; rm ../${S}/tasks/T-AB-1/task.json`, 'FLW-7', 'a removal after a cd with ;'],
  [`node -e "require('fs').writeFileSync('${S}/tasks/T-AB-1/task.json', '{}')"`, 'FLW-7', 'code that writes into the state'],
  [`curl -o ${S}/tasks/T-AB-1/report.md http://localhost/x`, 'FLW-7', 'a download into the state'],
  [`curl --output=${S}/tasks/T-AB-1/report.md http://localhost/x`, 'FLW-7', 'the same with --output='],
  [`git -C ${DIR} rm ${S}/tasks/T-AB-1/task.json`, 'FLW-7', 'git rm of a state record in another directory'],
  [`${BIN} secrets | tail -1`, 'SEC-6', 'a pipe after the secrets scan without --json'],
  ['cd src; git stash', 'ORC-13', 'stash after a cd'],
  ['S=stash; git $S', 'ORC-13', 'the subcommand from a literal variable is read and still blocked'],
  ['G="git stash"; $G', 'SEC-3', 'a command from a variable has no shape'],
  ['x=ls; $x src', 'SEC-3', 'the command name from a variable'],
  ['s=list; printf -v s push; git stash "$s"', 'SEC-3', 'a variable changed another way is no literal'],
  ['X=stash; X=list; git stash "$X"', 'SEC-3', 'a variable assigned twice is no literal'],
  [`cp ${S}/tasks/T-AB-1/brief.md ${S}/tasks/T-AB-1/report.md`, 'FLW-7', 'a copy whose destination is the state'],
  [`cp -t ${S}/tasks/T-AB-1 /tmp/report.md`, 'FLW-7', 'a copy with -t into the state'],
  [`mv ${S}/tasks/T-AB-1/brief.md /tmp/x`, 'FLW-7', 'a move out of the state removes a document'],
  [`sed -i 's/.*/x/' ${S}/decisions/D-AB-1.md`, 'PRI-8', 'in place on a decision record'],
  [`rm -rf src`, 'PRI-17', 'a tracked directory removed'],
  [`echo "$HOME" > ${S}/tasks/T-AB-1/report.md`, 'SEC-3', 'a real expansion inside quotes still has no shape'],
  [`echo "${'$'}{S}" > ${S}/tasks/T-AB-1/report.md`, 'SEC-3', 'a brace expansion inside quotes too'],
  [`echo "$\\\nHOME" > ${S}/tasks/T-AB-1/report.md`, 'SEC-3', 'a line continuation after the dollar joins it to a name'],
  [`echo "$[1+1]" > ${S}/tasks/T-AB-1/report.md`, 'SEC-3', 'the old arithmetic form'],
  // review r1 F1: sed programs that write the file they name, glued or behind an option
  [`sed -n 'w${S}/tasks/T-AB-1/task.json' notes.md`, 'FLW-7', 'a w command with no blank'],
  [`sed -n 's/a/b/w${S}/tasks/T-AB-1/task.json' notes.md`, 'FLW-7', 'the w flag of s with no blank'],
  [`sed -n --expression='w ${S}/tasks/T-AB-1/task.json' notes.md`, 'FLW-7', 'the program behind --expression='],
  [`sed -n -e'w ${S}/tasks/T-AB-1/task.json' notes.md`, 'FLW-7', 'the program glued to -e'],
  [`sed -n -ew${S}/tasks/T-AB-1/task.json notes.md`, 'FLW-7', 'the program glued to -e without a blank'],
  [`sed -f script.sed ${S}/tasks/T-AB-1/task.json`, 'FLW-7', 'a script file the guard cannot read, on a state path'],
  // review r1 F2: --json after -- belongs to the wrapped command, not to the envelope
  [`${BIN} heavy -- npm test --json | tail -3`, 'TRP-2', 'a pipe after heavy with the inner command\'s --json'],
  [`${BIN} heavy --json -- npm test | tail -3`, 'TRP-2', 'heavy itself gets no --json leniency'],
  // the security review of the literal variables: conditional assignments and special names are no literals
  [`true || F=/tmp/safe; cp ${S}/tasks/T-AB-1/report.md "$F"`, 'SEC-3', 'an assignment after || may not run: no literal'],
  [`true && F=${S}/tasks/T-AB-1/report.md; cat "$F"`, 'SEC-3', 'an assignment after && may not run either'],
  [`echo x | F=${S}/tasks/T-AB-1/report.md; cat "$F"`, 'SEC-3', 'an assignment in a pipe runs in a subshell'],
  ['PATH=/tmp/evil; git commit -m x', 'SEC-3', 'PATH changes what runs: never a literal of the line'],
  [`IFS=/; F=${S}/tasks/T-AB-1/report.md; cat $F`, 'SEC-3', 'IFS changes word splitting'],
  // 2.2.1: time launders nothing; a script merely named like the CLI is a script; the launcher still gets the gate rules
  [`time cp notes.md ${S}/tasks/T-AB-1/report.md`, 'FLW-7', 'time before a write into the state'],
  [`time ${BIN} verify T-AB-1 | tail -1`, 'TRP-2', 'a pipe after a gate behind time'],
  [`time plugins/x/bin/${BIN} heavy -- npm test | tail -3`, 'TRP-2', 'a pipe after heavy behind time and the launcher path'],
  [`./tools/${BIN} commit --yes`, 'SEC-3', 'a script named like the CLI outside bin/ is a script with a guarded argument'],
  [`node ./tools/${BIN} commit --yes`, 'SEC-3', 'the same behind node'],
  [`./evil/bin/${BIN} commit --yes`, 'SEC-3', 'a planted script under a bin/ directory is not the launcher: its content differs'],
  [`node evil/bin/${BIN} commit --yes`, 'SEC-3', 'the same behind node'],
  [`/nowhere/plugins/x/bin/${BIN} commit --yes`, 'SEC-3', 'a launcher path that does not exist is a script'],
  [`copy/bin/${BIN} commit --yes`, 'SEC-3', 'the launcher\'s own bytes in a copy nobody trusts: the code beside it is unknown'],
  [`node copy/bin/${BIN} commit --yes`, 'SEC-3', 'the same behind node'],
  [`linked/bin/${BIN} commit --yes`, 'SEC-3', 'a planted launcher with the real lib linked beside it: a sibling directory proves nothing'],
  [`node linked/bin/${BIN} commit --yes`, 'SEC-3', 'the same behind node'],
  [`plugins/planted/bin/${BIN} commit --yes`, 'SEC-3', 'T-MG-95: a plugin root with this plugin\'s name.json is not the launcher; only LAUNCHERS names a checkout'],
  [`time X=a git stash`, 'SEC-3', 'an assignment after time (bash reads it as a prefix assignment)'],
  [`time PATH=/tmp/evil git commit -m x`, 'SEC-3', 'PATH set after time'],
  [`time ! git stash`, 'SEC-3', 'compound syntax after time'],
  [`time -- git stash`, 'SEC-3', 'an option after time'],
];

test('retro idioms pass: literal variables, loops over literals, the state named in data, reads, script arguments, a pipe after --json', () => {
  const failed = MUST_PASS.map(([c, what]) => [c, what, judge(c)]).filter(([, , v]) => v.deny).map(([c, what, v]) => `${what}: ${c}\n    ${v.reason}`);
  assert.deepEqual(failed, [], 'every line of the pass basket passes');
});

test('what those idioms stood in for still blocks, with the rule that applies', () => {
  const before = blocks.length;
  const wrong = MUST_BLOCK.map(([c, rule, what]) => [c, rule, what, judge(c)]).filter(([, rule, , v]) => !v.deny || !v.reason.startsWith(`${rule}:`)).map(([c, rule, what, v]) => `${what}: ${c}\n    expected ${rule}, got ${v.deny ? v.reason : 'allow'}`);
  assert.deepEqual(wrong, [], 'every line of the block basket is blocked by its rule');
  assert.equal(blocks.length - before, MUST_BLOCK.length, 'every block is logged');
  const entry = blocks[blocks.length - 1];
  assert.deepEqual([entry.capability, entry.event, entry.rule], ['guard-bash', 'block', 'SEC-3']);
  assert.ok(typeof entry.at === 'string' && entry.command.length <= 200 && entry.cwd === DIR);
});

test('expandLiterals: the rules of a literal variable', () => {
  assert.equal(expandLiterals('F=a/b.md; grep x "$F"'), 'grep x "a/b.md"');
  assert.equal(expandLiterals('F=a/b.md; grep x $F'), 'grep x a/b.md');
  assert.equal(expandLiterals('F=a/b.md; grep x ${F}'), 'grep x a/b.md');
  assert.equal(expandLiterals("F='a b'; grep x \"$F\""), 'grep x "a b"');
  assert.equal(expandLiterals('F=a; G=b; cat $F $G'), 'cat a b');
  assert.equal(expandLiterals('F=a; cd x && cat $F; ls $F'), 'cd x && cat a; ls a');
  // kept as written: a command from a variable, a value with a metacharacter or a quote, a name set another way, two assignments
  assert.equal(expandLiterals('G="git stash"; $G'), '$G', 'the reference in command position stays a reference (no shape)');
  assert.equal(expandLiterals("X='a;b'; echo $X"), "X='a;b'; echo $X");
  assert.equal(expandLiterals(`X='import os; os.system("git stash")'; python3 -c "$X"`), `X='import os; os.system("git stash")'; python3 -c "$X"`);
  assert.equal(expandLiterals('s=list; printf -v s push; git stash "$s"'), 's=list; printf -v s push; git stash "$s"');
  assert.equal(expandLiterals('X=a; X=b; cat $X'), 'X=a; X=b; cat $X');
  assert.equal(expandLiterals('export B=main; git push -f origin $B'), 'export B=main; git push -f origin $B');
  assert.equal(expandLiterals("F=a; echo '$F'"), "echo '$F'", 'single quotes keep the reference');
  assert.equal(expandLiterals('F=a cmd $F'), 'F=a cmd $F', 'an assignment before a command is not a variable of the line');
  assert.equal(expandLiterals('F=a; echo $FOO'), 'echo $FOO', 'a longer name is another variable');
  // conditional assignments and special names: the text stays as written (the parser rejects the expansion)
  assert.equal(expandLiterals('true || F=a; cat $F'), 'true || F=a; cat $F');
  assert.equal(expandLiterals('true && F=a; cat $F'), 'true && F=a; cat $F');
  assert.equal(expandLiterals('echo x | F=a; cat $F'), 'echo x | F=a; cat $F');
  assert.equal(expandLiterals('F=a && cat $F'), 'cat a', 'an unconditional assignment followed by && runs');
  assert.equal(expandLiterals('PATH=/x; git status'), 'PATH=/x; git status');
  assert.equal(expandLiterals('IFS=,; cat $IFS'), 'IFS=,; cat $IFS');
  assert.equal(expandLiterals('HOME=/tmp; cat $HOME/x'), 'HOME=/tmp; cat $HOME/x');
  assert.equal(expandLiterals('BASH_ENV=/x; cat a'), 'BASH_ENV=/x; cat a');
  // for loops over literals
  assert.equal(expandLiterals('for t in a b; do cat "$t"; done'), 'cat "a"; cat "b"');
  assert.equal(expandLiterals('for t in a b\ndo\n  cat $t\ndone'), 'cat a; cat b');
  assert.equal(expandLiterals('for t in $(ls); do cat $t; done'), 'for t in $(ls); do cat $t; done', 'words from an expansion stay');
  assert.equal(expandLiterals('for t in a b; do $t x; done'), '$t x; $t x', 'the command name from the loop variable stays a reference');
});
