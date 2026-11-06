// Builtins that set the shell variable they name (T-MG-176): one list for the tokenizer (literal substitution, loop bodies) and
// the shapes (variables that run code), so they cannot drift. zsh: print -v, vared, zparseopts, zformat -f, zstyle -g, getln,
// strftime -s, zregexparse, sysread; bash: compgen -V, mapfile, read, printf -v, getopts.
export const SETTER_WORDS = Object.freeze(['read', 'mapfile', 'readarray', 'printf', 'print', 'compgen', 'vared', 'zparseopts', 'zformat', 'zstyle',
  'getln', 'strftime', 'zregexparse', 'sysread', 'getopts']);
export const DECL_WORDS = Object.freeze(['export', 'declare', 'local', 'readonly', 'typeset']);
