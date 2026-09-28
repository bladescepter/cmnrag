import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTinyFishClient } from '../src/tinyfish.js';
import { applyVerdicts, collectEvidence, searchPlan } from '../src/verification.js';

function fakeTinyFish({ searchStatus = 200, searchBody = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url });
    if (url.pathname === '/malformed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unexpected: true }));
      return;
    }
    if (url.pathname === '/search') {
      res.writeHead(searchStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(searchBody ?? { results: [
        { url: 'https://www.cma.gov.cn/news/1', title: '官方消息', snippet: ' 发布于 2026 年 ' },
        { url: 'http://insecure.example.com/2', title: '非 https 应被过滤' },
        { url: 'https://www.cma.gov.cn/news/1', title: '重复 URL 应被去重' },
      ] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

test('tinyfish client maps, filters and dedupes search results; requires https', async () => {
  const { server, port, requests } = await fakeTinyFish({});
  try {
    const client = createTinyFishClient({ apiKey: 'k', searchUrl: `http://127.0.0.1:${port}/search` });
    const results = await client.search('测试 查询');
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://www.cma.gov.cn/news/1');
    assert.equal(results[0].snippet, '发布于 2026 年'); // 压缩空白
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url.searchParams.get('query'), '测试 查询');
    assert.equal(requests[0].url.searchParams.get('language'), 'zh');
    assert.equal(requests[0].url.searchParams.get('location'), 'CN');
    assert.equal(client.fetch, undefined);
  } finally { server.close(); }
});

test('tinyfish client propagates http errors and rejects bad shapes; null without key', async () => {
  const { server, port } = await fakeTinyFish({ searchStatus: 401 });
  try {
    const client = createTinyFishClient({ apiKey: 'k', searchUrl: `http://127.0.0.1:${port}/search` });
    await assert.rejects(() => client.search('x'), /tinyfish_http_401/);
    const badShape = createTinyFishClient({ apiKey: 'k', searchUrl: `http://127.0.0.1:${port}/malformed` });
    await assert.rejects(() => badShape.search('x'), /tinyfish_bad_search_shape/);
  } finally { server.close(); }
  assert.equal(createTinyFishClient({ apiKey: '' }), null);
  assert.equal(createTinyFishClient({}), null);
});

test('one batched Search handles all facts, without invoking Fetch', async () => {
  const items = Array.from({ length: 12 }, (_, i) => `事项${i}`);
  items.push('领导人原话“必须核对全文”');
  const queries = searchPlan(['领导人引语 官方全文', '活动主题 政策文件']);
  assert.equal(queries.length, 2);
  assert.deepEqual(searchPlan(['普通语法错']), []);
  assert.deepEqual(searchPlan(undefined), []); // 无待核实事项不联网。
  const fallback = searchPlan(undefined, ['领导人原话是否准确', '机构全称待核实']);
  assert.equal(fallback.length, 2);
  assert.ok(fallback.some(query => query.includes('领导人原话是否准确')));
  assert.ok(fallback.some(query => query.includes('机构全称待核实')));
  assert.equal(searchPlan(['唯一一条'], ['机构全称待核实']).length, 2);
  assert.equal(searchPlan(undefined, ['同一事实']).length, 2);
  let searches = 0;
  let fetches = 0;
  const sources = await collectEvidence({
    async search() { searches++; return [{ url: 'https://www.cma.gov.cn/official', title: '官方发布', snippet: '片段' }]; },
    async fetch() { fetches++; throw new Error('Fetch must never run'); },
  }, queries);
  assert.equal(searches, 2);
  assert.equal(fetches, 0);
  assert.equal(sources[0].snippet, '片段');
  assert.equal((await collectEvidence({ async search() { searches++; return []; } }, [])).length, 0);
  assert.equal(searches, 2); // 没有必要核查时默认不联网
});

test('verified items accept authoritative non-gov HTTPS sources with literal excerpt, without a fact-count cap', () => {
  const items = Array.from({ length: 12 }, (_, i) => `事项${i}`);
  const sources = [{ url: 'https://www.xinhuanet.com/official', title: '权威首发', snippet: '首发原文：发布于二〇二六年', content: '网页内才有' }];
  const verdicts = [
    { item: '事项11', status: 'verified', note: '官方原文确认', evidence: [{ url: sources[0].url, excerpt: '发布于二〇二六年' }] },
    { item: '事项0', status: 'verified', note: '伪造引文', evidence: [{ url: sources[0].url, excerpt: '这里不存在的引文' }] },
    { item: '事项1', status: 'verified', note: '不在本次检索结果中', evidence: [{ url: 'https://not-in-results.example/x', excerpt: '发布于二〇二六年' }] },
    { item: '事项2', status: 'verified', note: '正文不可用', evidence: [{ url: sources[0].url, excerpt: '网页内才有' }] },
    { item: '事项3', status: 'verified', note: '不安全链接', evidence: [{ url: 'http://example.com/x', excerpt: '发布于二〇二六年' }] },
  ];
  const { verified, remaining } = applyVerdicts(items, verdicts, sources);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].text, '事项11');
  assert.equal(verified[0].evidence[0].excerpt, '发布于二〇二六年');
  assert.equal(verified[0].evidence[0].url, 'https://www.xinhuanet.com/official');
  assert.equal(remaining.length, 11);
});
