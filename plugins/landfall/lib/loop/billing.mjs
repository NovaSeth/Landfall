// The billing mode of the Claude Code session (T-MG-104): on a subscription no money is billed per token, so the
// token-times-API-price cost of a loop is an estimate that must not end it. billingMode is pure apart from one file
// read and never throws. Order: the override env <PREFIX>BILLING, API signals in the environment, the account file
// of Claude Code (only oauthAccount.billingType is read; the file also holds the e-mail address, which never leaves
// this function), otherwise unknown (real money is assumed: the cost cap stays on).
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

export function billingMode({ env, names, home } = {}) {
  try {
    const e = env && typeof env === 'object' ? env : {};
    const name = `${names?.envPrefix ?? ''}BILLING`;
    const forced = e[name];
    if (typeof forced === 'string' && forced !== '') {
      if (forced === 'api' || forced === 'subscription') return { mode: forced, source: name };
      return { mode: 'unknown', source: `${name} is not recognized (api or subscription)` };
    }
    for (const k of KEYS) if (typeof e[k] === 'string' && e[k] !== '') return { mode: 'api', source: k };
    for (const k of FLAGS) if (e[k] === '1' || e[k] === 'true') return { mode: 'api', source: k };
    const dir = typeof e.CLAUDE_CONFIG_DIR === 'string' && e.CLAUDE_CONFIG_DIR !== '' ? e.CLAUDE_CONFIG_DIR : (home ?? homedir());
    const type = billingType(join(dir, '.claude.json'));
    if (type !== null && type.toLowerCase().includes('subscription')) return { mode: 'subscription', source: 'claude.json billingType' };
    return { mode: 'unknown', source: 'no billing signal found' };
  } catch {
    return { mode: 'unknown', source: 'billing could not be determined' };
  }
}
