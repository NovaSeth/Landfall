// Git config keys the session never sets (spec SD-29, SEC-3, SEC-4): ONE list for every path that sets a key — git -c,
// --config-env, clone -c / --config, fetch / pull --config, submodule, and git config writes. `hooks` keys disable or
// replace hooks (SEC-4); the others make git run their value as a command, or change the command, transport or URL
// (G152 r3 a: blocked whatever the value). `example` is a sample key for the parity test
// (tests/hooks-guard-principle.test.mjs); a new key joins the list and every path at once.
export const CONFIG_DENY = Object.freeze([
  { re: /^core\.hookspath$/i, hooks: true, example: 'core.hooksPath' },
  { re: /^include\.path$/i, hooks: true, example: 'include.path' },
  { re: /^includeif\..+\.path$/i, hooks: true, example: 'includeIf.gitdir:/x/.path' },
  { re: /^core\.(fsmonitor|sshcommand|editor|pager|askpass|gitproxy)$/i, example: 'core.fsmonitor' },
  { re: /^sequence\.editor$/i, example: 'sequence.editor' },
  { re: /^diff\.external$/i, example: 'diff.external' },
  { re: /^diff\..+\.(textconv|command)$/i, example: 'diff.x.textconv' },
  { re: /^merge\..+\.driver$/i, example: 'merge.x.driver' },
  { re: /^filter\..+\.(clean|smudge|process)$/i, example: 'filter.x.smudge' },
  { re: /^credential\.(.+\.)?helper$/i, example: 'credential.https://h.helper' },
  { re: /^gpg\.(.+\.)?program$/i, example: 'gpg.ssh.program' },
  { re: /^ssh\.variant$/i, example: 'ssh.variant' },
  { re: /^uploadpack\.packobjectshook$/i, example: 'uploadpack.packObjectsHook' },
  { re: /^protocol\.(.+\.)?allow$/i, example: 'protocol.ext.allow' },
  { re: /^alias\./i, example: 'alias.x' },
  { re: /^url\..+\.(push)?insteadof$/i, example: 'url.x.insteadOf' },
  { re: /^remote\..+\.(push|mirror|receivepack|uploadpack|vcs|proxy)$/i, example: 'remote.origin.receivepack' }, // remaps pushes or runs a program
  { re: /^submodule\..+\.update$/i, example: 'submodule.x.update' }, // "!command" runs it
  { re: /hookspath/i, example: 'evil.hooksPath' }, // a section to be renamed to core
  // whole families (no loosening of the earlier list): pager.<command>, difftool / mergetool, interactive.diffFilter, gc,
  // and every key that ends in a command name
  { re: /^(diff|merge|filter|credential|gpg|pager|difftool|mergetool|interactive|gc)\./i, example: 'pager.log' },
  { re: /\.(command|cmd|helper|program|textconv|driver|clean|smudge|process|tool)$/i, example: 'difftool.x.cmd' },
]);

// Kind of a key on the list: 'hooks' | 'exec' | null.
export function configKey(key) {
  const e = CONFIG_DENY.find((x) => x.re.test(key));
  return e ? (e.hooks ? 'hooks' : 'exec') : null;
}
