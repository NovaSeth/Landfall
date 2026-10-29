// Supervised run (spec §7.8a): a long run under a lease has a hard wall-time limit and a no-output limit, each with
// its own outcome. The child must lead its own process group (spawned detached). On a limit, and after the leader
// exits, the group is ended (findings r1 2): SIGTERM to the group, up to graceMs for it to go, then SIGKILL to the
// group while kill(-pgid, 0) still succeeds. The leader exiting never cancels the SIGKILL, and supervise returns only
// after the group is gone or got SIGKILL, so the caller releases the lease after its processes.
// The group id stays reserved while any member lives, so a successful kill(-pgid, 0) names this run's group.
// supervise(child, { timeoutMs, idleMs, graceMs, pollMs, out, err, signal }) → Promise<{ ended: 'exit' | 'timeout' |
// 'idle' | 'aborted', status, signal, error }>; error is the code of a child that could not start (such as ENOENT), else
// null. An abort of `signal` (an AbortSignal) ends the group like a limit.
// While the leader runs, every refreshMs (5 s) supervise calls refresh (T-MG-88; default: the lease refresh of a child
// recorded by attachChild, which writes only when its group gained members), so a group whose leader dies with the
// supervisor is still reaped through a member identity. A refresh that throws is skipped: the run goes on.
import { forgetAttached, refreshAttached } from './leases.mjs';

export const REFRESH_MS = 5000;

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function signalGroup(pgid, sig) {
  try { process.kill(-pgid, sig); } catch { /* the group is gone */ }
}

// SIGTERM, up to graceMs, then SIGKILL while a member is left; resolves when the group is gone or got SIGKILL.
function endGroup(pgid, graceMs, pollMs) {
  return new Promise((done) => {
    if (!Number.isInteger(pgid) || !groupAlive(pgid)) { done(); return; }
    signalGroup(pgid, 'SIGTERM');
    const until = Date.now() + graceMs;
    const check = () => {
      if (!groupAlive(pgid)) { done(); return; }
      if (Date.now() >= until) { signalGroup(pgid, 'SIGKILL'); done(); return; }
      setTimeout(check, pollMs);
    };
    setTimeout(check, pollMs);
  });
}

export function supervise(child, { timeoutMs, idleMs, graceMs = 2000, pollMs = 50, refreshMs = REFRESH_MS, refresh = () => refreshAttached(child.pid), out = () => {}, err = () => {}, signal } = {}) {
  return new Promise((resolve) => {
    let ended = 'exit';
    let exit = null;
    let ending = null;
    let finishing = false;
    let idle;
    const end = () => (ending ??= endGroup(child.pid, graceMs, pollMs));
    const stop = (why) => {
      if (exit || ended !== 'exit') return;
      ended = why;
      clearInterval(members);
      clearTimeout(hard);
      clearTimeout(idle);
      end();
    };
    const hard = setTimeout(() => stop('timeout'), timeoutMs);
    const members = setInterval(() => {
      if (exit || ended !== 'exit') return;
      try { refresh(); } catch { /* a failed refresh never stops the run; the next poll retries */ }
    }, refreshMs);
    const arm = () => {
      clearTimeout(idle);
      if (!exit && ended === 'exit') idle = setTimeout(() => stop('idle'), idleMs);
    };
    // After the leader is gone: members it left behind are ended too, then the result.
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearInterval(members);
      clearTimeout(hard);
      clearTimeout(idle);
      await end();
      forgetAttached(child.pid);
      resolve({ ended, status: exit.status ?? null, signal: exit.signal ?? null, error: exit.error ?? null });
    };
    arm();
    signal?.addEventListener('abort', () => stop('aborted'), { once: true });
    child.stdout?.on('data', (d) => { arm(); out(d); });
    child.stderr?.on('data', (d) => { arm(); err(d); });
    child.on('error', (e) => { exit ??= { status: null, signal: null, error: e?.code ?? 'failed' }; finish(); });
    child.on('exit', (status, signal) => {
      exit ??= { status, signal };
      clearInterval(members);
      const later = setTimeout(finish, 300); // output still in the pipes, unless a member left behind keeps them open
      child.once('close', () => { clearTimeout(later); finish(); });
    });
  });
}
