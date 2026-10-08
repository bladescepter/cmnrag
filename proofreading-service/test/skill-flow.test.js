import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiRunner, RULE_FILES } from '../src/pi-runner.js';

const draft = '虚构标题\n截止今天发布。';
const finalText = '【文法】第2段：截止今天 -> 改为：截至今天\n（依据：典型错误案例）\n';
const base = '.pi/skills/proofreading/';
function respond(res, step, mode, repair = false) {
  const calls = [
    RULE_FILES.filter(f => f.startsWith('references/')).map((file, i) => ({ id: `read-${i}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: base + file, ...(mode === 'incomplete' ? { limit: 1 } : {}) }) } })),
    [{ id: 'write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: base + 'drafts/draft.md', content: draft }) } }],
    [{ id: 'scan', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `bash ${base}scripts/scan-keywords.sh ${base}drafts/draft.md` }) } }],
    [{ id: 'read-draft', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: base + 'drafts/draft.md' }) } }],
    [{ id: 'search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['虚构机构 官方名称', '虚构活动 官方主题'] }) } }],
    [{ id: 'cleanup', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `rm ${base}drafts/*.md` }) } }],
  ];
  const tools = repair ? (mode === 'repair-toolcall' ? [{ id: 'unexpected-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: base + 'original.md' }) } }] : null) : calls[step];
  const footer = '\n<proofreading-locations>\n[{"number":1,"lines":[2]}]\n</proofreading-locations>';
  const response = repair ? '<proofreading-locations>\n' + (mode === 'repair-invalid' ? '[{"number":1,"lines":[999]}]' : '[{"number":1,"lines":[2]}]') + '\n</proofreading-locations>'
    : mode === 'clean' ? '无意见\n<proofreading-locations>\n[]\n</proofreading-locations>'
    : mode.startsWith('repair-') ? finalText : finalText + footer;
  const delta = tools ? { role: 'assistant', tool_calls: tools.map((call, index) => ({ index, ...call })) } : { role: 'assistant', content: response };
  const finish = ((mode === 'truncated' && !tools) || (mode === 'repair-truncated' && repair)) ? 'length' : tools ? 'tool_calls' : 'stop';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = { id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fake-native' };
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: mode === 'usage-missing' ? 0 : 40000, completion_tokens: mode === 'usage-missing' ? 0 : 100 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

test('native skill returns verbatim opinions plus source lines in the same final generation; repairs are bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cmnrag-native-pi-'));
  const rulesDir = join(directory, 'rules');
  const stateDir = join(directory, 'state');
  let mode = 'normal', modelCalls = 0, searches = 0;
  const requests = [], logs = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      modelCalls++;
      const request = JSON.parse(body); requests.push(request);
      assert.equal(request.response_format, undefined);
      const repair = request.messages.filter(m => m.role === 'user').length === 2;
      assert.deepEqual((request.tools || []).map(t => t.function.name).sort(), repair ? [] : ['bash', 'read', 'web_search', 'write']);
      assert.equal(request.messages.filter(m => m.role === 'user').length, repair ? 2 : 1);
      assert.ok(JSON.stringify(request.messages).includes('测试原版技能'));
      assert.ok(JSON.stringify(request.messages).includes('L2\\t截止今天发布。'));
      if (repair) assert.ok(JSON.stringify(request.messages).includes('已有校对意见不再修改或重新校对'));
      respond(res, request.messages.filter(m => m.role === 'assistant').length, mode, repair);
    });
  });
  try {
    for (const file of RULE_FILES) {
      await mkdir(join(rulesDir, file, '..'), { recursive: true });
      await writeFile(join(rulesDir, file), file === 'SKILL.md' ? '---\nname: proofreading\ndescription: 测试原版技能\n---\n测试原版技能：读取全部参考文件，写稿、扫描、通读、必要搜索，只输出明确错误。' : file.endsWith('.sh') ? '#!/bin/bash\nprintf "测试扫描线索\\n"\n' : '测试规则第一行\n必须读取第二行\n');
    }
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await mkdir(stateDir);
    await writeFile(join(stateDir, 'models.json'), JSON.stringify({ providers: { fake: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      models: [{ id: 'fake-native', name: 'Fake', contextWindow: 256000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const options = { rulesDir, stateDir, provider: 'fake', modelId: 'fake-native', apiKey: 'sk-local-fake', offlinePartial: true,
      logger: { log(event, fields) { logs.push({ event, ...fields }); } },
      search: { async search(query) { searches++; return [{ title: '测试来源', url: 'https://authority.example/item', snippet: '官方名称及原文' }]; } },
    };
    const productionRunner = await createPiRunner({ ...options, offlinePartial: false });
    assert.equal(productionRunner.ready, true); // 有搜索能力时不要求启用隔离测试的离线开关。
    assert.equal(productionRunner.online, true);
    assert.equal(productionRunner.offlinePartial, false);
    assert.equal((await createPiRunner({ ...options, search: null, offlinePartial: false })).ready, false);
    const runner = await createPiRunner(options);
    const task = { id: 'local', content: draft, rule_version: runner.ruleVersion, model: runner.model };
    const stages = [];
    const result = await runner.run(task, stage => stages.push(stage));
    assert.equal(result.text, finalText);
    assert.equal(result.format, 'pi-final-text-v1');
    assert.equal(result.incomplete, false);
    assert.equal(result.locationIncomplete, false);
    assert.equal(result.locationRepair, false);
    assert.deepEqual(result.displayMarks, [{ number: 1, spans: [{ start: draft.indexOf('截止今天'), end: draft.indexOf('截止今天') + 4 }] }]);
    assert.equal(result.usage.calls, 7);
    assert.ok(result.usage.estimatedUsd > 0.05);
    assert.equal(modelCalls, 7);
    assert.equal(searches, 2);
    assert.ok(stages.includes('Pi 执行关键词扫描'));
    const toolResults = requests.flatMap(r => r.messages.filter(m => m.role === 'tool'));
    assert.ok(toolResults.some(m => JSON.stringify(m).includes('测试扫描线索')));
    assert.ok(toolResults.some(m => JSON.stringify(m).includes('官方名称及原文')));
    const searchLog = logs.filter(entry => entry.event === 'search_queries');
    assert.equal(searchLog.length, 1);
    assert.deepEqual(searchLog[0].queries, ['虚构机构 官方名称', '虚构活动 官方主题']); // 查询词入日志（测试阶段行为核查）
    assert.doesNotMatch(JSON.stringify(logs), /截止今天|官方名称及原文|sk-local-fake/); // 稿件、搜索材料与密钥仍不入日志
    assert.deepEqual(await readdir(join(stateDir, 'workspaces')), []);

    mode = 'clean';
    assert.equal((await runner.run(task)).text, '无意见');
    mode = 'usage-missing';
    const unpriced = await runner.run(task);
    assert.equal(unpriced.text, finalText);
    assert.equal(unpriced.usage.available, false); // Missing bookkeeping does not destroy a completed answer.
    mode = 'incomplete';
    assert.equal((await runner.run(task)).incomplete, true); // A partial read isn't a full rule read.
    mode = 'truncated';
    const before = modelCalls;
    await assert.rejects(() => runner.run(task), /model_output_truncated/);
    assert.equal(modelCalls - before, 7); // No automatic paid retry.
    mode = 'repair-success';
    const beforeRepair = modelCalls;
    const repaired = await runner.run(task);
    assert.equal(modelCalls - beforeRepair, 8); // Exactly one extra request only on missing metadata.
    assert.equal(repaired.text, finalText);
    assert.equal(repaired.locationRepair, true);
    assert.equal(repaired.locationIncomplete, false);
    assert.deepEqual(repaired.displayMarks, result.displayMarks);
    for (const repairMode of ['repair-invalid', 'repair-truncated', 'repair-toolcall']) {
      mode = repairMode;
      const beforeAttempt = modelCalls;
      const unresolved = await runner.run(task);
      assert.equal(modelCalls - beforeAttempt, 8); // No unbounded retries or re-proofreading.
      assert.equal(unresolved.text, finalText);
      assert.equal(unresolved.locationIncomplete, true);
      assert.equal(unresolved.usage.calls, 8);
    }
    mode = 'normal';
    const offline = await createPiRunner({ ...options, search: null });
    assert.equal((await offline.run(task)).incomplete, true); // Requested but unavailable search is not passed off as done.
    assert.deepEqual(await readdir(join(stateDir, 'workspaces')), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
