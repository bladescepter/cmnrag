import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('polling is single-flight, resumes after an initial read failure and clears stale connection errors', async () => {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', replaceChildren() {}, append() {} });
    return elements.get(id);
  } };
  const text = readFileSync(new URL('../../cmnrag-website/public/proofreading/workbench.js', import.meta.url), 'utf8');
  const script = text.replace(/^import .*;\n/gm, '').split('$("new-task")')[0];
  let calls = 0, resolveRead;
  let fail = true;
  const context = { document, requestJson: async path => {
    if (path === '/tasks') return { items: [] };
    calls++;
    if (fail) throw new Error('temporary disconnection');
    return new Promise(resolve => { resolveRead = resolve; });
  }, setInterval: fn => { context.polls.push(fn); }, polls: [], rendered: null };
  runInNewContext(script + '\nrenderTask = task => { currentTask = task; rendered = task; }; renderList = () => {}; currentId = "selected-id";', context);
  await runInNewContext('refreshTask(currentId)', context);
  assert.equal(elements.get('page-message').textContent, 'temporary disconnection');
  fail = false;
  // Execute the real page polling condition with currentTask still null after the failed initial GET.
  runInNewContext(text.slice(text.indexOf('setInterval(() =>'), text.indexOf('(async function init()')), context);
  assert.equal(context.polls.length, 2); // Network polling and local-only elapsed timer.
  const [poll, tick] = context.polls;
  tick(); // Without a current task this timer never issues a request.
  poll();
  poll();
  assert.equal(calls, 2); // initial failed read + exactly one pending read
  resolveRead({ id: 'selected-id', status: 'completed', issues: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.rendered.status, 'completed');
  assert.equal(elements.get('page-message').textContent, '');
  context.createdAt = new Date(Date.now() - 90_000).toISOString();
  runInNewContext('currentTask = { status: "running", created_at: createdAt };', context);
  document.getElementById('task-elapsed').hidden = false;
  tick();
  assert.match(elements.get('task-elapsed').textContent, /^已持续 1 分/);
  assert.equal(calls, 2); // Local elapsed timer never makes network requests.
  runInNewContext('currentTask = { status: "completed" };', context);
  tick();
  poll();
  assert.equal(calls, 2); // A completed task does not keep polling.
});
