// `<bin> install` (spec SD-3, §7.1 steps 1–2, §8.2: the npx channel, `npx --yes github:<owner>/<repo> install`): the
// install for an agent without the plugin. It runs the SD-3 commands: `claude plugin install <plugin> --marketplace
// <owner>/<repo>`, and when that exits non-zero the two-command fallback (`claude plugin marketplace add <owner>/<repo>`,
// then `claude plugin install <plugin>@<marketplace>`); then it checks `claude plugin list --json` for the plugin enabled.
// Without `claude` on PATH it prints those commands and exits 0. It never writes a file itself: Claude Code keeps its
// own records (settings, plugin cache), and nothing lands in a project (spec §7.1 step 4). No consent prompt: running it
// is the install the user asked for, like the README command it replaces.
// Exit 0 installed and enabled, or the commands printed · 1 the plugin is not enabled afterwards (the outputs say why).
import { run } from '../proc/index.mjs';
import { EXIT } from './commands.mjs';

const TIMEOUT_MS = 180000; // a marketplace clone over a slow network; well under the Bash tool's 600 s cap
const tail = (s) => String(s ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);

// The SD-3 commands for these names: { install, fallback: [add, install] } as argv lists for `claude`.
export function sd3Commands(names) {
  const source = String(names.repository).replace(/^github:/, '');
  return {
    install: ['plugin', 'install', names.plugin, '--marketplace', source],
    fallback: [['plugin', 'marketplace', 'add', source], ['plugin', 'install', `${names.plugin}@${names.marketplace}`]],
  };
}
const RELOAD = 'Then type /reload-plugins in Claude Code (or restart it); that is the only manual step.';

export function install({ names, io }) {
  const cmds = sd3Commands(names);
  const id = `${names.plugin}@${names.marketplace}`;
  const claude = (args) => {
    const r = run('claude', args, { unit: 'cli', cwd: io.cwd, env: io.env, timeoutMs: TIMEOUT_MS });
    return { argv: ['claude', ...args], exit: r.status, error: r.error, output: tail(r.stderr || r.stdout) };
  };
  const first = claude(cmds.install);
  if (first.error === 'missing') {
    const text = [
      '`claude` is not on PATH. Install the plugin from a terminal where it is:',
      `  claude ${cmds.install.join(' ')}`,
      'If that exits non-zero, add the marketplace, then install from it:',
      ...cmds.fallback.map((c) => `  claude ${c.join(' ')}`),
      RELOAD,
    ].join('\n');
    return { data: { claude: false, commands: [cmds.install, ...cmds.fallback].map((c) => ['claude', ...c]), ran: [], plugin: id, enabled: null }, text: `${text}\n` };
  }
  const ran = [first];
  if (first.exit !== 0) for (const c of cmds.fallback) ran.push(claude(c));
  const list = run('claude', ['plugin', 'list', '--json'], { unit: 'cli', cwd: io.cwd, env: io.env, timeoutMs: 30000 });
  let entry = null;
  try { entry = JSON.parse(list.stdout).find((p) => p?.id === id) ?? null; } catch { entry = null; }
  const enabled = entry?.enabled === true;
  const lines = ran.map((r) => `$ ${r.argv.join(' ')}  → ${r.error ? r.error : `exit ${r.exit}`}${r.exit !== 0 && r.output ? `: ${r.output}` : ''}`);
  const data = { claude: true, commands: [cmds.install, ...cmds.fallback].map((c) => ['claude', ...c]), ran, plugin: id, enabled };
  if (!enabled) {
    return {
      code: EXIT.FAIL, data, text: `${lines.join('\n')}\n`,
      errors: [{ code: 'not-enabled', message: `${id} is not ${entry ? 'enabled' : 'installed'} after the install commands (claude plugin list --json)`, hint: `run the commands above by hand to see why; then claude plugin enable ${id}` }],
    };
  }
  return { data, text: `${[...lines, `${id} is installed and enabled.`, RELOAD].join('\n')}\n` };
}
