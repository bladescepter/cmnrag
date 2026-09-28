import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticsLogger } from '../src/diagnostics.js';
import { observeChild } from '../src/child-observer.js';

function child() {
  const process = new EventEmitter();
  process.pid = 12345;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  return process;
}

test('unexpected exit records only process metadata and requests stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmnrag-supervisor-'));
  try {
    const file = join(dir, 'supervisor.jsonl');
    const logger = createDiagnosticsLogger(file);
    let reason;
    const process = child();
    observeChild(process, 'worker', logger, { isStopping: () => false, stop: value => { reason = value; } });
    process.stderr.end('稿件和密钥 sk-localmustnotbelogged');
    process.stdout.end('未刊稿正文');
    process.emit('exit', 1, null);
    assert.equal(reason, 'child_exit');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.deepEqual({ event: lines[0].event, service: lines[0].service, pid: lines[0].pid, code: lines[0].code, signal: lines[0].signal, expected: lines[0].expected },
      { event: 'child_exit', service: 'worker', pid: 12345, code: 1, signal: null, expected: false });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /稿件|密钥|未刊稿|sk-localmustnotbelogged/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Wrangler stderr is classified without recording error text, model output or credentials', () => {
  const events = [];
  const process = child();
  observeChild(process, 'worker', { log: (event, fields) => events.push({ event, ...fields }) },
    { isStopping: () => false, stop() {} });
  process.stderr.write('FATAL ERROR: heap out of memory; key sk-localmustnotbelogged\n');
  process.stderr.write('FATAL ERROR: heap out of memory; 未刊稿正文\n');
  process.emit('exit', 1, null);
  assert.ok(events.some(e => e.event === 'child_stderr_hint' && e.hint === 'heap_oom'));
  assert.equal(events.filter(e => e.hint === 'heap_oom').length, 1);
  assert.doesNotMatch(JSON.stringify(events), /sk-localmustnotbelogged|未刊稿正文/);
});

test('planned stop, migration completion and spawn errors do not leak error messages', () => {
  const events = [];
  const logger = { log: (event, fields) => events.push({ event, ...fields }) };
  let stops = 0;
  const planned = child();
  observeChild(planned, 'backend', logger, { isStopping: () => true, stop: () => { stops++; } });
  planned.emit('exit', null, 'SIGTERM');
  const migration = child();
  observeChild(migration, 'migration', logger, { isStopping: () => false, stop: () => { stops++; } });
  migration.emit('exit', 0, null);
  assert.equal(stops, 0);
  assert.equal(events[0].expected, true);
  assert.equal(events[0].signal, 'SIGTERM');
  assert.equal(events[1].expected, false);
  const broken = child();
  observeChild(broken, 'worker', logger, { isStopping: () => false, stop: () => { stops++; } });
  broken.emit('error', Object.assign(new Error('sk-localmustnotbelogged'), { code: 'ENOENT' }));
  assert.equal(stops, 1);
  assert.deepEqual(events.at(-1), { event: 'child_error', service: 'worker', pid: 12345, code: 'ENOENT' });
});
