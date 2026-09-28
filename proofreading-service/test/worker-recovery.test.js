import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerRecovery } from '../src/worker-recovery.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await pause(5); }
  assert.fail('recovery did not reach expected state');
}

test('repeated worker exits recover with capped backoff, leaving backend and tasks untouched', async () => {
  const events = [];
  let stopped = false, restarts = 0;
  const policy = createWorkerRecovery({ logger: { log(event, fields) { events.push({ event, ...fields }); } },
    stop() { stopped = true; }, restart: async () => { restarts++; }, delayMs: 1, maxDelayMs: 4 });
  try {
    policy.markReady();
    for (let n = 1; n <= 4; n++) {
      policy.unexpectedExit('worker', 'child_exit');
      policy.unexpectedExit('worker', 'child_error'); // Duplicate notification must not launch two processes.
      await until(() => events.filter(e => e.event === 'worker_recovered').length === n);
    }
    assert.equal(restarts, 4);
    assert.equal(stopped, false);
    assert.deepEqual(events.filter(e => e.event === 'worker_restart_scheduled').map(e => e.delay_ms), [1, 2, 4, 4]);
    policy.unexpectedExit('backend', 'child_exit');
    assert.equal(stopped, true);
  } finally { policy.close(); }
});

test('a planned stop cancels pending recovery and ignores later exit notifications', async () => {
  let restarts = 0;
  const policy = createWorkerRecovery({ stop() { assert.fail('already closed'); }, restart: () => { restarts++; }, delayMs: 30 });
  policy.markReady(); policy.unexpectedExit('worker', 'child_exit'); policy.close();
  policy.unexpectedExit('worker', 'child_exit'); policy.unexpectedExit('backend', 'child_exit');
  await pause(50);
  assert.equal(restarts, 0);
});

test('failed starts retry without overlapping launches or logging secrets', async () => {
  const events = [];
  let restarts = 0;
  const policy = createWorkerRecovery({ logger: { log(event, fields) { events.push({ event, ...fields }); } },
    stop() { assert.fail('backend must survive'); }, restart: async () => {
      restarts++;
      if (restarts <= 2) throw new Error('sk-localmustnotbelogged');
    }, delayMs: 1, maxDelayMs: 4 });
  try {
    policy.markReady(); policy.unexpectedExit('worker', 'child_exit');
    await until(() => events.some(e => e.event === 'worker_recovered'));
    assert.equal(restarts, 3);
    assert.equal(events.filter(e => e.event === 'worker_restart_failed').length, 2);
    assert.doesNotMatch(JSON.stringify(events), /sk-localmustnotbelogged/);
  } finally { policy.close(); }
});

test('exit during readiness recovery is not lost, and closing an in-flight restart prevents retries', async () => {
  let resolveStart, count = 0;
  const policy = createWorkerRecovery({ stop() { assert.fail('backend must survive'); }, delayMs: 1,
    restart: () => { count++; return new Promise(resolve => { resolveStart = resolve; }); } });
  try {
    policy.markReady(); policy.unexpectedExit('worker', 'child_exit');
    await until(() => count === 1);
    policy.unexpectedExit('worker', 'child_exit');
    resolveStart();
    await until(() => count === 2);
    policy.close(); resolveStart();
    await pause(20);
    assert.equal(count, 2);
  } finally { policy.close(); resolveStart?.(); }
});

test('a stable interval resets recovery backoff', async () => {
  const events = [];
  const policy = createWorkerRecovery({ logger: { log(event, fields) { events.push({ event, ...fields }); } },
    stop() {}, restart: async () => {}, delayMs: 1, stableMs: 10 });
  try {
    policy.markReady(); policy.unexpectedExit('worker', 'child_exit');
    await until(() => events.some(e => e.event === 'worker_recovered'));
    await pause(15);
    policy.unexpectedExit('worker', 'child_exit');
    assert.deepEqual(events.filter(e => e.event === 'worker_restart_scheduled').map(e => e.attempt), [1, 1]);
  } finally { policy.close(); }
});
