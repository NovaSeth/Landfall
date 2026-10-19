// Git shapes of the Bash guard (spec SD-29): global options from the list, a subcommand from the list (reading, local
// changes, commit, push, config, stash list|show) and its arguments read as git reads them. A shape returns null
// (allowed), a message (a rule broken) or throws NotPlain (no recognized simple form).
import { configKey } from './config-keys.mjs';
import { DATA_SUBS, GIT_ARG, GIT_FLAG, GIT_LONG, GIT_SHORT, LONG_KIND, MERGE_LIKE, longOpt } from './git-options.mjs';
import { MSG, short } from './messages.mjs';
import { isHookPath } from './shapes.mjs';
import { why } from './tokenizer.mjs';

// The push target is main: main, heads/main, refs/heads/main (git completes a short target), also a * pattern covering main.
const isMainRef = (ref) => {
  const r = ref.replace(/^(refs\/)?(heads\/)?/, '');
  if (r.includes('*')) {
    const re = new RegExp(`^${ref.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['main', 'master', 'heads/main', 'heads/master', 'refs/heads/main', 'refs/heads/master'].some((x) => re.test(x));
  }
  return r === 'main' || r === 'master';
};
// A prefix of --no-verify that git may expand to it (shorter ones, --n / --no / --no-, are always ambiguous).
const isNoVerify = (t) => { const n = t.split('=')[0]; return n.length >= 6 && '--no-verify'.startsWith(n); };
const option = (sub, t) => longOpt(GIT_LONG[sub], t) ?? why(`git ${sub} option "${short(t.split('=')[0])}": ambiguous or unknown abbreviation, write the full name`);

// A key=value set for this call (git -c, --config-env, clone -c / --config): a hooks key → SEC-4; a key that runs a
// command, or hooksPath in the value → no recognized simple form.
function configPair(v, where) {
  const kind = configKey(v.split('=')[0]);
  if (kind === 'hooks') return MSG.hooks;
  if (kind === 'exec' || /hookspath/i.test(v)) why(`${where} ${short(v)} (alias, hooks or a key that runs a command)`);
  return null;
}

// Subcommands with a transport: an ext::<command> address runs the command.
const TRANSPORT = new Set(['clone', 'fetch', 'pull', 'ls-remote', 'push', 'remote', 'archive', 'submodule']);

// The arguments of an inspected subcommand (one table: GIT_LONG + GIT_SHORT), in order, stop at "--" (paths and patterns
// follow): a long option resolved like parse-options (unknown or ambiguous: no proof), its value consumed; a short
// cluster letter by letter, a value letter takes the rest of the cluster or the next word. Options that run a command,
// take hooks from a template or skip hooks are found here; a config pair goes through the one key list.
function scanArgs(sub, args) {
  const s = GIT_SHORT[sub] ?? {};
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return null;
    if (a.startsWith('--')) {
      const o = option(sub, a); const kind = o.neg ? null : LONG_KIND[o.name];
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[k + 1] ?? '';
      if (kind === 'exec') why(`git ${sub} --${o.name} runs a command`);
      if (kind === 'template') why(`git ${sub} --${o.name}: hooks and config from the template directory`);
      if (kind === 'no-verify') return MSG.hooks;
      if (kind === 'config') { const r = configPair(value, `git ${sub} --config`); if (r) return r; }
      if (o.arg === 'req' && !o.neg && !o.value) k++;
      continue;
    }
    if (!/^-./.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const ch = a[j]; const rest = a.slice(j + 1);
      if (s.exec?.includes(ch)) why(`git ${sub} -${ch} runs a command`);
      if (s.config?.includes(ch)) { const r = configPair(rest || (args[k + 1] ?? ''), `git ${sub} -c`); if (r) return r; if (!rest) k++; break; }
      if (s.value?.includes(ch)) { if (!rest) k++; break; }
      if (s.optional?.includes(ch)) break;
      if (!s.flags?.includes(ch)) why(`git ${sub} -${short(ch)}: unknown short option, write the full name`);
    }
  }
  return null;
}

// Git: global options from the list, then the subcommand's shape. ctx: { cwd, unsure, branch(dir), teamMode() }.
export function gitShape(c, w, ctx) {
  if (c.words.some((x) => x.glob)) why('a glob in a git command');
  let i = 1; let dir = ctx.cwd; let inline = false;
  while (i < w.length && w[i].startsWith('-')) {
    const t = w[i];
    if (t === '-c' || t === '--config-env' || t.startsWith('--config-env=')) {
      inline = true;
      const r = configPair(t.includes('=') ? t.slice(13) : w[i + 1] ?? '', 'git -c');
      if (r) return r;
      i += t.includes('=') ? 1 : 2; continue;
    }
    if (t === '-C') { dir = ctx.inDir(dir, w[i + 1] ?? ''); i += 2; continue; }
    // another repository or work tree: the current branch and the push config of the command's directory do not apply
    if (/^--(git-dir|work-tree)(=|$)/.test(t)) dir = null;
    if (GIT_ARG.has(t)) { i += 2; continue; }
    if (!GIT_FLAG.test(t)) why(`unknown git global option "${short(t)}"`);
    i++;
  }
  const sub = w[i]; const args = w.slice(i + 1); const aw = c.words.slice(i + 1);
  if (sub === undefined) return null;
  // the message "$(cat <<'EOF' …)" only as the value of -m / --message (otherwise its body could be an option, e.g. -n)
  aw.forEach((x, k) => { if (x.q === 'msg' && !(['commit', 'tag', 'merge'].includes(sub) && k > 0 && /^(-[a-zA-Z]*m|--message)$/.test(args[k - 1]))) why('a $( ) message outside the value of -m'); });
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) return null; // help only (C11)
  if (sub === 'stash') return args[0] === 'list' || args[0] === 'show' ? null : MSG.stash;
  if (TRANSPORT.has(sub) && args.some((x) => /(^|=)ext::/i.test(x))) why(`git ${sub}: the ext:: transport runs a command`);
  if (sub === 'commit') return checkCommit(args);
  if (sub === 'push') return checkPush(args, dir, ctx, inline);
  if (sub === 'config') return checkConfig(args);
  // a --no-verify prefix anywhere before "--" of a merge-like command, also as an option value (fail closed, as 1.5.2)
  if (MERGE_LIKE.has(sub)) {
    for (const a of args) {
      if (a === '--') break;
      if (isNoVerify(a)) return MSG.hooks;
    }
  }
  if ((sub === 'rm' || sub === 'mv') && args.some((a) => !a.startsWith('-') && isHookPath(a, dir))) return MSG.hookFiles;
  if (Object.hasOwn(GIT_LONG, sub)) return scanArgs(sub, args);
  if (MERGE_LIKE.has(sub) || DATA_SUBS.has(sub)) return null;
  return why(`git subcommand "${short(sub)}" outside the list (an alias from the repository config, an extension, bisect run, submodule foreach)`);
}

function checkCommit(args) {
  let noVerify = false; // the last of --no-verify / --verify wins, as in git
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (t === '--') break;
    if (t.startsWith('--')) {
      const o = option('commit', t);
      if (o.name === 'no-verify') noVerify = !o.neg;
      if (o.arg === 'req' && !o.neg && !o.value) k++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c];
        if (ch === 'n') noVerify = true;
        if ('mFCctU'.includes(ch)) { if (c === t.length - 1) k++; break; } // a value: the rest of the cluster or the next word
        if (ch === 'u' || ch === 'S') break; // -u[<mode>], -S[<key>]: an optional value, only glued
      }
    }
  }
  return noVerify ? MSG.hooks : null;
}

function checkPush(args, dir, ctx, inline) {
  // switches as in git: the last one wins (--tags --no-tags pushes the current branch)
  let force = false; let lease = false; let noVerify = false; let mirror = false; let all = false; let del = false; let tags = false;
  let repo = false; let prune = false;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (t === '--') { pos.push(...args.slice(k + 1)); break; }
    if (t.startsWith('--')) {
      const o = option('push', t); const on = !o.neg;
      if (o.name === 'no-verify') noVerify = on;
      else if (o.name === 'force') force = on;
      else if (o.name === 'force-with-lease' || o.name === 'force-if-includes') lease = lease || on;
      else if (o.name === 'mirror') mirror = on;
      else if (o.name === 'all' || o.name === 'branches') all = on;
      else if (o.name === 'delete') del = on;
      else if (o.name === 'tags') tags = on;
      else if (o.name === 'repo') repo = on;
      else if (o.name === 'prune') prune = on;
      else if ((o.name === 'receive-pack' || o.name === 'exec') && on) why(`git push --${o.name} runs a command`);
      if (o.arg === 'req' && on && !o.value) k++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let c = 1; c < t.length; c++) {
        if (t[c] === 'f') force = true;
        if (t[c] === 'd') del = true;
        if (t[c] === 'o') { if (c === t.length - 1) k++; break; }
      }
      continue;
    }
    pos.push(t);
  }
  if (lease || mirror) force = true;
  if (noVerify) return MSG.hooks;
  let toMain = false; let forceMain = false; let mainToMain = false; let implicit = false; let head = false;
  // --delete / -d: every refspec <ref> deletes :<ref> on the remote. With --repo every positional may be a refspec (git
  // 2.54 takes the first as the repository, but the verdict must not depend on the version). ":" / "+:" — all matching.
  const specs = pos.slice(repo ? 0 : 1).map((s) => (/^\+?:$/.test(s) ? `${s[0] === '+' ? '+' : ''}refs/heads/*:refs/heads/*`
    : del && !s.includes(':') ? `:${s.replace(/^\+/, '')}` : s));
  if (mirror || all) specs.push('refs/heads/*:refs/heads/*');
  // without a refspec a push sends the current branch; "HEAD" / "@" without a colon too
  let branch;
  const cur = () => (branch === undefined ? (branch = ctx.branch(dir)) : branch);
  // --tags without a refspec pushes only tags (not the current branch); --follow-tags pushes the branch and tags
  if (!specs.length && !del && !tags) { implicit = true; specs.push(cur()); }
  for (let spec of specs) {
    const plusRaw = spec.startsWith('+'); const bare = plusRaw ? spec.slice(1) : spec;
    if (bare === 'HEAD' || bare === '@') { head = true; spec = `${plusRaw ? '+' : ''}${cur()}`; }
    const plus = spec.startsWith('+'); const s = plus ? spec.slice(1) : spec;
    const c = s.indexOf(':'); const dst = c < 0 || c === s.length - 1 ? s.slice(0, c < 0 ? s.length : c) : s.slice(c + 1);
    if (!isMainRef(dst)) continue;
    if (plus || force) forceMain = true;
    if (prune && dst.includes('*')) toMain = true; // --prune deletes remote branches under the pattern that are not local
    // another branch pushed onto main always skips the pull request; a plain push main → main only in team mode
    const src = c < 0 ? s : s.slice(0, c);
    if (isMainRef(src)) mainToMain = true; else toMain = true;
  }
  if (forceMain) return MSG.force;
  if (toMain || (mainToMain && ctx.teamMode() === 'team')) return MSG.main;
  // git takes the destination of every refspec without an explicit <dst> (no refspec, a source only, HEAD, @, --all,
  // --tags, --mirror) from the config: remote.<name>.push / .mirror, and push.default for no refspec (review r1 #1). Not
  // certain → no shape: inline -c / --config-env (r1 #2), a possible change earlier in the line (drift), an unreadable
  // config. Only <src>:<dst> on every refspec reads no state.
  const explicit = !implicit && !head && !all && !mirror && !tags && specs.every((x) => x.replace(/^\+/, '').includes(':'));
  if (explicit) return null;
  if (inline) why('inline config may change the push target: name an explicit <src>:<dst> refspec');
  if (ctx.unsure) why('the push target may change earlier in the line: push alone or name an explicit <src>:<dst> refspec');
  const pc = ctx.pushConfig(dir);
  if (pc.remap || (implicit && pc.pushDefault)) why('target from push.default or remote.*.push: name an explicit <src>:<dst> refspec');
  return null;
}

// git config: setting or removing core.hooksPath (also through the core section), include.path, and setting any key that
// runs a command (G152 r3 a). Option values (-f <file>, --type <type> …) are neither key nor value. Short options as
// parse-options reads them: -l -e -z without a value, -f <file> and -t <type> with one (the rest of the cluster or the next
// word; a glued value is never flags). Another letter → no proof.
const CONFIG_SHORT = { l: 'list', e: 'edit', z: 'null', f: '=', t: '=' };
function checkConfig(args) {
  const pos = []; let unset = false; let section = false; let rename = false; let read = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (t === '--') { pos.push(...args.slice(k + 1)); break; }
    if (!t.startsWith('-') || t === '-') { pos.push(t); continue; }
    if (t.startsWith('--')) {
      const o = option('config', t);
      if (o.neg) continue;
      if (o.name.startsWith('unset')) unset = true;
      if (o.name.endsWith('-section')) { section = true; rename = o.name.startsWith('rename'); }
      if (o.name.startsWith('get') || o.name === 'list') read = true; // reading: a later argument is a value pattern
      if (o.arg === 'req' && !o.value) k++;
      continue;
    }
    for (let c = 1; c < t.length; c++) {
      const o = Object.hasOwn(CONFIG_SHORT, t[c]) ? CONFIG_SHORT[t[c]] : why(`git config option "-${short(t[c])}": unknown, write the full name`);
      if (o === '=') { if (c === t.length - 1) k++; break; }
      if (o === 'list') read = true;
    }
  }
  // subcommand syntax (git ≥ 2.46): git config set|unset|get|list|remove-section|rename-section …; get / list read
  const verb = ['set', 'unset', 'get', 'list', 'edit', 'remove-section', 'rename-section'].includes(pos[0]) ? pos.shift() : null;
  if (verb !== null) read = verb === 'get' || verb === 'list';
  if (verb === 'unset') unset = true;
  if (verb === 'remove-section' || verb === 'rename-section') { section = true; rename = verb === 'rename-section'; }
  // a section rename can create any key on the list (review r1 #6): no rename; removing a section — only core is guarded
  if (section) {
    if (pos.slice(0, 2).some((p) => /^core$/i.test(p))) return MSG.hooks;
    return rename ? MSG.execKey(`${pos[1] ?? ''}.*`) : null;
  }
  if (read) return null;
  // the key core.hooksPath among all positionals
  const h = pos.findIndex((p) => /^core\.hookspath$/i.test(p));
  if (h >= 0 && (unset || (pos[h + 1] !== undefined && pos[h + 1] !== '.githooks'))) return MSG.hooks;
  const [key, val] = pos;
  if (key === undefined) return null;
  const kind = h < 0 ? configKey(key) : null; // core.hooksPath — above (the value .githooks is allowed)
  if (kind === 'hooks' && val !== undefined) return MSG.hooks; // include.path, includeIf.*.path
  if (/hookspath$/i.test(key) && h < 0 && (val !== undefined || unset)) why(`git config ${short(key)}`); // e.g. a section to be renamed to core
  if (kind === 'exec' && val !== undefined && !unset) return MSG.execKey(key);
  return null;
}
