// Providers unit (spec §4.2, §7.12): the public interface. Other units import only this file. Owns
// ${CLAUDE_PLUGIN_DATA}/providers.json (registry.mjs); the adapters are lib/providers/<id>.mjs.
export { BUILTINS, CACHE_MS, addProvider, adapters, detectProviders } from './registry.mjs';
export { chooseProvider } from './select.mjs';
export { PROVIDER_ID, ROLES } from './kind.mjs';
