import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticsLogger, redactDiagnostic } from '../src/diagnostics.js';
import { openStore } from '../src/store.js';
import { createBackend } from '../src/server.js';

test('redactDiagnostic removes key-shaped substrings, truncates and passes safe values', () => {
  assert.equal(redactDiagnostic('key sk-abcdefghijklmnop123456 done'), 'key sk-*** done');
  assert.equal(redactDiagnostic('tp-abcdef1234567890 rejected'), '*** rejected');
  assert.equal(redactDiagnostic('Bearer abcdefghijklmnop'), 'Bearer ***');
  assert.equal(redactDiagnostic('x'.repeat(400)).length, 300);
  assert.equal(redactDiagnostic(42), 42);
  assert.equal(redactDiagnostic(true), true);
  assert.equal(redactDiagnostic(undefined), 'undefined');
});

test('logger writes JSONL events, redacts fields, rotates once, tolerates null path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmnrag-diag-'));
  try {
    const file = join(dir, 'diagnostics.jsonl');
    const logger = createDiagnosticsLogger(file, { maxBytes: 280 });
    assert.ok(logger);
    logger.log('run_start', { task: randomUUID(), chars: 10, secret: 'sk-abcdefgh12345678' });
    logger.log('prompt_returned', { pass: 1, ms: 5, stop_reason: 'stop' });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, 'run_start');
    assert.equal(lines[0].chars, 10);
    assert.equal(lines[0].secret, 'sk-***');
    assert.ok(!Number.isNaN(Date.parse(lines[1].t)));
    logger.log('pass_done', { pass: 2, ms: 7 }); // 超过 maxBytes，触发单次轮转
    assert.ok(existsSync(`${file}.1`));
    assert.ok(statSync(file).size <= 160);
    logger.log('', {}); // 空 event 无操作
    logger.log('ok', { t: '不能覆盖', event: '不能覆盖' });
    const last = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(last.event, 'ok'); // 内置字段不可被覆盖
    assert.equal(createDiagnosticsLogger(''), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backend drain logs queue_pick, stage_done and task_failed with error code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmnrag-diag-'));
  const store = openStore(join(dir, 'tasks.sqlite'));
  try {
    const file = join(dir, 'diagnostics.jsonl');
    const logger = createDiagnosticsLogger(file);
    const runner = { ready: true, offlinePartial: true, ruleVersion: 'r', model: 'm', maxDraftChars: 4000,
      run: async (task, onStage) => { onStage('阶段一'); throw new Error('model_timeout'); } };
    const backend = createBackend({ store, runner, signingSecret: 'unit-test-only-secret-over-thirty-two-chars', logger });
    store.create(1, randomUUID(), { title: 't', draft_date: '2026-09-24', publication_date: '2026-09-25', content: 'x' }, 'r', 'm');
    await backend.drain();
    assert.equal(store.list(1)[0].status, 'failed');
    const events = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).map(l => l.event);
    assert.ok(events.includes('queue_pick'));
    assert.ok(events.includes('stage_done'));
    const failed = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(l => l.event === 'task_failed');
    assert.equal(failed.error, 'model_timeout');
    assert.match(failed.task, /^[0-9a-f-]{36}$/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backend without logger behaves exactly as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmnrag-diag-'));
  const store = openStore(join(dir, 'tasks.sqlite'));
  try {
    const runner = { ready: true, run: async () => ({ issues: [], unverified: ['x'], verified: [] }) };
    const backend = createBackend({ store, runner, signingSecret: 'unit-test-only-secret-over-thirty-two-chars' });
    store.create(1, randomUUID(), { title: 't', draft_date: '2026-09-24', publication_date: '2026-09-25', content: 'x' }, '', '');
    await backend.drain();
    assert.equal(store.list(1)[0].status, 'partial');
    assert.equal(existsSync(join(dir, 'diagnostics.jsonl')), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
