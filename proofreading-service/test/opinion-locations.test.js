import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberedManuscript, splitLocatedAnswer, resolveDisplayMarks, marksComplete } from '../src/opinion-locations.js';
import { locateOpinionMarks, sourceLines, validateDisplayMarks } from '../../cmnrag-website/public/proofreading/display-marks.js';

const locations = (number, ...lines) => ({ number, lines });

test('subtitle nested quotations and double dash variants map to the complete original subtitle', () => {
  const original = '风从海上来\n——泉州气象科普进村入户“赶路”记\n正文。';
  for (const quote of ['“—泉州气象科普进村入户‘赶路’记”', '“——泉州气象科普进村入户“赶路”记”', '`——泉州气象科普进村入户“赶路”记`']) {
    const answer = `【文法】第1段：${quote}；修改。`;
    const marks = resolveDisplayMarks(original, answer, [locations(1, 2)]);
    assert.equal(original.slice(marks[0].spans[0].start, marks[0].spans[0].end), original.split('\n')[1]);
    assert.equal(marksComplete(original, answer, marks), true);
  }
});

test('unwrapped sentences retain internal quotations; semicolons inside a quoted error are preserved', () => {
  const original = '孩子们问“哪个是风速仪”“百叶箱为什么是白的”。\n原句甲；原句乙。';
  const first = '【文法】第1段：孩子们问“哪个是风速仪”“百叶箱为什么是白的”；修改。';
  const second = '【文法】第2段：“原句甲；原句乙”；应改为“其他句子”；原因。';
  const marks = resolveDisplayMarks(original, first + '\n' + second, [locations(1, 1), locations(2, 2)]);
  assert.deepEqual(marks.map(opinion => opinion.spans.map(span => original.slice(span.start, span.end))), [
    ['孩子们问“哪个是风速仪”“百叶箱为什么是白的”'], ['原句甲；原句乙'],
  ]);
});

test('physical line IDs disambiguate repeated quotes despite blank lines, headings, CRLF and emoji', () => {
  const original = '🌤标题\r\n\r\n天气晴好。\r\n天气晴好。';
  const answer = '【口径】第1段：“天气晴好”；改为天气晴朗。';
  const marks = resolveDisplayMarks(original, answer, [locations(1, 4)]);
  assert.deepEqual(marks[0].spans, [{ start: original.lastIndexOf('天气晴好'), end: original.length - 1 }]);
  assert.equal(numberedManuscript(original), 'L1\t🌤标题\r\nL2\t\r\nL3\t天气晴好。\r\nL4\t天气晴好。');
  assert.equal(sourceLines(original)[3].start, original.lastIndexOf('天气晴好'));
});

test('missing names and content insertions underline only the model-selected source line', () => {
  const original = '标题\n“我照着做了。”老黄说。\n其他原文。';
  const answer = '【准确】第2段：“老黄缺少完整姓名”；须补充姓名。';
  const marks = resolveDisplayMarks(original, answer, [locations(1, 2)]);
  assert.deepEqual(marks, [{ number: 1, spans: [{ start: 3, end: original.indexOf('\n其他'), scope: 'line' }] }]);
  assert.equal(marksComplete(original, answer, marks), true);
});

test('one opinion can select two repeated passages while multiple opinions may share one range', () => {
  const original = '甲段重复内容。\n乙段重复内容。';
  const answer = '【文法】第1段：“重复内容”；前后重复，删一处。\n【准确】第1段：“重复内容”；核对。';
  const marks = resolveDisplayMarks(original, answer, [locations(1, 1, 2), locations(2, 1)]);
  assert.equal(marks[0].spans.length, 2);
  assert.equal(marks[1].spans.length, 1);
  assert.ok(marks[0].spans.every(span => original.slice(span.start, span.end) === '重复内容'));
  assert.equal(marksComplete(original, answer, marks), true);
});

test('backtick whitespace errors preserve spaces and are never matched to a space-free phrase', () => {
  const original = '标题\n 秋冬季 “虾荒” 。\n秋冬季“虾荒”。';
  const answer = '【文法】第2段：` 秋冬季 “虾荒” `；删除多余空格。';
  const marks = resolveDisplayMarks(original, answer, [locations(1, 2)]);
  assert.equal(original.slice(marks[0].spans[0].start, marks[0].spans[0].end), ' 秋冬季 “虾荒” ');
});

test('invalid, duplicate, missing and blank line metadata cannot complete a new result', () => {
  const original = '标题\n\n原文有错。';
  const answer = '【文法】第3段：“原文有错”；修改。';
  for (const invalid of [[], [locations(1, 2)], [locations(1, 4)], [locations(1, 0)], [locations(1, '3')], [locations(1, 3), locations(1, 1)]]) {
    const marks = resolveDisplayMarks(original, answer, invalid);
    assert.equal(marksComplete(original, answer, marks), false);
    assert.equal(marks[0].spans.length, 0);
  }
  assert.equal(validateDisplayMarks(original, answer, [{ number: 1, spans: [{ start: 0, end: 999 }] }]), null);
  assert.equal(validateDisplayMarks(original, answer, []), null);
  assert.equal(validateDisplayMarks('原文\n', '【文法】第1段：“原文”；修改。', [{ number: 1, spans: [{ start: 0, end: 3 }] }]), null); // A badge cannot be placed on a newline.
});

test('explicit transport footer is removed independently, preserving every opinion character and newline', () => {
  const text = '【文法】第1段：“原文”；修改。\n依据一。\n';
  const footer = '\n<proofreading-locations>\n[{"number":1,"lines":[1]}]\n</proofreading-locations>\n';
  assert.deepEqual(splitLocatedAnswer(text + footer), { text, locations: [locations(1, 1)] });
  assert.deepEqual(splitLocatedAnswer(text), { text, locations: [] });
  assert.deepEqual(splitLocatedAnswer(text + '\n<proofreading-locations>\n坏 JSON\n</proofreading-locations>'), { text, locations: [] });
  assert.deepEqual(splitLocatedAnswer(text + '\n<proofreading-locations>\n['), { text, locations: [] });
});

test('physical line labels recover all six opinions without a footer, preserving blank lines and shared locations', () => {
  // Synthetic reproduction of the production failure shape; no editorial verdict is asserted here.
  const lines = Array.from({ length: 63 }, () => '');
  lines[0] = '测试标题';
  lines[6] = '机构甲（待完善），XXXX（负责人）。';
  lines[24] = '测试服务表述。';
  lines[48] = '“多方联动” 组织模式。';
  lines[62] = '第四项表述。';
  const original = lines.join('\n');
  const answer = [
    '【准确】第7行：“机构甲”；核对。',
    '【文法】第7行：“（待完善）”；删除。',
    '【准确】第7行：“XXXX（负责人）”；补全。',
    '【口径】第25行：“测试服务表述”；核对。',
    '【文法】第49行：`“多方联动” 组织模式`；删除空格。',
    '【文法】第63行：“第四项表述”；核对。',
  ].join('\n');
  const marks = resolveDisplayMarks(original, answer, []);
  assert.equal(marks.length, 6);
  assert.equal(marksComplete(original, answer, marks), true);
  assert.deepEqual(marks.map(opinion => opinion.spans.map(span => original.slice(0, span.start).split('\n').length)),
    [[7], [7], [7], [25], [49], [63]]);
  assert.equal(validateDisplayMarks(original, answer, []), null);
});

test('malformed opinion labels remain counted and require source locations rather than disappearing', () => {
  const original = '标题\n原句。';
  const answer = '【文法】位置未知：“原句”；修改。\n【准确】缺少姓名；补全。';
  const missing = resolveDisplayMarks(original, answer, []);
  assert.equal(missing.length, 2);
  assert.equal(marksComplete(original, answer, missing), false);
  assert.equal(validateDisplayMarks(original, answer, []), null);
  const located = resolveDisplayMarks(original, answer, [locations(1, 2), locations(2, 2)]);
  assert.equal(marksComplete(original, answer, located), true);
  assert.equal(original.slice(located[0].spans[0].start, located[0].spans[0].end), '原句');
  assert.equal(located[1].spans[0].scope, 'line');
});

test('line labels include heading annotations and Chinese numerals; invalid lines cannot complete', () => {
  const original = '标题\n\n原句。';
  for (const label of ['第1行（主标题）', '第一行']) {
    const answer = `【文法】${label}：“需增补”；修改。`;
    const marks = resolveDisplayMarks(original, answer, []);
    assert.equal(marksComplete(original, answer, marks), true);
    assert.equal(original.slice(marks[0].spans[0].start, marks[0].spans[0].end), '标题');
  }
  for (const label of ['第0行', '第2行', '第99行']) {
    const answer = `【文法】${label}：“原句”；修改。`;
    assert.equal(marksComplete(original, answer, resolveDisplayMarks(original, answer, [])), false);
  }
  assert.deepEqual(validateDisplayMarks(original, '无意见', []), []);
  assert.equal(validateDisplayMarks(original, '这里有需要修改的内容。', []), null);
});

test('historical subtitle labels and bracket insertions receive locations without a model request', () => {
  const original = '标题\n—泉州气象科普进村入户“赶路”记\n联合省水务厅发布预警。';
  const answer = '【文法】副标题：“—泉州气象科普进村入户‘赶路’记”；修改。\n【口径】第3段：“（省气象局）联合省水务厅发布预警”；修改。';
  const marks = locateOpinionMarks(original, answer);
  assert.deepEqual(marks.map(opinion => opinion.spans.map(span => original.slice(span.start, span.end))), [
    ['—泉州气象科普进村入户“赶路”记'], ['联合省水务厅发布预警'],
  ]);
});
