// Usage: tidy [--verbose] [--quiet] [--help] <dir>

export function parseArgs(argv) {
  const opts = { verbose: false, quiet: false, help: false, dir: null };
  for (const arg of argv) {
    if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--quiet') opts.quiet = true; // print errors only
    else if (arg === '--help') opts.help = true;
    else opts.dir = arg;
  }
  return opts;
}

export function createLogger({ verbose, quiet }, out = console) {
  return {
    info: (message) => { if (!quiet) out.log(message); },
    debug: (message) => { if (verbose && !quiet) out.log(message); },
    error: (message) => out.error(message),
  };
}
