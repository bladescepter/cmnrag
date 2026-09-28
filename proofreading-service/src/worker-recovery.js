// Recover only the local webpage process. Never restart the backend or replay model tasks.
export function createWorkerRecovery({ logger, stop, restart, delayMs = 1000, maxDelayMs = 30_000, stableMs = 60_000 }) {
  let ready = false;
  let closed = false;
  let attempts = 0;
  let recoveredAt = 0;
  let timer = null;
  let restarting = false;
  let exitedDuringRestart = false;
  function schedule() {
    if (closed || timer || restarting) return;
    if (recoveredAt && Date.now() - recoveredAt >= stableMs) attempts = 0;
    recoveredAt = 0;
    const delay = Math.min(maxDelayMs, delayMs * 2 ** Math.min(attempts, 16));
    attempts++;
    logger?.log('worker_restart_scheduled', { attempt: attempts, delay_ms: delay });
    timer = setTimeout(async () => {
      timer = null;
      if (closed) return;
      restarting = true;
      exitedDuringRestart = false;
      let failed = false;
      try {
        await restart(attempts);
        if (exitedDuringRestart) throw new Error('worker_exited_during_restart');
        if (!closed) {
          recoveredAt = Date.now();
          logger?.log('worker_recovered', { attempt: attempts });
        }
      } catch {
        failed = true;
        if (!closed) logger?.log('worker_restart_failed', { attempt: attempts });
      } finally {
        restarting = false;
        if (failed && !closed) schedule();
      }
    }, delay);
  }
  return {
    markReady() { ready = true; },
    unexpectedExit(service, reason) {
      if (closed) return;
      if (service !== 'worker' || !ready) { stop(reason); return; }
      if (restarting) { exitedDuringRestart = true; return; }
      schedule();
    },
    close() { closed = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
