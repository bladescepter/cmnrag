import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyVerdicts } from '../src/verification.js';
import { locate } from '../src/pi-runner.js';
import { locateOpinionMarks, OPINION_LINE, PROOFREADING_PHASES, currentProofreadingPhase } from '../../cmnrag-website/public/proofreading/display-marks.js';

const source = { url: 'https://authority.example/news', title: '权威原文', snippet: '正式名称：正确机构名称。' };
test('fact judgments publish only proven, anchored errors; correct and uncertain facts stay internal', () => {
  const evidence = [{ url: source.url, excerpt: '正确机构名称' }];
  const issue = { paragraph_id: 'p0', quote: '错误机构名', reason: '与官方正式名称不符', suggestion: '正确机构名称' };
  const verdicts = [
    { item: '错项', status: 'incorrect', note: '官方直接发布，名称不符', evidence, issue },
    { item: '对项', status: 'correct', note: '官方直接发布，名称一致', evidence },
    { item: '未知', status: 'unresolved', note: '没有足够证据' },
    { item: '伪证', status: 'incorrect', note: '不能接受', evidence: [{ url: source.url, excerpt: '不在摘要内' }], issue },
    { item: '错位', status: 'incorrect', note: '定位失败', evidence, issue: { ...issue, quote: '原文不存在' } },
  ];
  const result = applyVerdicts(verdicts.map(v => v.item), verdicts, [source], i => locate(i, ['错误机构名']));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].reason, issue.reason);
  assert.equal(result.verified.length, 1);
  assert.deepEqual(result.remaining, ['未知', '伪证', '错位']);
});

test('workbench does not render search results, correct facts or pending lists, including old tasks', () => {
  class Element {
    children = []; textContent = ''; classList = { add() {}, remove() {}, toggle() {} };
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; this.textContent = ''; }
    addEventListener() {} setAttribute() {}
    text() { return this.textContent + this.children.map(c => c.text()).join(''); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    createTextNode(text) { const e = new Element(); e.textContent = text; return e; },
  };
  const script = readFileSync(new URL('../../cmnrag-website/public/proofreading/workbench.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').split('async function refreshTask(id)')[0];
  const context = { document, URL, requestJson: () => {}, verifyAnchor: () => ({ index: 0, start: 0, end: 2 }), task: {
    status: 'partial', content: '错字', issues: [{ id: 'i1', quote: '错字', category: 'grammar', reason: '明确错误', suggestion: '改字' }],
    unverified: ['不应展示待核实事项'], verified: [{ text: '不应展示正确项' }],
    sources: [{ ...source, title: '不应展示搜索结果' }], stages: [{ name: '不应展示搜索统计', status: 'done' }], note: '不应展示旧版核查清单说明',
  } };
  runInNewContext(script + '\nrenderTask(task);', context);
  const text = [...elements.values()].map(e => e.text()).join('');
  assert.ok(text.includes('明确错误'));
  assert.ok(!text.includes('不应展示'));
  context.task = { ...context.task, status: 'completed', issues: [] };
  runInNewContext('renderTask(task);', context);
  assert.equal(elements.get('findings').text(), '无意见');
});

test('history dropdown mirrors the task list and filters invalid ids', () => {
  class Element {
    children = []; textContent = ''; className = ''; value = ''; disabled = false; selected = false;
    classList = { add() {}, remove() {}, toggle() {} };
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; this.textContent = ''; }
    addEventListener() {} setAttribute() {}
    text() { return this.textContent + this.children.map(c => c.text()).join(''); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    createTextNode(text) { const e = new Element(); e.textContent = text; return e; },
  };
  const script = readFileSync(new URL('../../cmnrag-website/public/proofreading/workbench.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').split('async function refreshTask(id)')[0];
  const sampleId = '0f0e0d0c-0b0a-4909-8807-060504030201';
  const context = { document, URL, requestJson: () => {}, sampleId };
  runInNewContext(script + '\nrenderList([{ id: sampleId, title: "清源县样稿", status: "completed" }, { id: "not-a-uuid", title: "坏id", status: "failed" }]);', context);
  const options = elements.get('task-select').children;
  assert.equal(options.length, 2); // 占位项 + 合法条目；非法 id 被过滤
  assert.equal(options[0].value, '');
  assert.equal(options[0].disabled, true);
  assert.equal(options[1].value, sampleId);
  assert.ok(options[1].text().includes('清源县样稿'));
  assert.ok(options[1].text().includes('已完成'));
  assert.equal(elements.get('task-list').children.length, 1); // 桌面列表同步渲染
  runInNewContext('renderList([]);', context);
  assert.equal(elements.get('task-select').children.length, 1); // 空历史只剩占位项
  assert.ok(elements.get('task-select').children[0].text().includes('暂无历史稿件'));
});

test('native pi answers render verbatim as text without executing HTML or dropping lines', () => {
  class Element {
    children = []; textContent = ''; classList = { add() {}, remove() {}, toggle() {} };
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; this.textContent = ''; }
    addEventListener() {} setAttribute(name, value) { (this.attributes ??= {})[name] = value; } getAttribute(name) { return (this.attributes ?? {})[name]; }
    text() { return this.textContent + this.children.map(c => c.text()).join(''); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    createTextNode(text) { const e = new Element(); e.textContent = text; return e; },
  };
  const script = readFileSync(new URL('../../cmnrag-website/public/proofreading/workbench.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').split('async function refreshTask(id)')[0];
  const context = { document, URL, requestJson: () => {}, verifyAnchor: () => ({ index: 0, start: 0, end: 2 }), locateOpinionMarks, OPINION_LINE, task: {
    status: 'partial', content: '第一段\n截止今天。', result_format: 'pi-final-text-v1',
    result_text: '【文法】第2段：截止今天 → 改为：截至今天\n<img src=x onerror=alert(1)>不在任何标签内执行\n<script>bad()</script>\n【口径】末行意见\n',
    stages: [{ name: 'Pi 读取技能参考文件', status: 'done' }], note: '技能执行未全部完成；保留 Pi 最终回答，不代表校对通过。',
    issues: [], unverified: [], verified: [], sources: [],
  } };
  runInNewContext(script + '\nrenderTask(task);', context);
  const findings = elements.get('findings');
  const marks = () => elements.get('source-text').children.flatMap(p => p.children).filter(c => c.className === 'native-mark');
  assert.equal(marks().length, 0); // Partial results never add underlines while proofreading is unfinished.
  const rendered = findings.children.map(c => c.text()).join('');
  assert.equal(elements.get('finding-count').textContent, 'Pi 最终回答');
  // 意见行前置编号徽标；徽标之外的文本节点逐字等于原始回答，不增删不改。
  const resultBox = findings.children.find(c => c.children.length > 0);
  const badgeText = resultBox.children.filter(c => c.className === 'opinion-number').map(c => c.text());
  const verbatim = resultBox.children.filter(c => c.className !== 'opinion-number').map(c => c.text()).join('');
  assert.deepEqual(badgeText, ['1']);
  assert.equal(verbatim, context.task.result_text);
  assert.ok(rendered.includes('截至今天'));
  assert.ok(rendered.includes('【口径】末行意见'));
  assert.ok(verbatim.includes('\n')); // 换行原样保留，不合并、不删行
  assert.ok(rendered.includes('<img src=x onerror=alert(1)>')); // 标签只作为字符串存在
  assert.ok(rendered.includes('<script>bad()</script>')); // 从不作为 HTML 执行：渲染只走 textContent/append
  const taskNote = [...elements.values()].map(e => e.text()).join('');
  assert.ok(taskNote.includes('不代表校对通过')); // partial 状态与回答分开呈现
  // 恐意标签从不作为 HTML 执行：Element 只接受 textContent/append，脚本中的任何标签都只是字符串。
  context.task = { ...context.task, status: 'completed' };
  runInNewContext('renderTask(task);', context);
  assert.deepEqual(marks().map(c => c.text()), ['截止今天']);
  assert.equal(marks().map(c => c.getAttribute('data-n')).join(''), '1'); // 划线携带意见编号，但不改变划线内文本。
  assert.equal(elements.get('source-text').children.map(p => p.text()).join('\n'), context.task.content); // Underlining never changes the original.
  assert.equal(elements.get('source-mark-count').textContent, '意见 1 条 · 划线 1 处');
  context.task = { ...context.task, result_text: '无意见' };
  runInNewContext('renderTask(task);', context);
  assert.equal(marks().length, 0); // Poll refresh clears stale marks.
  assert.equal(findings.children.map(c => c.text()).join(''), '无意见');
});

test('running progress shows four abstract phases, a spinner and elapsed time without detailed stages', () => {
  class Element {
    children = []; textContent = ''; classList = { add() {}, remove() {}, toggle() {} };
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; this.textContent = ''; }
    addEventListener() {} setAttribute() {}
    text() { return this.textContent + this.children.map(c => c.text()).join(''); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    createTextNode(text) { const el = new Element(); el.textContent = text; return el; },
  };
  const script = readFileSync(new URL('../../cmnrag-website/public/proofreading/workbench.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').split('async function refreshTask(id)')[0];
  const start = new Date(Date.now() - 70_000).toISOString();
  const context = { document, URL, requestJson: () => {}, verifyAnchor: () => null,
    locateOpinionMarks, OPINION_LINE, PROOFREADING_PHASES, currentProofreadingPhase,
    task: { status: 'running', title: '测试', model: '测试模型', content: '标题', created_at: start,
      stages: [{ name: 'Pi 已载入原版校对技能', status: 'done' }], issues: [] } };
  runInNewContext(script + '\nrenderTask(task);', context);
  const progress = elements.get('task-progress');
  const steps = progress.children[0].children;
  assert.deepEqual(steps.map(step => step.className), ['phase active', 'phase', 'phase', 'phase']);
  assert.ok(steps[0].children.some(el => el.className === 'phase-spinner'));
  assert.ok(!progress.text().includes('Pi 已载入原版校对技能'));
  assert.match(elements.get('task-elapsed').textContent, /^已持续 1 分/);
  assert.equal(elements.get('task-elapsed').hidden, false);
  context.task = { ...context.task, stages: [{ name: 'Pi 调用 TinyFish Search', status: 'done' }] };
  runInNewContext('renderTask(task);', context);
  assert.deepEqual(progress.children[0].children.map(step => step.className), ['phase done', 'phase done', 'phase active', 'phase']);
  context.task = { ...context.task, status: 'completed', updated_at: new Date(Date.parse(start) + 90_000).toISOString() };
  runInNewContext('renderTask(task);', context);
  assert.equal(progress.children.length, 0);
  assert.match(elements.get('task-elapsed').textContent, /^任务总用时 1 分 30 秒/);
  context.task = { ...context.task, status: 'queued' };
  runInNewContext('renderTask(task);', context);
  assert.equal(progress.children.length, 0); // 排队不是“读取资料中”。
  assert.match(elements.get('task-elapsed').textContent, /^已等待/);
});
