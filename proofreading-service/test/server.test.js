import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { createBackend, extractTitle } from '../src/server.js';
import { signTestToken } from '../src/auth.js';

const secret = 'unit-test-only-secret-over-thirty-two-chars';
// 提交只需正文；标题/日期由服务端自动生成。
const submission = { content: '第一段天气晴好。\n第二段。' };
// 直接写库（重启测试）只需标题与正文。
const manuscript = { title: '测试稿件', content: submission.content };
async function setup(runner = { ready: true, run: async (_, stage) => { stage('扫描完成'); return { issues: [], unverified: [], verified: [] }; } }) {
  const store = openStore(':memory:');
  const backend = createBackend({ store, runner, signingSecret: secret });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.server.address().port}/api/proofreading`;
  const request = (path, user = 1, options = {}) => fetch(base + path, { ...options, headers: { authorization: `Bearer ${signTestToken(user, secret)}`, ...options.headers } });
  const submit = (user = 1, key = randomUUID(), data = submission) => request('/tasks', user, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': key }, body: JSON.stringify(data) });
  return { store, backend, request, submit, async close() { await new Promise(resolve => backend.server.close(resolve)); store.close(); } };
}
async function waitFor(request, id, state) {
  for (let n = 0; n < 40; n++) {
    const result = await (await request(`/tasks/${id}`)).json();
    if (result.status === state) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('task did not reach state ' + state);
}

test('JWT verification rejects absent, expired and modified tokens', async () => {
  const app = await setup();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.backend.server.address().port}/api/proofreading/tasks`)).status, 401);
    assert.equal((await app.request('/tasks', 1, { headers: { authorization: `Bearer ${signTestToken(1, secret, Date.now() - 120000)}` } })).status, 401);
    assert.equal((await app.request('/tasks', 1, { headers: { authorization: `Bearer ${signTestToken(2, secret)}tampered` } })).status, 401);
  } finally { await app.close(); }
});

test('submission derives title server-side; result comes only from runner', async () => {
  const app = await setup();
  try {
    const key = randomUUID();
    const submitted = await app.submit(1, key);
    assert.equal(submitted.status, 202);
    const { id } = await submitted.json();
    assert.equal((await app.submit(1, key)).status, 202);
    assert.equal((await (await app.submit(1, key)).json()).id, id);
    assert.equal((await app.submit(1, key, { content: '同键不同正文' })).status, 409); // 同键不同正文仍拒绝
    assert.equal((await app.request(`/tasks/${id}`, 2)).status, 404);
    assert.deepEqual((await (await app.request('/tasks', 2)).json()).items, []);
    const done = await waitFor((path) => app.request(path), id, 'completed');
    assert.equal(done.content, submission.content);
    assert.equal(done.issues.length, 0);
    assert.equal(done.stages[0].name, '扫描完成');
    // 标题由服务端生成：首行以句号结尾非标题形态，取前缀作临时标题；不再返回日期字段。
    assert.equal(done.title, '第一段天气晴好。');
    assert.equal(done.draft_date, undefined);
    assert.equal(done.publication_date, undefined);
  } finally { await app.close(); }
});

test('extractTitle picks the first line when heading-like, falls back to a prefix', () => {
  assert.equal(extractTitle('# 台风红色预警\n正文'), '台风红色预警');
  assert.equal(extractTitle('北方迎大范围降温\n本报讯'), '北方迎大范围降温');
  assert.equal(extractTitle('今天上午，记者从中央气象台获悉，未来三天我国北方地区将出现大范围降温天气过程。\n第二段。'), '今天上午，记者从中央气象台获悉，未来三天…');
  assert.equal(extractTitle('单独一段短文本'), '单独一段短文本');
  assert.equal(extractTitle(''), '');
});

test('runner-refined title replaces the extracted one on completion', async () => {
  const app = await setup({ ready: true, run: async () => ({ issues: [], unverified: [], verified: [], title: '模型提炼的标题' }) });
  try {
    const { id } = await (await app.submit()).json();
    const done = await waitFor((path) => app.request(path), id, 'completed');
    assert.equal(done.title, '模型提炼的标题');
  } finally { await app.close(); }
});

test('incomplete verification stays partial; invalid highlights and runner failures cannot become 无意见', async () => {
  const app = await setup({ ready: true, run: async () => ({ issues: [], unverified: ['正式文件名称未核实'], verified: [],
    sources: [{ title: '官方检索结果', url: 'https://www.cma.gov.cn/1', snippet: '只有背景信息，没有名称' }] }) });
  try {
    const { id } = await (await app.submit()).json();
    const result = await waitFor(path => app.request(path), id, 'partial');
    assert.match(result.note, /未完成/);
    assert.deepEqual(result.unverified, ['正式文件名称未核实']);
    assert.equal(result.verified.length, 0);
    assert.equal(result.sources.length, 1);
    assert.match(result.note, /搜索线索不等于已核实/);
  } finally { await app.close(); }
  const invalid = await setup({ ready: true, run: async () => ({ issues: [{ quote: '捏造引文', category: 'grammar', reason: '错', suggestion: '改', anchor: { paragraph_id: 'p0', start: 0, end: 4 } }], unverified: [], verified: [] }) });
  try {
    const { id } = await (await invalid.submit()).json();
    assert.equal((await waitFor(path => invalid.request(path), id, 'failed')).issues.length, 0);
  } finally { await invalid.close(); }
});

test('an unlocatable model suggestion stays pending while valid issues remain available', async () => {
  const app = await setup({ ready: true, run: async () => ({ issues: [{ quote: '第一段', category: 'grammar', reason: '有效意见', suggestion: '核对', anchor: { paragraph_id: 'p0', start: 0, end: 3 } }],
    unverified: ['第1遍：“重复片段”无法在原文中唯一定位，已从确定意见中排除，请人工复核。'], verified: [] }) });
  try {
    const { id } = await (await app.submit()).json();
    const result = await waitFor(path => app.request(path), id, 'partial');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].quote, '第一段');
    assert.equal(result.unverified.length, 1);
    assert.match(result.note, /人工复核/);
  } finally { await app.close(); }
});

test('availability identifies offline-partial mode without starting a model task', async () => {
  const app = await setup({ ready: true, offlinePartial: true, run: async () => { throw new Error('must not run'); } });
  try {
    assert.deepEqual(await (await app.request('/availability')).json(), { ready: true, execution: 'legacy', mode: 'offline-partial-test' });
  } finally { await app.close(); }
  const online = await setup({ ready: true, offlinePartial: true, online: true, run: async () => { throw new Error('must not run'); } });
  try {
    assert.deepEqual(await (await online.request('/availability')).json(), { ready: true, execution: 'legacy', mode: 'online-test' });
  } finally { await online.close(); }
  const native = await setup({ ready: true, offlinePartial: true, online: true, execution: 'pi-skill-v1', run: async () => { throw new Error('must not run'); } });
  try {
    assert.deepEqual(await (await native.request('/availability')).json(), { ready: true, execution: 'pi-skill-v1', mode: 'online-test' });
  } finally { await native.close(); }
});

test('native pi-final-text-v1 answers are stored verbatim; incomplete stays partial; failures fail; usage kept', async () => {
  const finalText = '【文法】第2段：截止今天 -> 改为：截至今天\n（依据：典型错误案例）\n';
  const runLog = [];
  const app = await setup({
    ready: true, offlinePartial: true, online: true, execution: 'pi-skill-v1',
    run: async (task) => {
      runLog.push(task.id);
      if (runLog.length === 1) return { format: 'pi-final-text-v1', text: finalText, incomplete: false, usage: { calls: 7, totalTokens: 40700, estimatedUsd: 0.06, available: true } };
      if (runLog.length === 2) return { format: 'pi-final-text-v1', text: '未全部完成的回答', incomplete: true, usage: { calls: 3, totalTokens: 100, estimatedUsd: 0, available: false } };
      throw new Error('model_output_truncated');
    },
  });
  try {
    const first = await (await app.submit()).json();
    const done = await waitFor(path => app.request(path), first.id, 'completed');
    assert.equal(done.result_format, 'pi-final-text-v1');
    assert.equal(done.result_text, finalText); // 逐字保存，含换行
    assert.ok(Number.isFinite(Date.parse(done.created_at)));
    assert.ok(Date.parse(done.updated_at) >= Date.parse(done.created_at)); // 前端据此显示已持续/用时
    assert.deepEqual(done.usage, { calls: 7, totalTokens: 40700, estimatedUsd: 0.06, available: true });
    assert.deepEqual(done.issues, []); // 新执行器不生成结构化列表
    assert.equal((await app.request(`/tasks/${first.id}`, 2)).status, 404); // 跨用户仍隔离

    const second = await (await app.submit()).json();
    const partial = await waitFor(path => app.request(path), second.id, 'partial');
    assert.equal(partial.result_text, '未全部完成的回答');
    assert.match(partial.note, /未全部完成/);
    assert.equal(partial.usage.available, false); // 估算缺失不丢回答

    const third = await (await app.submit()).json();
    assert.equal((await waitFor(path => app.request(path), third.id, 'failed')).result_text, '');
  } finally { await app.close(); }
});

test('verified items with https evidence round-trip; completed when nothing remains unverified', async () => {
  const app = await setup({ ready: true, run: async (_, stage) => {
    stage('联网核查');
    return { issues: [], unverified: [], verified: [
      { text: '《气象发展规划》发布年份', note: '官网确认', evidence: [{ title: '官方文件', url: 'https://www.cma.gov.cn/x', excerpt: '2026年印发' }, { title: '非 https 被丢弃', url: 'http://insecure.example/y' }] },
    ], sources: [{ title: '官方线索', url: 'https://www.cma.gov.cn/x', snippet: '网页摘要' },
      { title: '不安全线索', url: 'http://example.com', snippet: '不应展示' }] }; 
  } });
  try {
    const { id } = await (await app.submit()).json();
    const done = await waitFor(path => app.request(path), id, 'completed');
    assert.equal(done.verified.length, 1);
    assert.equal(done.verified[0].text, '《气象发展规划》发布年份');
    assert.equal(done.verified[0].evidence.length, 1);
    assert.equal(done.verified[0].evidence[0].url, 'https://www.cma.gov.cn/x');
    assert.equal(done.verified[0].evidence[0].excerpt, '2026年印发');
    assert.deepEqual(done.sources, [{ title: '官方线索', url: 'https://www.cma.gov.cn/x', snippet: '网页摘要' }]);
    assert.equal((await app.request(`/tasks/${id}`, 2)).status, 404);
  } finally { await app.close(); }
});

test('verified results without literal official evidence cannot become completed', async () => {
  const app = await setup({ ready: true, run: async () => ({ issues: [], unverified: [], verified: [
    { text: '名称', evidence: [{ title: '伪证据', url: 'http://example.com' }] },
  ] }) });
  try {
    const { id } = await (await app.submit()).json();
    assert.equal((await waitFor(path => app.request(path), id, 'failed')).verified.length, 0);
  } finally { await app.close(); }
});

test('the backend waits for the runner instead of imposing an overall deadline', async () => {
  let release;
  const app = await setup({ ready: true, run: () => new Promise(resolve => { release = resolve; }) });
  try {
    const { id } = await (await app.submit()).json();
    await waitFor(path => app.request(path), id, 'running');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await (await app.request(`/tasks/${id}`)).json()).status, 'running');
    release({ issues: [], unverified: [], verified: [] });
    await waitFor(path => app.request(path), id, 'completed');
  } finally { await app.close(); }
});

test('unconfigured runner refuses submissions; browser test accepts repeated submissions and drafts beyond 4000 characters', async () => {
  const unavailable = await setup({ ready: false });
  try {
    assert.equal((await unavailable.request('/availability')).status, 503);
    assert.equal((await unavailable.submit()).status, 503);
  } finally { await unavailable.close(); }
  const app = await setup();
  try {
    assert.equal((await app.submit(1, randomUUID(), { ...submission, content: '' })).status, 400);
    const longDraft = '稿'.repeat(50_001);
    const first = await app.submit(1, randomUUID(), { content: longDraft });
    assert.equal(first.status, 202);
    const id = (await first.json()).id;
    assert.equal((await waitFor(path => app.request(path), id, 'completed')).content.length, longDraft.length);
    assert.equal((await app.submit()).status, 202);
    assert.equal((await app.submit()).status, 202);
    assert.equal((await app.submit(2)).status, 202);
    assert.equal((await app.submit(1, randomUUID(), { content: '稿'.repeat(210_000) })).status, 413); // 传输保护上限，非业务字符数限制
  } finally { await app.close(); }
});

test('history retention keeps only the newest five tasks per user, never touching active tasks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmnrag-test-'));
  const filename = join(directory, 'test.sqlite');
  try {
    const store = openStore(filename);
    const ids = [];
    for (let n = 0; n < 7; n++) {
      const created = store.create(1, `key-${n}`, { title: `稿${n}`, content: `第${n}篇正文` }, 'rule-hash', 'test/model');
      ids.push(created.id);
      store.update(created.id, { status: 'completed' }); // 排队中的新任务受保护；只有已结束的才会被裁剪
    }
    assert.equal(store.list(1).length, 5); // 提交即裁剪：最早的 2 篇已从早到晚删除
    assert.equal(store.detail(ids[0], 1), undefined);
    assert.equal(store.detail(ids[1], 1), undefined);
    assert.ok(store.detail(ids[6], 1));
    store.create(2, 'other', { title: '他人稿件', content: '他人正文' }, 'rule-hash', 'test/model');
    assert.equal(store.list(2).length, 1); // 保留策略按用户隔离，互不删除
    const duplicate = store.create(1, 'key-6', { title: '稿6', content: '第6篇正文' }, 'rule-hash', 'test/model');
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.pruned, undefined); // 幂等重提交不再触发删除
    assert.equal(store.list(1).length, 5);
    store.update(ids[5], { status: 'running' });
    for (let n = 8; n <= 12; n++) store.create(1, `key-${n}`, { title: `稿${n}`, content: `第${n}篇正文` }, 'rule-hash', 'test/model');
    assert.ok(store.detail(ids[5], 1)); // 排队/运行中的任务永不删除
    assert.equal(store.detail(ids[6], 1), undefined);
    assert.equal(store.list(1).length, 6); // 新 5 篇 + 受保护的活动任务
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart marks interrupted running attempt failed without destroying draft or history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmnrag-test-'));
  const filename = join(directory, 'test.sqlite');
  try {
    const first = openStore(filename);
    const { id } = first.create(1, randomUUID(), manuscript, 'rule-hash', 'test/model');
    first.update(id, { status: 'running' });
    first.close();
    const second = openStore(filename);
    assert.equal(second.detail(id, 1).status, 'failed');
    assert.equal(second.detail(id, 1).content, manuscript.content);
    assert.equal(second.detail(id, 1).rule_version, 'rule-hash');
    second.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

