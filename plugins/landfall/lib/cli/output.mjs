// Output (S2; spec §8.1; security guide §3.7): the one writer of everything the CLI prints. A command returns its
// result; main.mjs hands it here. No other file writes to stdout or stderr (tests/architecture.test.mjs); the
// launcher writes only its own line when the CLI cannot load.
//   text (stdout) and warning, error, hint and usage lines (stderr): through lib/text/clean.mjs forTerminal, so no
//     escape sequence (CSI, OSC, C1), control, bidi or invisible character of any data (titles, facts, decisions,
//     paths, argv, the output of other programs) reaches a terminal; the printable text stays
//   the JSON envelope (--json): one line, its data escaped, never removed (forJson: the characters JSON.stringify
//     leaves raw become \u escapes), so the line is inert and JSON.parse gives the data back
//   hook output: Claude Code protocol (decision JSON on stdout, a reason on stderr), passed on unchanged; the hooks
//     build it with forModel
import { isatty } from 'node:tty';
import { forJson, forTerminal } from '../text/clean.mjs';
import { EXIT } from './commands.mjs';
import { envelope, normalizeError } from './envelope.mjs';

// The streams and context of this process; tests pass their own { out, err, stdin, stdinIsTTY, env, cwd }.
export function processIo() {
  return {
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
    get stdin() { return process.stdin; }, // created only when a command reads it
    stdinIsTTY: isatty(0),
    env: process.env,
    cwd: process.cwd(),
  };
}

// Prints a command result { code?, data?, errors?, text?, warnings?, usage? }: one envelope line (json), or the
// text, then warnings, errors with hints and the usage line. Returns the exit code.
export function writeResult(io, { json, bin, command, result }) {
  const errors = (result.errors ?? []).map(normalizeError);
  const code = result.code ?? (errors.length ? EXIT.FAIL : EXIT.OK);
  if (json) {
    io.out(`${forJson(JSON.stringify(envelope({ command, code, data: result.data ?? {}, errors })))}\n`);
    return code;
  }
  if (result.text) io.out(forTerminal(result.text));
  for (const w of result.warnings ?? []) io.err(forTerminal(`warning: ${w}\n`));
  for (const e of errors) io.err(forTerminal(`${bin}: ${e.message}\n${e.hint ? `  hint: ${e.hint}\n` : ''}`));
  if (result.usage) io.err(forTerminal(`${result.usage}\n`));
  return code;
}

// A question at a terminal (`trust`): the prompt on stderr, then one answer line from stdin (at most 200 characters;
// '' at the end of input). The caller checks io.stdinIsTTY first.
export function ask(io, question) {
  io.err(forTerminal(question));
  return new Promise((done) => {
    const s = io.stdin;
    if (!s) { done(''); return; }
    let buf = '';
    const finish = () => {
      s.off('data', onData);
      s.off('end', finish);
      s.off('error', finish);
      s.pause?.();
      done(buf.split('\n')[0].slice(0, 200));
    };
    const onData = (c) => {
      buf += String(c);
      if (buf.includes('\n') || buf.length > 200) finish();
    };
    s.on('data', onData);
    s.once('end', finish);
    s.once('error', finish);
  });
}

// A hook's result { text, stderr }: protocol for Claude Code, unchanged.
export function writeHook(io, result) {
  if (result?.stderr) io.err(result.stderr);
  if (result?.text) io.out(result.text);
}

// A detached process whose parent closed the pipes: an EPIPE on the terminal streams must not end it (the run
// supervisor writes its record and log through lib/state, never to these streams).
export function tolerateClosedStreams() {
  for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
}
