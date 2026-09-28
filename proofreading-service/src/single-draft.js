import { lstat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPiRunner } from './pi-runner.js';
import { TEST_LIMITS } from './limits.js';
import { createDiagnosticsLogger } from './diagnostics.js';
import { createTinyFishClient } from './tinyfish.js';

const [fileArg, confirmation, ...extra] = process.argv.slice(2);
const usage = '用法：npm run test:local -- /绝对路径/去敏短稿.md [--confirm-paid-call]';
if (!fileArg || extra.length || (confirmation && confirmation !== '--confirm-paid-call')) throw new Error(usage);
const file = resolve(fileArg);
if (!['.md', '.txt'].includes(extname(file).toLowerCase()) || file.includes('/.env')) throw new Error('只接受去敏 .md / .txt 稿件，不读取凭据文件');
const info = await lstat(file);
if (!info.isFile() || info.size > 8000) throw new Error('文件不是普通文件或超过 8 KB');
const content = await readFile(file, 'utf8');
if (!content.trim() || content.length > TEST_LIMITS.maxDraftChars) throw new Error(`测试稿须为 1—${TEST_LIMITS.maxDraftChars} 字符`);
const provider = process.env.PROOFREADING_MODEL_PROVIDER;
const modelId = process.env.PROOFREADING_MODEL_ID;
const apiKey = process.env.PROOFREADING_MODEL_API_KEY;
if (modelId !== 'mimo-v2.6-flash' || !['xiaomi', 'xiaomi-token-plan-cn'].includes(provider) || !apiKey) throw new Error('需在本地 .env 配置对应的 MiMo-V2.6-Flash 提供商、模型及 Key');
if ((apiKey.startsWith('tp-') || apiKey.startsWith('ttp-')) !== (provider === 'xiaomi-token-plan-cn')) throw new Error('Key 类型与提供商不匹配：Token Plan 与按量付费使用不同接口');
const rulesDir = process.env.PROOFREADING_RULES_DIR || fileURLToPath(new URL('../../../proofreading/.pi/skills/proofreading/', import.meta.url));
console.log(`本地校对测试预检：${provider}/${modelId}；稿件 ${content.length} 字符；技能目录 ${rulesDir}`);
console.log(`最多 ${TEST_LIMITS.maxCalls} 次模型调用；每次最多 ${TEST_LIMITS.maxOutputTokensPerCall} 输出 token；累计至多 ${TEST_LIMITS.maxTotalTokens} token / SDK 预估 $${TEST_LIMITS.maxEstimatedUsd} 后停止下一次调用。`);
console.log('注意：模型供应商按实际请求计费；这些是本地止损闸门，无法保证已发出请求的最终账单上限。未配置 TinyFish 且 Pi 请求搜索时，结果标记为未完成。');
if (confirmation !== '--confirm-paid-call') {
  console.log('预检完成：没有调用模型。确认使用去敏稿并愿意承担测试用量后，在末尾加 --confirm-paid-call 运行一次。');
  process.exit(0);
}
let stateDir;
let usageSnapshot = { calls: 0, totalTokens: 0, estimatedUsd: 0 };
try {
  stateDir = await mkdtemp(join(tmpdir(), 'cmnrag-local-test-'));
  // 诊断日志随临时目录：正常完成时一并清理；卡死或中断时留存，最后一行即卡住位置。
  const diagnostics = createDiagnosticsLogger(join(stateDir, 'diagnostics.jsonl'));
  const search = createTinyFishClient({ apiKey: process.env.PROOFREADING_TINYFISH_API_KEY });
  const runner = await createPiRunner({ rulesDir, stateDir, provider, modelId, apiKey, offlinePartial: true,
    maxDraftChars: TEST_LIMITS.maxDraftChars, maxOutputTokens: TEST_LIMITS.maxOutputTokensPerCall, testBudget: true, onUsage: value => { usageSnapshot = value; }, logger: diagnostics, search });
  if (!runner.ready) throw new Error('模型不可用；未调用模型');
  const task = { id: randomUUID(), version_id: randomUUID(), content, rule_version: runner.ruleVersion, model: runner.model };
  console.log(`技能版本 ${runner.ruleVersion.slice(0, 12)}；联网核查${search ? '已接入（TinyFish）' : '未接入'}。开始单篇试运行。`);
  const result = await runner.run(task, stage => console.log(`实际阶段：${stage}`));
  console.log(result.incomplete ? '技能执行未全部完成；以下为 Pi 最终回答，不代表校对通过。' : 'Pi 校对会话完成；仍需人工审核。');
  console.log(result.text);
} catch (error) {
  const safeCodes = new Set(['test_budget_exceeded', 'test_draft_too_long', 'invalid_model_output', 'invalid_anchor', 'ambiguous_anchor', 'model_timeout', 'model_call_failed', 'model_output_truncated', 'empty_model_response', 'model_usage_or_completion_unavailable', 'usage_unavailable', 'unsafe_session_configuration', 'runner_version_changed', 'scan_failed']);
  const reason = error instanceof Error && safeCodes.has(error.message) ? error.message : '模型或服务异常（详情不写入普通日志）';
  console.error(`本次校对未完成；请勿将其视为「无意见」。原因：${reason}`);
  process.exitCode = 1;
} finally {
  console.log(`本次已记录模型消息：${usageSnapshot.calls} 次；token：${usageSnapshot.totalTokens}；SDK 预估费用：$${usageSnapshot.estimatedUsd.toFixed(5)}。失败或超时的请求也可能产生实际费用，请以供应商账单为准。`);
  if (stateDir) await rm(stateDir, { recursive: true, force: true }); // Only our new per-run scratch directory.
}
