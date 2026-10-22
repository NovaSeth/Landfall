// Forward migrations (spec SD-10, GC9): one module per step in this directory, named `NNN-<kind>-<name>.mjs`
// (NNN = 001, 002, … across all kinds), each with a default export
//   { id: 'NNN-<kind>-<name>', kind, from, to: from + 1, up(doc) → doc, carry? }
// `up` is pure (no I/O, gets a copy, may not drop data the new schema can hold) and the engine stamps the new
// schema. Data the new schema of the kind cannot hold moves to another single-file kind through `carry`:
// { kind, into(target | null, source) → target document | undefined (nothing to carry) }, pure as well, with the
// source at schema `from`; lib/state applies it on read (store.read and store.update of the target) and in migrate.
// Import every module here and list it in NNN order: tests/state-migrate.test.mjs checks this list against the
// directory and each kind's chain from 1 to its version (lib/state/kinds.mjs).
// Layout steps move directories (the rename of the plugin, D-MG-1) and are listed apart: `<bin> migrate` runs them
// before the document chain; checkChain does not see them.
import stateFlagsToConfig from './001-state-flags-to-config.mjs';
import renameStateDir from './002-rename-state-dir.mjs';
import profileSaidGlobs from './003-profile-said-globs.mjs';

export const MIGRATIONS = Object.freeze([stateFlagsToConfig, profileSaidGlobs]);
export const LAYOUTS = Object.freeze([renameStateDir]);
