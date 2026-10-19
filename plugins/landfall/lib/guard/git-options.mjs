// Git option tables of the Bash guard (spec SD-29, SEC-3): global options, the subcommand lists and one table of long
// options per inspected subcommand. An inspected subcommand's arguments are read like git's parse-options reads them:
// a value-taking option consumes its value, an abbreviation resolves to the one option it prefixes, an unknown or
// ambiguous long option has no proof (the caller blocks). tests/hooks-guard-options.test.mjs checks every table against
// the installed git.

// Global options (git.c): full names only, no abbreviation and no glued value for -C / -c. --exec-path prints the path;
// --exec-path=<dir> runs git commands from that directory (like GIT_EXEC_PATH) and has no shape.
export const GIT_ARG = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--shallow-file', '--attr-source']);
export const GIT_FLAG = /^(-[pPvh]|--(paginate|no-pager|no-replace-objects|bare|(literal|glob|noglob|icase)-pathspecs|no-optional-locks|no-lazy-fetch|no-advice|exec-path|html-path|man-path|info-path|version|help)|--(git-dir|work-tree|namespace|super-prefix|shallow-file|attr-source|list-cmds)=.*)$/;
// Subcommands whose arguments are data (reading, or a local change without pre-push hooks and without running code).
export const DATA_SUBS = new Set(['log', 'show', 'diff', 'status', 'add', 'branch', 'checkout', 'switch', 'restore', 'fetch', 'ls-files',
  'ls-remote', 'rev-parse', 'grep', 'blame', 'describe', 'shortlog', 'tag', 'reset', 'rm', 'mv', 'init', 'clone', 'remote', 'worktree',
  'notes', 'reflog', 'cat-file', 'for-each-ref', 'symbolic-ref', 'merge-base', 'help', 'version', 'gc', 'clean', 'format-patch', 'apply',
  'range-diff', 'whatchanged', 'show-ref', 'name-rev', 'check-ignore', 'check-attr', 'hash-object', 'update-ref', 'update-index',
  'sparse-checkout', 'archive', 'bundle', 'fsck', 'count-objects', 'var', 'cherry', 'stripspace', 'interpret-trailers', 'verify-commit',
  'verify-tag', 'show-branch', 'rev-list', 'diff-tree', 'diff-index', 'diff-files', 'ls-tree', 'write-tree', 'read-tree', 'commit-tree',
  'mktree', 'prune', 'repack', 'pack-refs', 'maintenance', 'request-pull']);
// With commit-msg / pre-merge-commit / pre-rebase hooks: only --no-verify (and its abbreviations) is blocked.
export const MERGE_LIKE = new Set(['merge', 'rebase', 'am', 'pull', 'cherry-pick', 'revert']);
// Builtins (for the prescan: another word after `git` may be an alias from the repository config).
export const GIT_BUILTINS = new Set([...DATA_SUBS, ...MERGE_LIKE, 'bisect', 'commit', 'config', 'difftool', 'filter-branch', 'mergetool', 'push',
  'replace', 'stash', 'submodule', 'citool', 'gui', 'send-email']);

// Long options per subcommand (git 2.54, `git <subcommand> -h`, plus the hidden ones that make a prefix ambiguous): "=" a required value (the next word or after =), "?" an
// optional value (only after =), "!" no --no-… negation. config: the classic mode and the subcommands together.
const opts = (spec) => spec.split(' ').map((x) => ({ name: x.replace(/[=?!]/g, ''), arg: x.endsWith('=') ? 'req' : x.endsWith('?') ? 'opt' : 'none', noneg: x.startsWith('!') }));
export const GIT_LONG = Object.freeze({
  push: opts('verbose quiet repo= all branches mirror delete tags dry-run porcelain force force-with-lease? force-if-includes recurse-submodules= '
    + 'thin receive-pack= exec= set-upstream progress prune no-verify follow-tags signed? atomic push-option= !ipv4 !ipv6'),
  commit: opts('quiet verbose file= author= date= message= reedit-message= reuse-message= fixup= squash= reset-author trailer= signoff template= '
    + 'edit cleanup= status gpg-sign? all include interactive patch !unified= !inter-hunk-context= only no-verify dry-run short branch ahead-behind '
    + 'porcelain long null amend no-post-rewrite untracked-files? pathspec-from-file= pathspec-file-nul allow-empty allow-empty-message'),
  config: opts('global system local worktree file= blob= !get !get-all !get-regexp !get-urlmatch !replace-all !add !unset !unset-all '
    + '!rename-section !remove-section !list !edit !get-color !get-colorbool null name-only show-origin show-scope show-names type= !bool !int '
    + '!bool-or-int !bool-or-str !path !expiry-date default= comment= fixed-value includes all regexp value= url= append'),
  clone: opts('verbose quiet progress reject-shallow no-checkout bare mirror local no-hardlinks shared recurse-submodules? recursive? jobs= '
    + 'template= reference= reference-if-able= dissociate origin= branch= revision= upload-pack= depth= shallow-since= shallow-exclude= '
    + 'single-branch tags shallow-submodules separate-git-dir= ref-format= config= server-option= !ipv4 !ipv6 filter= also-filter-submodules '
    + 'remote-submodules sparse bundle-uri='),
  fetch: opts('verbose quiet all set-upstream append atomic upload-pack= force multiple tags jobs= prefetch prune prune-tags recurse-submodules? recurse-submodules-default= '
    + 'dry-run porcelain write-fetch-head keep update-head-ok progress depth= shallow-since= shallow-exclude= deepen= !unshallow !refetch '
    + 'update-shallow !refmap= server-option= !ipv4 !ipv6 negotiation-tip= negotiation-restrict= negotiation-include= negotiate-only filter= auto-maintenance auto-gc show-forced-updates '
    + 'write-commit-graph stdin'),
  pull: opts('verbose quiet progress recurse-submodules? rebase? stat summary compact-summary log? signoff? squash commit edit cleanup= ff !ff-only '
    + 'verify verify-signatures autostash strategy= strategy-option= gpg-sign? allow-unrelated-histories all append upload-pack= force tags '
    + 'prune jobs= dry-run keep depth= shallow-since= shallow-exclude= deepen= !unshallow update-shallow !refmap= server-option= ipv4 ipv6 '
    + 'negotiation-tip= negotiation-restrict= negotiation-include= show-forced-updates set-upstream'),
  'ls-remote': opts('quiet upload-pack= exec= tags branches heads refs get-url sort= exit-code symref server-option='),
  grep: opts('cached no-index untracked exclude-standard recurse-submodules invert-match ignore-case word-regexp text textconv recursive '
    + '!max-depth= extended-regexp basic-regexp fixed-strings perl-regexp line-number column full-name files-with-matches name-only '
    + 'files-without-match null only-matching count color? break heading context= !before-context= !after-context= threads= show-function '
    + 'function-context !and !or !not quiet all-match open-files-in-pager? ext-grep max-count='),
  rebase: opts('onto= keep-base keep-empty ignore-date no-verify quiet verbose no-stat trailer= signoff committer-date-is-author-date reset-author-date ignore-whitespace '
    + 'whitespace= force-rebase no-ff !continue !skip !abort !quit !edit-todo !show-current-patch !apply !merge !interactive rerere-autoupdate '
    + '!empty= autosquash update-refs gpg-sign? autostash exec= rebase-merges? fork-point strategy= strategy-option= root reschedule-failed-exec '
    + 'reapply-cherry-picks'),
  init: opts('template= bare !shared? quiet separate-git-dir= initial-branch= object-format= ref-format='),
  archive: opts('format= prefix= add-file= add-virtual-file= output= worktree-attributes verbose !mtime= list remote= exec='),
});
// What a long option does beyond taking a value, by name, in every table: runs a command (exec), sets a config key
// (config), takes hooks and config from a directory (template), skips hooks (no-verify).
export const LONG_KIND = Object.freeze({ 'upload-pack': 'exec', 'receive-pack': 'exec', exec: 'exec', 'open-files-in-pager': 'exec',
  config: 'config', template: 'template', 'no-verify': 'no-verify' });
// Short options per inspected subcommand (`git <subcommand> -h`): flags; value letters (the rest of the cluster or the
// next word is the value, never flags); optional-value letters (only the rest of the cluster); letters that run a command
// (exec) or set a config key (config). Another letter has no proof. ls-remote -u: no such switch, blocked as exec anyway.
export const GIT_SHORT = Object.freeze({
  clone: { flags: '46lnqsv', value: 'jobuc', exec: 'u', config: 'c' },
  fetch: { flags: '46afkmnpPqtuv', value: 'jo' },
  pull: { flags: '46afknpqtv', value: 'osX', optional: 'Srj' },
  'ls-remote': { flags: 'bhqt', value: 'ou', exec: 'u' },
  grep: { flags: 'acEFGhHIilLnopPqrvwWz0123456789', value: 'ABCefm', optional: 'O', exec: 'O' },
  rebase: { flags: 'fimnqv', value: 'CsXx', optional: 'Sr', exec: 'x' },
  init: { flags: 'q', value: 'b' },
  archive: { flags: 'lv0123456789', value: 'o' },
});

// A long option as git's parse-options reads it: the exact name (also --no-X, and for an option named no-X also --X and
// --no-no-X), otherwise a unique prefix. Without a value, --n and --no also prefix every negated option: ambiguous, as
// in git. Result { name, arg, noneg, neg, value } or null (ambiguous or unknown).
export function longOpt(table, t) {
  const eq = t.indexOf('='); let start = t.slice(2, eq < 0 ? t.length : eq); let unset = false; let nono = false;
  if (eq < 0 && (start === 'n' || start === 'no') && table.some((o) => !o.noneg)) return null;
  if (start.startsWith('no-')) { start = start.slice(3); if (start.startsWith('no-')) { start = start.slice(3); nono = true; } else unset = true; }
  let hit = null; let many = false;
  for (const o of table) {
    let name = o.name; let ou = false;
    if (name.startsWith('no-')) { name = name.slice(3); ou = true; } else if (nono) continue;
    const neg = unset !== ou;
    if (neg && o.noneg) continue;
    if (name === start) return { ...o, neg, value: eq >= 0 };
    if (name.startsWith(start)) { many = hit !== null; hit = { ...o, neg, value: eq >= 0 }; if (many) break; }
  }
  return many ? null : hit;
}
