import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopChild } from '../src/stop-child.js';

test('failed-start cleanup terminates only its own detached child, escalating when necessary', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    const exited = once(child, 'exit');
    await stopChild(child, 20);
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (child.exitCode === null && !child.signalCode) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});
