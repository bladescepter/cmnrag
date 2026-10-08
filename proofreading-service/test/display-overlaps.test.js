import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { verifyAnchor } from '../../cmnrag-website/public/proofreading/anchors.js';
import { locateOpinionMarks, validateDisplayMarks, buildMarkSegments, OPINION_LINE } from '../../cmnrag-website/public/proofreading/display-marks.js';

class Element {
  children = []; textContent = ''; attributes = {}; listeners = {}; active = false;
  classList = { add: () => { this.active = true; }, remove: () => { this.active = false; }, toggle() {} };
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; this.textContent = ''; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
  scrollIntoView() {}
  text() { return this.textContent + this.children.map(c => c.text()).join(''); }
}
const script = readFileSync(new URL('../../cmnrag-website/public/proofreading/workbench.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').split('async function refreshTask(id)')[0];
function render(task, locator = locateOpinionMarks) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    createTextNode(text) { const el = new Element(); el.textContent = text; return el; },
  };
  runInNewContext(script + '\nrenderTask(task);', { document, URL, requestJson() {}, verifyAnchor, locateOpinionMarks: locator, validateDisplayMarks, buildMarkSegments, OPINION_LINE, task });
  return elements;
}
const allChildren = element => element.children.flatMap(child => [child, ...allChildren(child)]);

test('native identical, containing and crossing quotes keep every badge and the immutable source, with line fallback', () => {
  const content = '🌤标题\n甲乙丙丁戊己庚。\n尾段';
  const result_text = [
    '【文法】第2段：“甲乙丙丁戊”；修改。',
    '【准确】第2段：“甲乙丙丁戊”；核对。',
    '【口径】第2段：“乙丙”；修改。',
    '【文法】第2段：“丁戊己庚”；修改。',
    '【准确】第2段：“不存在”；核对。',
  ].join('\n');
  const elements = render({ content, result_text, status: 'completed', result_format: 'pi-final-text-v1' });
  const source = elements.get('source-text');
  assert.equal(source.children.map(p => p.text()).join('\n'), content);
  const marks = allChildren(source).filter(el => el.className === 'native-mark');
  assert.deepEqual(marks.map(el => el.text()), ['甲', '乙丙', '丁戊', '己庚', '。']);
  assert.deepEqual(marks.map(el => el.attributes['data-n']), ['1 2 5', '1 2 3 5', '1 2 4 5', '4 5', '5']);
  assert.deepEqual(allChildren(source).filter(el => el.className === 'mark-number').map(el => el.attributes['data-n']), ['3', '1', '2', '4', '5']);
  assert.equal(elements.get('source-mark-count').textContent, '意见 5 条 · 划线 4 处');
  const result = elements.get('findings').children[0];
  assert.deepEqual(result.children.filter(el => el.className === 'opinion-number').map(el => el.text()), ['1', '2', '3', '4', '5']);
  assert.equal(result.children.filter(el => el.className !== 'opinion-number').map(el => el.text()).join(''), result_text);
});

test('a located range across original newlines is rendered without duplicating text or badges', () => {
  const content = '甲乙\n丙丁';
  const elements = render({ content, status: 'completed', result_format: 'pi-final-text-v1', result_text: '' },
    () => [{ number: 1, spans: [{ start: 0, end: content.length }] }]);
  const source = elements.get('source-text');
  assert.equal(source.children.map(p => p.text()).join('\n'), content);
  assert.deepEqual(allChildren(source).filter(el => el.className === 'native-mark').map(el => el.text()), ['甲乙', '丙丁']);
  assert.equal(allChildren(source).filter(el => el.className === 'mark-number').length, 1);
});

test('nine opinion numbers all appear on source underlines, including subtitle, inserted names and shared quotes', () => {
  // A regression fixture for the reported shape; these opinions are not a recovered production verdict.
  const content = '风从海上来\n——泉州气象科普进村入户“赶路”记\n茶山上的“板凳读书会”。\n老黄说：“收成稳了。”\n工程师给孩子们上“开学第一课”。\n百叶箱里面为什么是白的。';
  const result_text = [
    '【文法】副标题：“—泉州气象科普进村入户‘赶路’记”；修改。',
    '【文法】第3段：“板凳读书会”；修改。',
    '【准确】第3段：“茶山上的‘板凳读书会’”；核对。',
    '【文法】第4段：“收成稳了”；修改。',
    '【准确】第4段：“老黄缺少姓名”；补全姓名。',
    '【文法】第5段：“开学第一课”；修改。',
    '【准确】第5段：“开学第一课”；核对。',
    '【准确】第5段：“工程师缺少姓名”；补全姓名。',
    '【文法】第6段：“百叶箱里面为什么是白的。”；修改。',
  ].join('\n');
  const display_marks = locateOpinionMarks(content, result_text,
    [2, 3, 3, 4, 4, 5, 5, 5, 6].map((line, index) => ({ number: index + 1, lines: [line] })), { requireLocations: true });
  const elements = render({ content, result_text, display_marks, status: 'completed', result_format: 'pi-final-text-v1' });
  const source = elements.get('source-text');
  assert.equal(source.children.map(p => p.text()).join('\n'), content);
  const badges = allChildren(source).filter(el => el.className === 'mark-number');
  assert.deepEqual([...new Set(badges.map(el => Number(el.attributes['data-n'])))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(allChildren(source).some(el => el.className === 'native-mark' && el.text() === content.split('\n')[1]));
  assert.ok(allChildren(source).some(el => el.className === 'native-mark' && el.attributes['data-n'].split(' ').includes('6') && el.attributes['data-n'].split(' ').includes('7')));
  assert.ok(allChildren(source).some(el => el.attributes.title?.includes('整行')));
  assert.doesNotMatch(elements.get('source-mark-count').textContent, /未定位/);
  const result = elements.get('findings').children[0];
  assert.equal(result.children.filter(el => el.className !== 'opinion-number').map(el => el.text()).join(''), result_text);
});

test('invalid stored locations cannot produce false underlines or hide unlocated opinion numbers', () => {
  const result_text = '【文法】第1段：“原文”；修改。';
  const elements = render({ content: '原文', result_text, display_marks: [{ number: 1, spans: [{ start: 0, end: 99 }] }],
    status: 'completed', result_format: 'pi-final-text-v1' });
  assert.equal(allChildren(elements.get('source-text')).filter(el => el.className === 'native-mark').length, 0);
  assert.match(elements.get('source-mark-count').textContent, /1 条未定位（需补充定位信息）/);
});

test('legacy overlapping findings retain separate selectable badges and highlight all covered segments', () => {
  const issues = [
    { id: 'one', quote: '甲乙丙丁', start: 0, end: 4 },
    { id: 'two', quote: '甲乙丙丁', start: 0, end: 4 },
    { id: 'three', quote: '乙丙', start: 1, end: 3 },
  ].map(issue => ({ ...issue, category: 'grammar', reason: '明确错误', suggestion: '修改',
    anchor: { version_id: 'v1', paragraph_id: 'p0', start: issue.start, end: issue.end } }));
  const elements = render({ status: 'completed', content: '甲乙丙丁。', version_id: 'v1', issues });
  const source = elements.get('source-text');
  assert.equal(source.children[0].text(), '甲乙丙丁。');
  const badges = allChildren(source).filter(el => el.className === 'mark-number');
  assert.deepEqual(badges.map(el => el.attributes['data-n']), ['3', '1', '2']);
  assert.ok(!elements.get('findings').text().includes('重叠'));
  badges[2].listeners.click({ stopPropagation() {} });
  const cards = elements.get('findings').children;
  assert.deepEqual(cards.map(el => el.active), [false, true, false]);
  const marks = allChildren(source).filter(el => el.className === 'source-mark');
  assert.deepEqual(marks.map(el => el.active), [true, true, true]);
  badges[0].listeners.keydown({ key: 'Enter', stopPropagation() {}, preventDefault() {} });
  assert.deepEqual(cards.map(el => el.active), [false, false, true]);
  assert.deepEqual(marks.map(el => el.active), [false, true, false]);
});
