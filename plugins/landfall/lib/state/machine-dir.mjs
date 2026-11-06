// The machine data directory (spec §5.3): a leaf module so that resolve.mjs and the migrations both reach it without
// importing each other.
import { isAbsolute, join } from 'node:path';
import { requireArg } from './document.mjs';

const absolute = (v) => (typeof v === 'string' && isAbsolute(v) ? v : null);

// Spec §5.3: $CLAUDE_PLUGIN_DATA → $CLAUDE_CODE_PLUGIN_CACHE_DIR/data/<id> → ${CLAUDE_CONFIG_DIR:-$HOME/.claude}
// /plugins/data/<id>, <id> = <plugin>-<marketplace>. Relative values are ignored; null when nothing is set.
export function machineDataDir(names, env) {
  requireArg(names, 'names', 'machineDataDir');
  requireArg(env, 'env', 'machineDataDir');
  const id = `${names.plugin}-${names.marketplace}`;
  if (absolute(env.CLAUDE_PLUGIN_DATA)) return env.CLAUDE_PLUGIN_DATA;
  if (absolute(env.CLAUDE_CODE_PLUGIN_CACHE_DIR)) return join(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, 'data', id);
  const config = absolute(env.CLAUDE_CONFIG_DIR) ?? (absolute(env.HOME) ? join(env.HOME, '.claude') : null);
  return config ? join(config, 'plugins', 'data', id) : null;
}
