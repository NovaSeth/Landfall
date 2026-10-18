#!/usr/bin/env node
// Fake provider CLI for the external-run tests, declared as a generic adapter:
//   node fake-provider.mjs <mode> {out} {sandbox} {cwd}
// It reads the prompt from stdin (saved as <out>.prompt), records what it was given in <out>.args (one JSON line:
// sandbox, cwd, its pid, the lease env) and then, by mode:
//   ok        three output lines, the review JSON written to <out>, exit 0
//   fail      one line, an error line on stderr, exit 3
//   slow      a line every 200 ms until it is ended (SIGTERM ends it)
//   gate      waits for the file <out>.go (polled every 50 ms, at most 60 s), then as ok
//   stubborn  ignores SIGTERM, starts a grandchild in its process group that ignores SIGTERM too (pids in <out>.pids),
//             and prints a line every 200 ms: only SIGKILL of the group ends them
// Every wait sleeps (timers); nothing here spins the CPU.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const [mode, out, sandbox, cwd] = process.argv.slice(2);
const say = (line) => process.stdout.write(`${line}\n`);
const review = { verdict: 'approved', reviewer: { kind: 'external', id: 'fake' }, findings: [] };
const finish = (lines) => {
  for (const l of lines) say(l);
  writeFileSync(out, JSON.stringify(review));
  setTimeout(() => process.exit(0), 50);
};

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  writeFileSync(`${out}.prompt`, Buffer.concat(chunks));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /_(?:SLOT|PORT_BASE|PORT_MAX|DB_NAME)$/.test(k)));
  writeFileSync(`${out}.args`, `${JSON.stringify({ mode, sandbox, cwd, pid: process.pid, env })}\n`);
  say(`fake provider ${mode}: sandbox ${sandbox}`);
  if (mode === 'ok') {
    setTimeout(() => finish(['reading the brief', 'checking the diff', 'done: approved']), 300);
  } else if (mode === 'fail') {
    process.stderr.write('boom: the fake provider failed\n');
    setTimeout(() => process.exit(3), 50);
  } else if (mode === 'slow') {
    let n = 0;
    setInterval(() => say(`tick ${++n}`), 200);
  } else if (mode === 'gate') {
    say('waiting for the gate');
    const until = Date.now() + 60000;
    const poll = setInterval(() => {
      if (existsSync(`${out}.go`)) { clearInterval(poll); finish(['gate open', 'done: approved']); } else if (Date.now() > until) process.exit(4);
    }, 50);
  } else if (mode === 'stubborn') {
    process.on('SIGTERM', () => say('ignoring SIGTERM'));
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
    writeFileSync(`${out}.pids`, `${process.pid} ${child.pid}\n`);
    let n = 0;
    setInterval(() => say(`stubborn ${++n}`), 200);
  } else {
    process.stderr.write(`fake provider: unknown mode ${mode}\n`);
    process.exit(2);
  }
});
