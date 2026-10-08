import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';

const manuscript = { title: '标题', content: '原稿' };
test('execution timestamps exclude the queue and remain stable through progress and later updates', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const store = openStore(':memory:');
  try {
    const { id } = store.create(1, randomUUID(), manuscript);
    const queued = store.detail(id, 1);
    assert.equal(queued.started_at, null);
    assert.equal(queued.finished_at, null);
    t.mock.timers.tick(600_000);
    store.update(id, { status: 'running' });
    const running = store.detail(id, 1);
    assert.equal(Date.parse(running.started_at) - Date.parse(queued.created_at), 600_000);
    t.mock.timers.tick(30_000);
    store.update(id, { stages: [{ name: '读取原稿', status: 'done' }] });
    store.update(id, { status: 'running' });
    assert.equal(store.detail(id, 1).started_at, running.started_at);
    assert.equal(store.detail(id, 1).finished_at, null);
    t.mock.timers.tick(60_000);
    store.update(id, { status: 'completed', result_text: '无意见' });
    const completed = store.detail(id, 1);
    assert.equal(Date.parse(completed.finished_at) - Date.parse(completed.started_at), 90_000);
    t.mock.timers.tick(600_000);
    store.update(id, { title: '后来更新标题', status: 'completed' });
    const later = store.detail(id, 1);
    assert.equal(later.started_at, completed.started_at);
    assert.equal(later.finished_at, completed.finished_at);
    assert.notEqual(later.updated_at, completed.updated_at);
    assert.equal(later.content, manuscript.content);
  } finally { store.close(); }
});

test('partial, failed and cancelled tasks record their finish; failure before execution has no start', () => {
  const store = openStore(':memory:');
  try {
    for (const status of ['partial', 'failed', 'cancelled']) {
      const { id } = store.create(1, randomUUID(), manuscript);
      store.update(id, { status: 'running' });
      store.update(id, { status });
      const detail = store.detail(id, 1);
      assert.ok(Number.isFinite(Date.parse(detail.started_at)));
      assert.ok(Date.parse(detail.finished_at) >= Date.parse(detail.started_at));
    }
    const { id } = store.create(1, randomUUID(), manuscript);
    store.update(id, { status: 'failed' });
    assert.equal(store.detail(id, 1).started_at, null);
    assert.ok(Number.isFinite(Date.parse(store.detail(id, 1).finished_at)));
  } finally { store.close(); }
});

test('timestamps survive reopening; migration preserves legacy results without inventing a start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofreading-timing-'));
  const filename = join(dir, 'tasks.sqlite');
  let store = openStore(filename);
  try {
    const { id } = store.create(1, randomUUID(), manuscript);
    store.update(id, { status: 'running' });
    store.update(id, { status: 'completed', result_text: '原始结果' });
    const completed = store.detail(id, 1);
    store.close();
    store = openStore(filename);
    assert.deepEqual(store.detail(id, 1), completed);
    // 在独立测试库模拟升级前的 schema；不接触业务数据。
    store.db.exec('ALTER TABLE tasks DROP COLUMN started_at; ALTER TABLE tasks DROP COLUMN finished_at;');
    store.close();
    store = openStore(filename);
    const migrated = store.detail(id, 1);
    assert.equal(migrated.started_at, null);
    assert.equal(migrated.finished_at, null);
    assert.equal(migrated.result_text, completed.result_text);
    assert.equal(migrated.content, completed.content);
    assert.equal(migrated.created_at, completed.created_at);
    assert.equal(migrated.updated_at, completed.updated_at);
    const next = store.create(1, randomUUID(), manuscript);
    store.update(next.id, { status: 'running' });
    const started = store.detail(next.id, 1).started_at;
    store.close();
    store = openStore(filename);
    const interrupted = store.detail(next.id, 1);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.started_at, started);
    assert.ok(Date.parse(interrupted.finished_at) >= Date.parse(started));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
