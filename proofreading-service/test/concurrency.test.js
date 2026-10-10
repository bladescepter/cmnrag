import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../src/store.js';
import { createBackend, MAX_CONCURRENT_TASKS } from '../src/server.js';
import { signTestToken } from '../src/auth.js';

const secret = 'concurrency-test-secret-over-thirty-two-characters';
const result = { issues: [], unverified: [], verified: [] };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
  const store = openStore(':memory:');
  const controls = new Map();
  const owners = new Map();
  const running = new Set();
  const started = [];
  let peak = 0;
  const runner = { ready: true, run(task, onStage) {
    const user = owners.get(task.id);
    assert.ok(![...running].some(id => owners.get(id) === user));
    running.add(task.id);
    started.push(task.id);
    peak = Math.max(peak, running.size);
    assert.ok(running.size <= MAX_CONCURRENT_TASKS);
    onStage(`通读 ${task.title}`);
    return new Promise((resolve, reject) => controls.set(task.id, { resolve, reject }))
      .finally(() => running.delete(task.id));
  } };
  const backend = createBackend({ store, runner, signingSecret: secret });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const add = (user, title) => {
    const { id } = store.create(user, randomUUID(), { title, content: `${title}\n该用户的原稿。` });
    owners.set(id, user);
    return id;
  };
  const detail = id => store.detail(id, owners.get(id));
  const release = (id, fail = false) => fail ? controls.get(id).reject(new Error('model_call_failed')) : controls.get(id).resolve(result);
  return { store, backend, add, detail, release, started, owners, get peak() { return peak; }, async close() {
    // Stop scheduling before resolving active work, leaving any waiting manuscripts intact.
    backend.stop();
    for (const control of controls.values()) control.resolve(result);
    await backend.drain();
    await new Promise(resolve => backend.server.close(resolve));
    store.close();
  } };
}

test('four global slots, one per user; blocked users are skipped and failures release their slot', async () => {
  const app = await setup();
  try {
    assert.equal(MAX_CONCURRENT_TASKS, 4);
    const one = app.add(1, '用户一首篇');
    const second = app.add(1, '用户一次篇');
    const third = app.add(1, '用户一第三篇');
    const two = app.add(2, '用户二');
    const three = app.add(3, '用户三');
    const four = app.add(4, '用户四');
    const five = app.add(5, '用户五');
    app.backend.kick();
    assert.deepEqual(app.started, [one, two, three, four]);
    assert.equal(app.peak, 4);
    for (const id of [second, third, five]) {
      assert.equal(app.detail(id).status, 'queued');
      assert.equal(app.detail(id).started_at, null);
    }
    // Repeated scheduling attempts must neither duplicate execution nor exceed the limit.
    app.backend.kick(); app.backend.kick();
    assert.equal(app.started.length, 4);
    const url = `http://127.0.0.1:${app.backend.server.address().port}/api/proofreading/tasks/`;
    assert.equal((await fetch(url + one, { headers: { authorization: `Bearer ${signTestToken(2, secret)}` } })).status, 404);
    assert.equal((await fetch(url + two, { headers: { authorization: `Bearer ${signTestToken(1, secret)}` } })).status, 404);

    app.release(two);
    await settle();
    assert.equal(app.detail(two).status, 'completed');
    assert.equal(app.detail(five).status, 'running');
    assert.equal(app.detail(second).status, 'queued');
    app.release(one, true);
    await settle();
    assert.equal(app.detail(one).status, 'failed');
    assert.equal(app.detail(second).status, 'running');
    assert.equal(app.detail(third).status, 'queued');
    app.release(second);
    await settle();
    assert.equal(app.detail(third).status, 'running');
    app.release(third); app.release(three); app.release(four); app.release(five);
    await app.backend.drain();
    assert.equal(app.peak, 4);
    assert.equal(app.started.length, 7);
    assert.equal(new Set(app.started).size, 7);
    for (const id of [second, third, two, three, four, five]) {
      const task = app.detail(id);
      assert.equal(task.status, 'completed');
      assert.ok(task.finished_at);
      assert.deepEqual(task.stages, [{ name: `通读 ${task.title}`, status: 'done' }]);
      assert.equal(task.content, `${task.title}\n该用户的原稿。`);
    }
  } finally { await app.close(); }
});

test('stopping lets active tasks finish without starting queued manuscripts', async () => {
  const app = await setup();
  try {
    const ids = Array.from({ length: 5 }, (_, index) => app.add(index + 1, `稿件${index}`));
    app.backend.kick();
    app.backend.stop();
    ids.slice(0, 4).forEach(id => app.release(id));
    await app.backend.drain();
    assert.equal(app.started.length, 4);
    assert.equal(app.detail(ids[4]).status, 'queued');
    assert.equal(app.detail(ids[4]).started_at, null);
  } finally { await app.close(); }
});
