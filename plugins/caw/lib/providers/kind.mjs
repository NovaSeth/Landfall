// Providers files (spec §5.3, §7.12): the machine data file providers.json (user-declared generic adapters and the
// detection cache), checked with the lib/state schema checker and written atomically under its own lock (detect.mjs).
// The run record kinds of §8.5 come with exec and the supervisor.
import { LIMITS, defineKind } from '../state/index.mjs';

export const ROLES = Object.freeze(['reviewer', 'implementer']);
// A provider ID is one lowercase word, so the agent name <provider>-<role>-<task> parses back (spec §7.12 UI).
export const PROVIDER_ID = /^[a-z0-9]{1,20}$/;
export const LAST_LINE = 160;

const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
const time = { t: 'time' };
const nullable = (spec) => ({ ...spec, null: true });

const row = {
  t: 'obj',
  f: {
    id: str(20, { re: PROVIDER_ID }),
    kind: { t: 'enum', of: ['builtin', 'generic'] },
    found: { t: 'enum', of: [true, false] },
    path: nullable(str(LIMITS.path)),
    version: nullable(str(80)),
    auth: { t: 'enum', of: ['ok', 'missing', 'unknown'] },
    roles: { t: 'arr', max: 2, of: { t: 'enum', of: ROLES } },
    sandboxes: { t: 'arr', max: 2, of: str(40) },
    error: nullable(str(300)),
  },
};

export const PROVIDERS = defineKind('providers', 1, {
  dir: '',
  file: () => 'providers.json',
  match: /^providers\.json$/,
  fields: {
    generic: {
      t: 'map', max: 50, key: str(20, { re: PROVIDER_ID }),
      v: { t: 'obj', f: { argv: str(1000, { min: 1 }), sandboxMap: { t: 'obj', opt: ROLES, f: { reviewer: str(40), implementer: str(40) } }, addedAt: time } },
    },
    detected: { t: 'obj', null: true, f: { at: time, rows: { t: 'arr', max: 60, of: row } } },
  },
});
