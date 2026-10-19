// `<bin> hook <name>` (spec §7.13, GC8): reads the hook event JSON from stdin until end of input or the input deadline
// (INPUT_DEADLINE_MS, measured from the start of reading: node startup under load does not eat into it), whichever comes
// first, and runs the registry hook. Its command row fails open: any error ends with exit 0 and no output. Input still
// incomplete at the deadline is unverifiable for a guard (lib/hooks/registry.mjs: guard-bash blocks it) and allowed
// by the other hooks; a read error counts as malformed (allow); input over the size cap goes to the hook's oversize rule
// (guard-bash blocks it whatever the content, the others allow). A hook's warnings go to stderr; a hook that blocks
// without a decision JSON (the guard could not verify a command, lib/hooks/registry.mjs onError) ends with exit 2.
import { INPUT_DEADLINE_MS, runHook } from '../hooks/registry.mjs';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

// Result { text, oversize, incomplete }: the input; its first maxBytes when oversize; what arrived, with incomplete,
// when the deadline came first; text null on a read error.
export function readInput(stdin, { deadlineMs = INPUT_DEADLINE_MS, maxBytes = MAX_INPUT_BYTES } = {}) {
  if (!stdin) return Promise.resolve({ text: null, oversize: false, incomplete: false });
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      if (state !== 'end') stdin.destroy();
      resolve({ text: state === 'fail' ? null : Buffer.concat(chunks).toString('utf8'), oversize: state === 'oversize', incomplete: state === 'late' });
    };
    const timer = setTimeout(() => finish('late'), deadlineMs);
    stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length)))); finish('oversize'); }
      else chunks.push(chunk);
    });
    stdin.on('end', () => finish('end'));
    stdin.on('error', () => finish('fail'));
  });
}

export async function hook({ args, io }) {
  const { text, oversize, incomplete } = io.stdinIsTTY ? { text: null, oversize: false, incomplete: false } : await readInput(io.stdin);
  const r = runHook(args.name, text, { oversize, incomplete });
  return { text: r.stdout, stderr: r.stderr, hookExit: r.code === 2 ? 2 : 0 }; // written unchanged by lib/cli/output.mjs
}
