// Gen unit (spec §4.2, §7.14, §7.14a, SD-35, GC9): templates, 3-way merge, hunk survival. The public interface;
// other units import only this file. Gen is the only unit that writes outside the state directory inside the
// repository, and only the target paths of TARGETS and their side files (spec §4.3); its own record goes through
// lib/state.
export { DEFAULT_OPTIONS, checkOptions, packageSpec } from './options.mjs';
export { TARGETS, render, sideSuffix, targetFlags } from './targets.mjs';
export { blockMarkers, wrapBlock } from './block.mjs';
export { MANIFEST, openStore, readManifest } from './manifest.mjs';
export { OK_ACTIONS, applyGen, targetItems } from './apply.mjs';
export { trackedSideFiles } from './tracked.mjs';
