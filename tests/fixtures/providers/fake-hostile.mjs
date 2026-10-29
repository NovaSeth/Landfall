#!/usr/bin/env node
// Hostile fake provider for the external-run hardening tests (T-MG-86), declared as a generic adapter:
//   node fake-hostile.mjs <mode> {out} {sandbox} {cwd}
// It reads the prompt from stdin, writes { mode, sandbox, cwd, pid, env (its whole environment) } to <out>.args, then:
//   esc     an ANSI-coloured line and a line with a tab, the review JSON to <out>, exit 0
//   flood   10 MiB without a newline on stdout (in 64 KiB writes), then one short line, exit 0
//   secret  a line holding a token-shaped value (built at run time: no literal in this file), exit 0
//   mixed   stdout and stderr lines written in pieces that interleave, exit 0
// Nothing spins the CPU; every output is bounded.
import { writeFileSync } from 'node:fs';

const [mode, out, sandbox, cwd] = process.argv.slice(2);
const review = { verdict: 'approved', reviewer: { kind: 'external', id: 'fake' }, findings: [] };
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  writeFileSync(`${out}.args`, `${JSON.stringify({ mode, sandbox, cwd, pid: process.pid, env: process.env })}\n`);
  const end = () => { writeFileSync(out, JSON.stringify(review)); setTimeout(() => process.exit(0), 50); };
  if (mode === 'esc') {
    process.stdout.write('\u001b[31mred status\u001b[0m\n');
    process.stdout.write('col1\tcol2\n');
    end();
  } else if (mode === 'flood') {
    const piece = 'x'.repeat(64 * 1024);
    let n = 0;
    const more = () => {
      while (n < 160) {
        n += 1;
        if (!process.stdout.write(piece)) { process.stdout.once('drain', more); return; }
      }
      process.stdout.write('\nafter the flood\n');
      end();
    };
    more();
  } else if (mode === 'secret') {
    const token = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'].join('');
    process.stdout.write(`leaked ${token} here\n`);
    end();
  } else if (mode === 'mixed') {
    process.stdout.write('{"out":');
    process.stderr.write('err-');
    setTimeout(() => {
      process.stdout.write('"whole"}\n');
      process.stderr.write('line\n');
      end();
    }, 100);
  } else {
    process.stderr.write(`fake-hostile: unknown mode ${mode}\n`);
    process.exit(2);
  }
});
