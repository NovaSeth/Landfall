// The billing mode of the Claude Code session (T-MG-104): on a subscription no money is billed per token, so the
// token-times-API-price cost of a loop is an estimate that must not end it. billingMode is pure apart from one file
// read and never throws. Order: the override env <PREFIX>BILLING, API signals in the environment, the account file
// of Claude Code (only oauthAccount.billingType is read; the file also holds the e-mail address, which never leaves
// this function; it is the config directory Claude Code itself uses), otherwise unknown (real money is assumed: the cost cap stays on).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;
const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

function billingType(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    const type = JSON.parse(buf.toString('utf8', 0, got))?.oauthAccount?.billingType;
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}

// envOnly: steps 1-2 only (the account file is read at the loop creation, never by a tick).
// byUser: the loop is started from a terminal. Only then does the override `subscription` count (it switches the cost cap
// off); `api` always counts (it only tightens). Without byUser the override `subscription` is ignored and the steps 2-4 decide.
export function billingMode({ env, names, home, byUser = false, envOnly = false } = {}) {
  try {
    const e = env && typeof env === 'object' ? env : {};
    const name = `${names?.envPrefix ?? ''}BILLING`;
    const forced = e[name];
    let note = null;
    if (typeof forced === 'string' && forced !== '') {
      if (forced === 'api' || (forced === 'subscription' && byUser)) return { mode: forced, source: name };
      if (forced !== 'subscription') note = `${name}=${JSON.stringify(forced.slice(0, 40))} is not recognized`;
    }
    const by = (source) => (note === null ? source : `${source} (${note})`);
    for (const k of KEYS) if (typeof e[k] === 'string' && e[k] !== '') return { mode: 'api', source: by(k) };
    for (const k of FLAGS) if (e[k] === '1' || e[k] === 'true') return { mode: 'api', source: by(k) };
    if (envOnly) return { mode: 'unknown', source: note ?? 'no billing signal in the environment' };
    const dir = typeof e.CLAUDE_CONFIG_DIR === 'string' && e.CLAUDE_CONFIG_DIR !== '' ? e.CLAUDE_CONFIG_DIR : (home ?? homedir());
    const type = billingType(join(dir, '.claude.json'));
    if (type !== null && type.toLowerCase().includes('subscription')) return { mode: 'subscription', source: by('claude.json billingType') };
    return { mode: 'unknown', source: note ?? 'no billing signal found' };
  } catch {
    return { mode: 'unknown', source: 'billing could not be determined' };
  }
}
