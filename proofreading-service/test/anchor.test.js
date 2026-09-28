import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate } from '../src/pi-runner.js';

test('only unique original spans become highlights', () => {
  const text = ['今天晴。今天晴。', '🌤A'];
  assert.throws(() => locate({ paragraph_id: 'p0', quote: '今天晴' }, text), /ambiguous_anchor/);
  assert.deepEqual(locate({ paragraph_id: 'p0', quote: '今天晴', before: '。' }, text), { paragraph_id: 'p0', start: 4, end: 7 });
  assert.deepEqual(locate({ paragraph_id: 'p1', quote: 'A' }, text), { paragraph_id: 'p1', start: 2, end: 3 });
  assert.throws(() => locate({ paragraph_id: 'p0', quote: '捏造引文' }, text), /ambiguous_anchor/);
});

test('wrong or missing paragraph identifiers recover only exact unique text', () => {
  const paragraphs = ['标题', '', '🌤这里有唯一错误。', '另一个段落'];
  for (const paragraph_id of ['p0', 'p99', '第3段', undefined]) {
    const anchor = locate({ paragraph_id, quote: '唯一错误', before: '模型写错前文', after: '模型写错后文' }, paragraphs);
    assert.deepEqual(anchor, { paragraph_id: 'p2', start: 5, end: 9 });
    assert.equal(paragraphs[2].slice(anchor.start, anchor.end), '唯一错误');
  }
});

test('context can resolve a wrong paragraph but repeated or rewritten quotes are never guessed', () => {
  const paragraphs = ['甲处错误。乙处错误。', '丙处错误。'];
  assert.deepEqual(locate({ paragraph_id: 'p99', quote: '错误', before: '乙处' }, paragraphs), { paragraph_id: 'p0', start: 7, end: 9 });
  assert.throws(() => locate({ paragraph_id: 'p99', quote: '错误' }, paragraphs), /ambiguous_anchor/);
  assert.throws(() => locate({ paragraph_id: 'p99', quote: '错误', before: '捏造' }, paragraphs), /ambiguous_anchor/);
  assert.throws(() => locate({ quote: '甲处 错误。' }, paragraphs), /ambiguous_anchor/);
  assert.throws(() => locate({ quote: '甲处错误！' }, paragraphs), /ambiguous_anchor/);
});
