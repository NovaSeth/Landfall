// `<bin> providers [--refresh]` and `<bin> providers add <id> --argv <t> --sandbox-map <m>` (spec §7.12, §8.2).
import { addProvider, detectProviders } from './index.mjs';

const line = (r) => `  ${r.id.padEnd(10)} ${r.found ? (r.version ?? 'version unknown') : 'not found'}  auth ${r.auth}  ${r.roles.map((role, i) => `${role}=${r.sandboxes[i]}`).join(' ')}${r.error ? `  (${r.error})` : ''}`;

export function providers({ flags, names, io }) {
  const d = detectProviders({ names, env: io.env, refresh: Boolean(flags.refresh) });
  const head = `Providers (${d.cached ? `cached ${d.at}` : `detected ${d.at}`}):`;
  return { data: { at: d.at, cached: d.cached, rows: d.rows }, text: `${[head, ...d.rows.map(line)].join('\n')}\n` };
}

export function providersAdd({ args, flags, names, io }) {
  const entry = addProvider({ names, env: io.env, id: args.id, argv: flags.argv, sandboxMap: flags.sandboxMap, envNames: flags.env });
  return { data: entry, text: `declared ${entry.id}: ${entry.argv} (${entry.roles.join(', ')})\n` };
}
