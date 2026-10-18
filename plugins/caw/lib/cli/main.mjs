// CLI entry (spec §8.1, §8.2): parses argv by the command table, asks for consent before a command form that
// changes files (REV-58; per form: mutates()), runs the command and hands its result to lib/cli/output.mjs, the one
// writer: one JSON envelope line (--json) or text. No command (only --json, if anything) runs the default command,
// `status` (spec §8.2); --help prints the help.
// A StateError the command throws becomes its result here (typedResult), so no command maps them itself.
// A row with a `capability` (spec §14 rollback) is refused here while that capability's flag is off (lib/config: the
// machine override, config.json, the default), naming the flag, before consent and before the command loads.
// main() returns the exit code; the launcher sets it. Names come from lib/name.json, the version from
// .claude-plugin/plugin.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS, DEFAULT_COMMAND, EXIT, EXIT_CODES, GLOBAL_FLAGS, flagKey, mutates } from './commands.mjs';
import { commandUsage, generalUsage, renderCommandHelp, renderHelp } from './help.mjs';
import { processIo, writeHook, writeResult } from './output.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

class Usage extends Error {
  constructor(code, message, { usage, hint }) {
    super(message);
    this.code = code;
    this.usage = usage;
    this.hint = hint;
  }
}

// Global flags anywhere before `--`; the command is the longest row name matching the leading words.
function split(argv, commands) {
  const globals = { json: false, yes: false, help: false, version: false };
  const tokens = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { tokens.push(...argv.slice(i)); break; }
    const g = GLOBAL_FLAGS.find((f) => f.flag === argv[i] || f.alias === argv[i]);
    if (g) globals[g.key] = true;
    else tokens.push(argv[i]);
  }
  const words = [];
  for (const t of tokens) { if (t.startsWith('-')) break; words.push(t); }
  let row = null;
  for (const r of commands) {
    const parts = r.name.split(' ');
    if (parts.length <= words.length && parts.every((p, k) => p === words[k]) && (!row || parts.length > row.name.split(' ').length)) row = r;
  }
  if (!row && tokens.length === 0 && !globals.help && !globals.version) row = commands.find((r) => r.name === DEFAULT_COMMAND) ?? null;
  return { globals, tokens, words, row };
}

// The one place where a typed error of lib/state (StateError: kebab code, the name of an exit code, message,
// hint) becomes a command result, for every command. Any other error, and an INTERNAL one, stays an exception
// (exit 70 with the bug-report hint). The state unit is loaded only here, after a command failed.
async function typedResult(err) {
  const { StateError } = await import('../state/index.mjs');
  if (!(err instanceof StateError) || err.exit === 'INTERNAL' || !Object.hasOwn(EXIT, err.exit)) throw err;
  return { code: EXIT[err.exit], errors: [err] };
}

function parseRow(row, rest, bin) {
  const usage = { usage: commandUsage(row, bin), hint: `run '${bin} ${row.name} --help'` };
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') { positionals.push(...rest.slice(i + 1)); break; }
    if (t.startsWith('-') && t !== '-') {
      const eq = t.startsWith('--') ? t.indexOf('=') : -1;
      const name = eq > 0 ? t.slice(0, eq) : t;
      const f = row.flags.find((x) => x.flag === name || x.alias === name);
      if (!f) throw new Usage('unknown-flag', `unknown flag for ${row.name}: ${name}`, usage);
      if (f.value) {
        const v = eq > 0 ? t.slice(eq + 1) : rest[++i];
        if (v === undefined) throw new Usage('missing-value', `${name} needs a value <${f.value}>`, usage);
        flags[flagKey(f.flag)] = v;
      } else {
        if (eq > 0) throw new Usage('unexpected-value', `${name} takes no value`, usage);
        flags[flagKey(f.flag)] = true;
      }
      continue;
    }
    positionals.push(t);
  }
  const args = {};
  for (const a of row.args) {
    const value = a.variadic ? positionals.splice(0) : positionals.shift();
    if (a.required && (value === undefined || (a.variadic && value.length === 0))) throw new Usage('missing-argument', `${row.name}: missing <${a.name}>`, usage);
    args[a.name] = value;
  }
  if (positionals.length) throw new Usage('unexpected-argument', `${row.name}: unexpected argument: ${positionals[0]}`, usage);
  return { args, flags };
}

export async function main(argv, { commands = COMMANDS, io = processIo() } = {}) {
  const end = argv.indexOf('--');
  const json = (end < 0 ? argv : argv.slice(0, end)).includes('--json');
  let bin = '';
  // The row (and so failOpen) comes from argv alone, before any file is read: a hook fails open even when
  // name.json or plugin.json is missing or broken.
  const { globals, tokens, words, row } = split(argv, commands);
  const failOpen = Boolean(row?.failOpen);
  const command = row ? row.name : words.length ? words[0] : globals.version ? 'version' : 'help';
  try {
    const names = readJson('lib/name.json');
    const { version } = readJson('.claude-plugin/plugin.json');
    bin = names.bin;
    const ctx = { names, commands, globalFlags: GLOBAL_FLAGS, exitCodes: EXIT_CODES };
    const say = (result) => writeResult(io, { json: json && !failOpen, bin, command, result });

    if (globals.version && !failOpen) return say({ data: { name: bin, version }, text: `${bin} ${version}\n` });
    if (!row) {
      const general = { usage: generalUsage(bin), hint: `run '${bin} --help' for the command list` };
      if (words.length) throw new Usage('unknown-command', `unknown command: ${words[0]}`, general);
      const stray = tokens.find((t) => t.startsWith('-'));
      if (stray) throw new Usage('unknown-flag', `unknown flag: ${stray}`, general);
      const text = renderHelp(ctx);
      return say({ data: { usage: text, commands: commands.filter((r) => !r.hidden).map((r) => r.name) }, text });
    }
    if (globals.help) {
      const text = renderCommandHelp(row, ctx);
      return say({ data: { usage: text }, text });
    }
    const { args, flags } = parseRow(row, tokens.slice(row.name.split(' ').length), bin);
    if (row.capability) {
      const { capabilityMode } = await import('../config/index.mjs');
      let mode;
      try {
        mode = capabilityMode(row.capability, { cwd: io.cwd, env: io.env, names });
      } catch (err) {
        return say(await typedResult(err));
      }
      if (mode === 'off') {
        return say({ code: EXIT.REFUSED, errors: [{ code: 'capability-off', message: `the ${row.capability} capability is off (flags.${row.capability}): ${row.name} is refused`, hint: `turn it back on with '${bin} flags set ${row.capability} <mode>' ('${bin} flags show' lists the modes)` }] });
      }
    }
    if (mutates(row, flags) && !globals.yes && !io.stdinIsTTY) {
      return say({ code: EXIT.REFUSED, errors: [{ code: 'consent-required', message: `${row.name} changes files and no terminal is attached to confirm`, hint: `rerun with --yes to consent, or run it in a terminal` }] });
    }
    const impl = await row.load();
    let result;
    try {
      result = await impl({ args, flags, names, version, io, json, pluginRoot: PLUGIN_ROOT });
    } catch (err) {
      if (failOpen) throw err;
      result = await typedResult(err);
    }
    if (failOpen) {
      writeHook(io, result);
      return result?.hookExit === 2 ? 2 : EXIT.OK; // 2: Claude Code's blocking exit code (a guard that cannot verify)
    }
    // A command returns only the exit codes its row lists (docs/cli.md shows them); anything else is a bug.
    const code = result?.code ?? (result?.errors?.length ? EXIT.FAIL : EXIT.OK);
    const name = EXIT_CODES.find((e) => e.code === code)?.name;
    if (!name || !row.exits.includes(name)) throw new Error(`${row.name} returned exit ${code} ${name ?? 'unknown'}, which its row does not list`);
    return say(result ?? {});
  } catch (err) {
    // a hook whose code failed before it read its input: the launcher applies the registry's error policy (bin/)
    if (failOpen) throw err;
    if (err instanceof Usage) return writeResult(io, { json, bin, command, result: { code: EXIT.USAGE, errors: [{ code: err.code, message: err.message, hint: err.hint }], usage: err.usage } });
    const hint = `run '${bin ? `${bin} ` : ''}doctor --json' and attach its output to an issue`;
    return writeResult(io, { json, bin: bin || 'error', command, result: { code: EXIT.INTERNAL, errors: [{ code: 'internal', message: `internal error: ${err?.message ?? err}`, hint }] } });
  }
}
