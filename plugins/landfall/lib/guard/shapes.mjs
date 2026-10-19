// Shapes of simple commands (spec SD-29, SEC-3): the allowlist the Bash guard matches when a guarded token is present.
// git — reading and local changes from the list, commit (without -n, --no-verify and its abbreviations), push (a target
// other than main), config, stash list|show (git-shape.mjs); gate commands without a pipe after them (TRP-2, SEC-6); kit
// scripts and the plugin's own command (arguments are data; `heavy --` runs the command after it); package managers; data
// commands (echo, cat, grep …) and project tools; a shell only as `<shell> <script>` without any option (also behind env,
// nice, timeout, command …); an interpreter and eval only with code without a guarded word; an unknown command — a guarded
// word only in a file path and no piped input. Otherwise no recognized simple form (NotPlain); a shape that recognizes a
// broken rule returns its message. A command outside the shapes is blocked by design — no aliases, variables, eval or
// analysis of code in bash -c. Every simple command is also checked for writes to hook files (SEC-4) and to command-owned
// state files (FLW-7, protect.mjs); rm -r and find -delete for a tracked top-level directory or the repository (PRI-17).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gitShape } from './git-shape.mjs';
import { GIT_ARG } from './git-options.mjs';
import { MSG, short } from './messages.mjs';
import { findDeleteShape, removeShape, stateWrite, writeRedir } from './protect.mjs';
import { why } from './tokenizer.mjs';
import { BIN, CODE_RUNNERS, ENV_EXEC, GATES, KEYWORDS, SHELLS, base, gateById, variants, wordTok } from './tokens.mjs';

const DEPTH = 10; // package.json scripts calling each other
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isPath = (t) => !/\s/.test(t) && !t.startsWith('-') && (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t));
// Kit scripts (.workflow/bin, .workflow/routing, .githooks): their arguments are data (state notes, IDs, paths).
const KIT_SCRIPT = /(^|\/)(\.workflow\/(bin|routing)|\.githooks)\/[\w.-]+$/;
const isBin = (w) => w === BIN;

// A gate script run as the program (secrets scan, machine budget).
const gateScript = (w) => GATES.find((g) => g.script?.test(w)) ?? null;
// A gate named in a package.json script body or in exec words.
const gateInText = (text) => { const vs = variants(text); return GATES.find((g) => g.text && vs.some((v) => g.text.test(v))) ?? null; };

// ---------- package managers ----------
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const PM_EXEC = new Set(['exec', 'x', 'dlx']);
const PM_VAL = { npm: ['--prefix', '-C', '-w', '--workspace', '--loglevel'], pnpm: ['-C', '--dir', '--filter', '-F', '--workspace-dir'], yarn: ['--cwd'], bun: ['--cwd', '--filter', '-F'] };
const PM_BUILTIN = new Set(['install', 'i', 'add', 'ci', 'uninstall', 'un', 'remove', 'rm', 'update', 'up', 'upgrade', 'outdated', 'ls', 'list',
  'view', 'info', 'show', 'search', 'init', 'create', 'link', 'unlink', 'pack', 'publish', 'version', 'audit', 'fund', 'config', 'get', 'set',
  'why', 'explain', 'cache', 'store', 'env', 'dedupe', 'prune', 'rebuild', 'login', 'logout', 'whoami', 'help', 'doctor', 'import', 'patch',
  'workspace', 'workspaces', 'plugin', 'pm', 'query', 'token', 'owner', 'access', 'dist-tag', 'deprecate', 'docs', 'repo', 'home', 'bugs']);
const NPM_LIFECYCLE = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };
// Result: { script } (a package.json script run) | { exec } (index of the command after exec/dlx/x) | { builtin }; always dir.
function pmParse(w, ctx) {
  const b = base(w[0]); const vals = PM_VAL[b] ?? []; const pos = []; let dir = ctx.cwd; let opts = true;
  for (let k = 1; k < w.length && pos.length < 2; k++) {
    const t = w[k];
    if (opts && t === '--') { opts = false; continue; } // after "--" positionals: npm run -- <script>
    if (!opts || !t.startsWith('-') || t === '-') { pos.push(k); continue; }
    const eq = t.indexOf('='); const name = eq < 0 ? t : t.slice(0, eq);
    if (!vals.includes(name)) continue;
    const v = eq < 0 ? w[++k] ?? '' : t.slice(eq + 1);
    if (['--prefix', '-C', '--dir', '--cwd'].includes(name)) dir = ctx.inDir(dir, v);
  }
  const p0 = pos.length ? w[pos[0]] : undefined;
  if (p0 === undefined) return { dir };
  if (PM_RUN.has(p0)) return pos[1] !== undefined ? { script: w[pos[1]], dir } : { dir };
  if (PM_EXEC.has(p0)) return { exec: pos[0] + 1, dir };
  if (b === 'npm') return Object.hasOwn(NPM_LIFECYCLE, p0) ? { script: NPM_LIFECYCLE[p0], dir } : { builtin: p0, dir };
  if (PM_BUILTIN.has(p0)) return { builtin: p0, dir };
  return { script: p0, dir }; // pnpm / yarn / bun run a script without "run" too
}
// The body of a script from the nearest package.json up from dir (as npm); no file or script → null; unreadable or
// contradictory (not an object, scripts not an object) → no proof.
function packageScript(dir, name) {
  for (let d = dir, k = 0; d !== null && k < 40; k++) {
    const f = join(d, 'package.json');
    if (existsSync(f)) {
      let p; try { p = JSON.parse(readFileSync(f, 'utf8')); } catch { why(`cannot read ${f}`); }
      const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
      if (!plain(p) || (p.scripts !== undefined && !plain(p.scripts))) why(`${f} is not a package.json object with a scripts object`);
      const s = p.scripts;
      const v = s !== null && typeof s === 'object' && Object.hasOwn(s, name) ? s[name] : undefined; // own scripts only
      return typeof v === 'string' ? v : null;
    }
    const up = dirname(d); if (up === d) break; d = up;
  }
  return null;
}
// The gate a package manager command runs: the scanner name in its arguments (fail closed), the test script, or a
// package.json script (with pre… / post…) whose body names a gate or calls another package manager command that runs one.
function pmGate(w, ctx, depth = 0) {
  if (depth > DEPTH) throw new Error('package.json scripts call each other too deep');
  if (w.slice(1).some((x) => /^check-secrets(:|$)/.test(x))) return gateById('secrets scan');
  const p = pmParse(w, ctx);
  if (p.exec !== undefined) return gateInText(w.slice(p.exec).join(' '));
  if (p.script === undefined) return null;
  const direct = GATES.find((g) => g.pmScript?.test(p.script));
  if (direct) return direct;
  const words = (seg) => seg.trim().split(/\s+/).map((x) => x.replace(/['"]/g, ''));
  for (const n of [`pre${p.script}`, p.script, `post${p.script}`]) {
    const body = packageScript(p.dir, n);
    if (body === null) continue;
    const g = gateInText(body);
    if (g) return g;
    for (const ws of body.split(/[;&|\n]+/).map(words)) {
      const k = ws.findIndex((x) => PM.has(base(x)));
      const inner = k >= 0 ? pmGate(ws.slice(k), ctx, depth + 1) : null;
      if (inner) return inner;
    }
  }
  return null;
}

// The plugin's own command: global flags, then the subcommand words. Gates by subcommand path; `heavy` runs the command
// after "--".
const binWords = (w) => { let k = 1; while (k < w.length && w[k].startsWith('-')) k++; return { k, words: w.slice(k) }; };
const binGate = (w) => {
  const { words } = binWords(w);
  return GATES.find((g) => g.sub?.some((s) => s.split(' ').every((x, j) => words[j] === x))) ?? null;
};

// A script from a file: its content is outside the guard; the arguments of kit scripts are data, of other scripts a
// guarded word only in a path. The script itself (the first argument) too: a guarded word only in a file path.
function scriptShape(w, k) {
  if (/^(\/dev\/|\/proc\/)|^-$/.test(w[k])) why(`${base(w[0])} reads code from a descriptor`);
  if (wordTok(w[k]) && !isPath(w[k])) why(`script "${short(w[k])}" with a guarded word outside a file path`);
  if (!KIT_SCRIPT.test(w[k])) for (const t of w.slice(k + 1)) if (wordTok(t) && !isPath(t)) why(`argument "${short(t)}" of the script ${short(w[k])}`);
  return null;
}
// Code given as text (bash -c, eval, node -e …): allowed only without a guarded word, also in the arguments for the code.
function codeShape(b, code, rest, ctx) {
  if (ctx.codeTok(code) || rest.some(wordTok)) why(`code for ${b} with a guarded word`);
  return null;
}
// Wrappers that run the following words as a command. The program is the first word after the wrappers (env: after the
// NAME=value assignments, timeout: after the duration). An option of a wrapper — the program cannot be named without
// reading its value. Every skipped word is classified: an env assignment without a guarded word and without a variable
// the shell, git or the loader runs (ENV_EXEC, any GIT_*); a timeout duration — a number with a unit. Another word → no form.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'setsid', 'chronic', 'unbuffer', 'stdbuf', 'caffeinate', 'env', 'sudo',
  'doas', 'nice', 'ionice', 'timeout', 'busybox', 'toybox']);
const execVar = (name) => ENV_EXEC.test(name) || /^GIT_/i.test(name); // any case, as 1.5.2
function unwrap(w) {
  let k = 0;
  while (k < w.length && WRAPPERS.has(base(w[k]))) {
    const b = base(w[k++]);
    if (w[k]?.startsWith('-')) return { opt: true };
    if (b === 'env') {
      for (; k < w.length && /^[A-Za-z_]\w*=/.test(w[k]); k++) {
        if (execVar(w[k].split('=')[0]) || wordTok(w[k])) why(`env ${short(w[k])}: a variable that runs code, or a guarded word`);
      }
    }
    if (b === 'timeout') { if (!/^\d+(\.\d+)?[smhd]?$/.test(w[k] ?? '')) why(`timeout "${short(w[k] ?? '')}": a duration without a recognized form`); k++; }
  }
  return { at: k };
}

// Commands whose arguments are data (shell and project tools): a guarded word in an argument is harmless.
const DATA = new Set(['echo', 'printf', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl', 'fold', 'fmt',
  'column', 'paste', 'join', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'tree', 'stat', 'file', 'du', 'df', 'realpath', 'readlink',
  'basename', 'dirname', 'pwd', 'cd', 'pushd', 'popd', 'dirs', 'mkdir', 'rmdir', 'touch', 'rm', 'cp', 'mv', 'ln', 'chmod', 'chown', 'diff',
  'cmp', 'comm', 'jq', 'yq', 'true', 'false', ':', 'test', '[', '[[', 'unset', 'read', 'mapfile', 'readarray', 'set', 'shopt', 'type',
  'which', 'whereis', 'wait', 'sleep', 'date', 'whoami', 'id', 'uname', 'hostname', 'printenv', 'tee', 'md5', 'md5sum', 'shasum', 'sha1sum',
  'sha256sum', 'base64', 'xxd', 'od', 'hexdump', 'strings', 'pbcopy', 'pbpaste', 'curl', 'wget', 'kubectl', 'helm', 'adb', 'cargo',
  'pre-commit', 'commitlint', 'vitest', 'jest', 'mocha', 'pytest', 'tsc', 'eslint', 'prettier', 'biome', 'ruff', 'black', 'mypy', 'ps',
  'pgrep', 'pkill', 'kill', 'killall', 'man', 'help', 'tput', 'clear', 'history']);
const DECL = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
// Commands that take a variable name (with an array index evaluated like arithmetic), or set the variable they name.
const VAR_NAMES = new Set([...DECL, 'read', 'mapfile', 'readarray', 'printf', 'unset', 'test', '[', '[[', 'getopts', 'wait']);
const VAR_SETTERS = new Set([...DECL, 'read', 'mapfile', 'readarray', 'printf', 'getopts']);
// Interpreters: options with code in the text; options with a value (the value is not the script).
const INTERP = { python: ['-c'], python2: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], osascript: ['-e'], lua: ['-e'], Rscript: ['-e'], pwsh: ['-c', '-Command'], deno: ['eval'] };
const INTERP_VAL = ['-W', '-X', '-r', '--require', '--import', '--loader', '-I', '-M', '--input-type', '--env-file'];
const XARGS_GIT = new Set(['add', 'rm', 'log', 'diff', 'show', 'ls-files', 'blame', 'grep']);
const SED_EXEC = /(^|[;{}\n]\s*|[0-9$/]\s*)e(\s|$)|\/[gpiImM0-9]*e[gpiImM0-9]*\s*(;|}|$)/;

// The shape of a simple command: null — allowed; text — a broken rule; NotPlain — no recognized simple form.
export function shape(c, ctx) {
  const w = c.words.map((x) => x.text);
  if (hookFileWrite(c, w, ctx)) return MSG.hookFiles; // also a redirection alone (review r1 #5)
  // a command-owned state file (FLW-7); a wrapper's command is checked as its own simple command below
  const owned = stateWrite(c, w, ctx, { args: !WRAPPERS.has(base(w[0] ?? '')) });
  if (owned) return owned;
  if (!w.length) return null; // a redirection alone
  const name = w[0]; const b = base(name);
  const fed = c.pipeIn || c.heredoc !== null || c.redirs.some((r) => r.op.startsWith('<')); // input from a pipe, heredoc or file
  const tok = (k = 1) => w.slice(k).some(wordTok);
  const pipeAfter = (gate) => (c.pipeOut && gate ? MSG.pipe(gate, w.join(' ')) : null);
  if (c.words.some((x) => x.q === '?') && b !== 'echo' && b !== 'printf') why('$? outside echo/printf');
  if (c.words.some((x) => x.q === 'msg') && !['git', 'gh', 'echo', 'printf'].includes(b)) why('a $( ) substitution outside a message');
  if (ctx.shadowNames.has(name)) why(`"${short(name)}" redefined earlier in this command (alias or hash -p)`);
  if (KEYWORDS.has(name)) why(`compound syntax (${name})`);
  // arithmetic evaluation of a value runs a $(…) stored in it: let, declare -i, an array index in a variable name,
  // [[ … -eq … ]] with a name instead of a number
  if (b === 'let' || (DECL.has(b) && w.some((t) => /^[-+][a-zA-Z]*i/.test(t)))) why(`${b}: arithmetic evaluation`);
  if (VAR_NAMES.has(b) && w.slice(1).some((t) => t.includes('[') && !/^\[\[?$/.test(t))) why(`${b} with an array index (evaluated like code)`);
  if (b === '[[' && w.some((t, k) => /^-(eq|ne|lt|le|gt|ge)$/.test(t) && !(/^-?\d+$/.test(w[k - 1]) && /^-?\d+$/.test(w[k + 1])))) why('[[ … ]] compares the value of a variable arithmetically');
  // setting a variable a shell, git or the loader runs (G152 r3 b): declarations, read, mapfile, printf -v, getopts
  if (VAR_SETTERS.has(b) && w.slice(1).some((t) => execVar(t.split('=')[0]))) why(`${b} sets a variable that runs code`);
  if (name === 'git' || /^\/.*\/git$/.test(name)) return gitShape(c, w, ctx);
  if (/^git-[a-z][\w-]*$/.test(b)) return gitShape(c, ['git', b.slice(4), ...w.slice(1)], ctx);
  // a gate script as the executed program: no pipe after it (TRP-2, SEC-6); as the first argument of a shell, source or
  // a wrapper — below
  if (gateScript(name)) return pipeAfter(gateScript(name));
  // a wrapper (env, nice, timeout, command, sudo …): an option of the wrapper has no recognized form (review r1 #4); the
  // wrapped command gets its own shape; then, as 1.5.2, a guarded word in the wrapper's words outside a path has none
  // (shells, source and gate scripts excepted: their shape already read every word)
  if (WRAPPERS.has(b)) {
    const u = unwrap(w);
    if (u.opt) why(`${b} with an option: the wrapped command has no recognized form; run it without the wrapper option`);
    if (u.at >= w.length) return null;
    const p = base(w[u.at]);
    const inner = shape({ ...c, words: c.words.slice(u.at) }, ctx);
    if (inner || SHELLS.has(p) || p === 'source' || p === '.' || gateScript(w[u.at])) return inner;
    for (const t of w) if (wordTok(t) && !isPath(t)) why(`"${short(t)}" in the command ${short(b)} outside the list`);
    return null;
  }
  if (base(name) === BIN && name !== BIN) { const gate = pipeAfter(binGate(w)); if (gate) return gate; } // by path: gates only
  if (isBin(name)) {
    const gate = pipeAfter(binGate(w)); if (gate) return gate;
    const { k, words } = binWords(w);
    if (words[0] !== 'heavy') return null; // the CLI reads its arguments as data, never as shell
    const e = w.indexOf('--', k);
    const inner = c.words.slice(e < 0 ? k + 1 : e + 1);
    return inner.length ? shape({ ...c, words: inner, pipeOut: false }, ctx) : null;
  }
  if (PM.has(b)) {
    if (c.pipeOut) { const g = pmGate(w, ctx); if (g) return MSG.pipe(g, w.join(' ')); }
    const p = pmParse(w, ctx);
    if (p.exec !== undefined && tok(p.exec)) why(`${b} exec with a guarded word`);
    if (p.script !== undefined && wordTok(p.script) && !/^check-secrets(:|$)/.test(p.script)) why(`${b} script "${short(p.script)}" with a guarded word in its name`);
    return null;
  }
  if (['npx', 'pnpx', 'bunx'].includes(b)) { const t = w.find((x, k) => k > 0 && !x.startsWith('-')); if (tok() && !DATA.has(base(t ?? ''))) why(`${b} with a guarded word`); return null; }
  if (SHELLS.has(b)) {
    // a shell only as `<shell> <script> [arguments]` or alone without input; any option (-c, -s, -o, +o, --, -) in a line
    // with a guarded word has no recognized form: the guard does not read shell options or their values
    if (/^[-+]/.test(w[1] ?? '')) why(`${b} with the option "${short(w[1])}": run the script without shell options, or without a guarded word in the line`);
    if (w.length < 2) { if (fed) why(`${b} reads code from a pipe, a redirection or a heredoc`); return null; }
    if (gateScript(w[1])) return pipeAfter(gateScript(w[1]));
    return scriptShape(w, 1);
  }
  if (b === 'eval') { ctx.unsure = true; return codeShape(b, w.slice(1).join(' '), [], ctx); }
  if (b === 'source' || b === '.') {
    // source only as `source <script> [arguments]`: an option (source -p <path> in bash 5.3, --) has no recognized form
    if (/^-/.test(w[1] ?? '')) why(`${b} with the option "${short(w[1])}": run the script without options`);
    if (gateScript(w[1] ?? '')) return pipeAfter(gateScript(w[1])); // a gate script changes neither branch nor directory
    ctx.unsure = true; if (fed || w.length < 2) why(`${b} reads code from its input`); return scriptShape(w, 1);
  }
  if (Object.hasOwn(INTERP, b)) {
    for (let k = 1; k < w.length; k++) {
      const t = w[k];
      const f = INTERP[b].find((x) => t === x || (x.length === 2 && t.startsWith(x)));
      if (f) return codeShape(b, t === f ? w[k + 1] ?? '' : t.slice(f.length), w.slice(t === f ? k + 2 : k + 1), ctx);
      if (t === '-m' || t === '--') return scriptShape(w, k + 1 < w.length ? k + 1 : k);
      if (t === '-') why(`${b} reads code from its input`);
      if (!t.startsWith('-')) return scriptShape(w, k);
      if (wordTok(t) || (INTERP_VAL.includes(t) && wordTok(w[k + 1] ?? ''))) why(`an option of ${b} with a guarded word`);
      if (INTERP_VAL.includes(t)) k++;
    }
    if (fed) why(`${b} reads code from a pipe, a redirection or a heredoc`);
    return null;
  }
  if (b === 'xargs') { // xargs [-0 -r] git <paths/revisions> — appended words are data; no git or code otherwise
    let k = 1; while (k < w.length && /^(-0|-r|--null|--no-run-if-empty)$/.test(w[k])) k++;
    if (w[k] === 'git' && XARGS_GIT.has(w[k + 1]) && !tok(k + 2)) return null;
    if (tok() || w.slice(k).some((x) => base(x) === 'git' || CODE_RUNNERS.has(base(x)))) why('xargs to git or code');
    if (ctx.codeTok(w.slice(k).join(' '))) why('xargs runs a command with a guarded word'); // xargs rm -rf: targets from input
    return null;
  }
  if (b === 'alias') { // a shell alias: a body without a guarded word; a later use of the name in this command has no form
    for (const t of w.slice(1)) { const e = t.indexOf('='); if (e > 0) { if (ctx.codeTok(t.slice(e + 1))) why('a shell alias with a guarded word'); ctx.shadowNames.add(t.slice(0, e)); } }
    return null;
  }
  if (b === 'hash' && w.some((t) => /^-[a-z]*p/.test(t))) { for (const t of w.slice(1)) if (!t.startsWith('-')) ctx.shadowNames.add(t); return null; }
  if (b === 'trap' || b === 'find') { // trap '<code>' / find -exec <command>: code without a guarded word; find -delete: a removal
    if (b === 'find') { const v = findDeleteShape(c, ctx); if (v) return v; }
    if ((b === 'trap' || w.some((t) => /^-(exec|execdir|ok|okdir)$/.test(t))) && (tok() || ctx.codeTok(w.slice(1).join(' ')))) why(`${b} runs a command with a guarded word`);
    return null;
  }
  if (/^g?sed$/.test(b) && w.slice(1).some((t) => !t.startsWith('-') && SED_EXEC.test(t))) why('sed with the e command');
  if (/^[gmn]?awk$/.test(b) && w.slice(1).some((t) => !t.startsWith('-') && /system|getline|\|/.test(t))) why('awk that runs a command');
  if (/^(g?sed|[gmn]?awk)$/.test(b)) return null;
  if (b === 'gh') { if (w.find((t, k) => k > 0 && !t.startsWith('-')) === 'alias') why('gh alias'); return null; }
  if (b === 'docker' || b === 'podman' || b === 'nerdctl') { // a container with the repository mounted runs a command on the same repository
    if (['run', 'exec', 'create', 'start', 'compose', 'container'].includes(w.find((t, k) => k > 0 && !t.startsWith('-'))) && tok()) why(`${b} runs a command with a guarded word`);
    return null;
  }
  if (DECL.has(b)) { if (w.some((t) => /^GIT_/i.test(t)) || tok()) why(`${b} of a GIT_* variable or with a guarded word`); return null; }
  if (b === 'rm') return removeShape(c, ctx); // a recursive removal of a tracked top-level directory (PRI-17)
  if (DATA.has(b)) return null;
  // an unknown command or a script from a file: a guarded word only in a path; piped input could be code
  if (fed) why(`${short(b)} reads input from a pipe, a redirection or a heredoc`);
  if (name.includes('/')) return scriptShape(w, 0);
  for (const t of w) if (wordTok(t) && !isPath(t)) why(`"${short(t)}" in the command ${short(b)} outside the list`); // also the name (alias, function)
  return null;
}

// Hook files (SEC-4): a hook directory (.githooks, .husky, .git/hooks) or .git itself, after resolving against the command's
// directory. A redirection that writes such a path, from any command (also alone), and any program other than a reader
// (or git, whose rm / mv git-shape checks) with such a path in an argument or an option value (review r1 #5): no reading
// of destination options. chmod passes only with a mode that just adds permissions.
export const isHookPath = (t, cwd) => /(^|\/)(\.githooks|\.husky|\.git\/hooks)(\/|$)|(^|\/)\.git\/?$/.test(cwd ? resolve(cwd, t) : t);
const HOOK_READERS = new Set(['cat', 'ls', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'stat', 'file', 'wc', 'md5',
  'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'realpath', 'readlink', 'basename', 'dirname', 'test', '[', '[[', 'cd', 'pushd', 'popd', 'du', 'tree',
  'echo', 'printf']);
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv', 'truncate', 'tee', 'cp', 'ln', 'install', 'sed', 'gsed', 'chmod']); // drift under .git/
const ADD_ONLY = /^([ugoa]*\+[rwxXst]+)(,[ugoa]*\+[rwxXst]+)*$/;
function hookFileWrite(c, w, ctx) {
  const hit = (t) => isHookPath(t, ctx.cwd ?? ctx.cwdHint); // the hint of an uncertain cd only finds more blocks
  if (c.redirs.some((r) => writeRedir(r) && hit(r.target))) return true;
  const b = base(w[0] ?? '');
  if (!w.length || b === 'git' || /^git-/.test(b) || HOOK_READERS.has(b)) return false;
  const words = w.slice(1).flatMap((t) => (t.includes('=') ? [t, t.slice(t.indexOf('=') + 1)] : [t]));
  if (!words.some(hit)) return false;
  if (b !== 'chmod') return true;
  const mode = w.slice(1).find((t) => /^[ugoa]*[-+=][rwxXst]*(,[ugoa]*[-+=][rwxXst]*)*$|^\d{3,4}$/.test(t)) ?? '';
  const owner = /^\d+$/.test(mode) ? Number(mode[mode.length - 3]) : 0;
  return !(ADD_ONLY.test(mode) || (owner & 1) === 1) || w.slice(1).some((t) => t.startsWith('-') && t !== mode);
}

// Effects of a command on the rest of the line — the state a push shape reads (the current branch, HEAD, the push
// config) may change before the push runs (state drift): cd changes the directory (to an unknown one, or in a pipe:
// unsure); git switch, checkout <branch>, rebase <base> <branch>, symbolic-ref <ref> <target>, update-ref, branch
// -m/-c/upstream, config writes, remote changes and -C, a write under .git/, and every program the guard does not know to
// leave git state alone (scripts, interpreters, package managers, gh, the plugin's heavy …) make it unsure. Known to
// leave it alone: data commands, declarations, the gate and kit scripts, the plugin CLI except heavy, xargs to git data.
const GIT_INTERNAL = /(^|\/)\.git(\/|$)/;
// Not certain → drift (review r1 #3): no option is read; only the plain listing forms below leave the state alone.
const CONFIG_READ = /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/;
function gitDrift(sub, args) {
  const positional = args.filter((a) => !a.startsWith('-')); const options = args.filter((a) => a.startsWith('-'));
  if (['switch', 'update-ref', 'rebase'].includes(sub)) return true;
  if (sub === 'checkout') return args[0] !== '--';
  if (sub === 'symbolic-ref') return positional.length !== 1 || options.some((a) => !/^(-q|--quiet|--short)$/.test(a));
  if (sub === 'branch') return positional.length > 0 || options.some((a) => !/^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current)$/.test(a));
  if (sub === 'remote') return !(positional.length === 0 || (['show', 'get-url'].includes(positional[0]))) || options.some((a) => !/^(-v|--verbose)$/.test(a));
  if (sub === 'config') return !(['get', 'list'].includes(positional[0]) || options.some((a) => CONFIG_READ.test(a)) || (options.length === 0 && positional.length <= 1));
  return false;
}
function stateSafe(w) {
  const b = base(w[0] ?? ''); const first = w.slice(1).find((t) => !t.startsWith('-')) ?? '';
  if (WRAPPERS.has(b)) { const u = unwrap(w); return !u.opt && u.at < w.length && stateSafe(w.slice(u.at)); }
  if (isBin(w[0])) return binWords(w).words[0] !== 'heavy';
  return DATA.has(b) || DECL.has(b) || b === 'alias' || b === 'xargs' || Boolean(gateScript(w[0])) || KIT_SCRIPT.test(w[0])
    || ((SHELLS.has(b) || Object.hasOwn(INTERP, b)) && (KIT_SCRIPT.test(first) || Boolean(gateScript(first))));
}
export function effects(c, w, ctx) {
  const b = base(w[0] ?? '');
  if (b === 'cd' || b === 'pushd' || b === 'popd') {
    // Only a cd that certainly runs and certainly succeeds moves the cwd: one literal relative or absolute path (no -,
    // ~, glob) to an existing directory, not in a pipeline, not after || and not before ||. After && it holds only for
    // the commands joined to it by && (lib/guard/index.mjs checkLine). Anything else: unknown (findings-r1 C1); a
    // literal target is kept as a hint for the hook-file check only.
    const t = w.slice(1).filter((x) => !/^-[LPe@]+$/.test(x));
    const literal = b !== 'popd' && t.length === 1 && /^[^-~*?[]/.test(t[0]) && !c.words.some((x) => x.glob);
    const certain = literal && !c.pipeIn && !c.pipeOut && c.before !== '||' && c.after !== '||';
    const p = literal ? ctx.inDir(ctx.cwd, t[0]) : null;
    const next = certain && p !== null && isDir(p) ? p : null;
    if (next === null) ctx.unsure = true;
    ctx.cwdHint = next === null ? p : null;
    ctx.cwdConditional = next !== null && c.before === '&&';
    ctx.cwd = next; return;
  }
  const internal = (t) => GIT_INTERNAL.test(ctx.cwd ? resolve(ctx.cwd, t) : t);
  if (c.redirs.some((r) => writeRedir(r) && internal(r.target))) { ctx.unsure = true; return; }
  if (WRITERS.has(b) && w.slice(1).some((t) => internal(t) || (t.includes('=') && internal(t.slice(t.indexOf('=') + 1))))) { ctx.unsure = true; return; }
  if (b === 'git' || /^git-[a-z]/.test(b)) {
    const ws = b === 'git' ? w : ['git', b.slice(4), ...w.slice(1)];
    const k = ws.findIndex((x, j) => j > 0 && !x.startsWith('-') && !GIT_ARG.has(ws[j - 1]));
    if (ws.includes('-C') || gitDrift(ws[k], ws.slice(k + 1))) ctx.unsure = true;
    return;
  }
  if (!stateSafe(w)) ctx.unsure = true;
}
