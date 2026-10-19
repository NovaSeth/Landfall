// Provider selection (spec §7.12 Adapters): the dispatch code never names a provider. It takes the role preferences
// (config.json executors; until lib/config is merged: none, so the registry order of the detection rows), keeps the
// providers that are found, logged in (auth ok) and allow the role, and picks the first. An explicit --provider must
// be found, allow the role and not be logged out (an unknown auth may run: there is no probe for it).
import { StateError } from '../state/index.mjs';

const env = (code, message, hint) => new StateError(code, 'ENV', message, { hint });
const usage = (code, message, hint) => new StateError(code, 'USAGE', message, { hint });

export function chooseProvider({ role, rows, preferences = {}, explicit }) {
  if (explicit !== undefined) {
    const r = rows.find((x) => x.id === explicit);
    if (!r) throw usage('provider-unknown', `no provider ${String(explicit).slice(0, 40)}`, `known: ${rows.map((x) => x.id).join(', ') || 'none'}`);
    if (!r.roles.includes(role)) throw usage('provider-role', `${r.id} is not declared for the ${role} role`, `its roles: ${r.roles.join(', ') || 'none'}`);
    if (!r.found) throw env('provider-missing', `${r.id} is not on PATH`, 'install it, or pick another provider');
    if (r.auth === 'missing') throw env('provider-not-logged-in', `${r.id} is not logged in`, 'log in with that CLI, then retry');
    return r;
  }
  const order = [...(preferences[role] ?? []), ...rows.map((x) => x.id)];
  for (const id of order) {
    const r = rows.find((x) => x.id === id);
    if (r && r.found && r.auth === 'ok' && r.roles.includes(role)) return r;
  }
  throw env('no-provider', `no provider is found and logged in for the ${role} role`, 'install and log in to a provider CLI, or declare one with providers add');
}
