import { mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openStore } from './store.js';
import { createBackend } from './server.js';
import { createPiRunner } from './pi-runner.js';
import { createDiagnosticsLogger } from './diagnostics.js';
import { isAllowedBindHost } from './bind-host.js';
import { createTinyFishClient } from './tinyfish.js';
import { createBalanceProvider } from './balance.js';

if (!process.env.PROOFREADING_STATE_DIR) throw new Error('PROOFREADING_STATE_DIR is required');
const stateDir = resolve(process.env.PROOFREADING_STATE_DIR);
const host = process.env.PROOFREADING_HOST || '127.0.0.1';
const port = Number(process.env.PROOFREADING_PORT || 8788);
const secret = process.env.PROOFREADING_SIGNING_SECRET;
if (!secret || secret.length < 32 || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !isAllowedBindHost(host)) throw new Error('Missing/invalid private binding or signing configuration');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const stateStat = await lstat(stateDir);
if (!stateStat.isDirectory() || (stateStat.mode & 0o077)) throw new Error('State directory must be a private 0700 directory');
// 崩溃留痕：dev:web 会丢弃子进程输出，未捕获异常不留痕则完全无法定位。
const diagnostics = createDiagnosticsLogger(join(stateDir, 'diagnostics.jsonl'));
process.on('uncaughtException', (error) => {
  diagnostics?.log('uncaught_exception', { error: error.message, stack: (error.stack || '').split('\n').slice(0, 8).join(' | ') });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  diagnostics?.log('unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  process.exit(1);
});
const search = createTinyFishClient({ apiKey: process.env.PROOFREADING_TINYFISH_API_KEY });
// 模型清单：PROOFREADING_MODELS="provider/model,provider/model"；未设置时回退单模型旧变量。
// 各模型密钥：PROOFREADING_API_KEY_<大写 provider>（- 转 _）；旧变量仅供匹配的默认 provider 复用。
const modelSpecs = (process.env.PROOFREADING_MODELS || `${process.env.PROOFREADING_MODEL_PROVIDER || ''}/${process.env.PROOFREADING_MODEL_ID || ''}`)
  .split(',').map(spec => spec.trim()).filter(spec => /^[^/\s]+\/[^/\s]+$/.test(spec));
const apiKeyFor = provider => process.env[`PROOFREADING_API_KEY_${provider.toUpperCase().replace(/-/g, '_')}`]
  || (provider === process.env.PROOFREADING_MODEL_PROVIDER ? process.env.PROOFREADING_MODEL_API_KEY : undefined);
const runners = {};
const providerKeys = {};
for (const spec of modelSpecs) {
  const [provider, modelId] = spec.split('/');
  const apiKey = apiKeyFor(provider);
  if (!apiKey) { diagnostics?.log('model_skipped', { model: spec, reason: 'missing_api_key' }); continue; }
  providerKeys[provider] = apiKey;
  const runner = await createPiRunner({
    rulesDir: process.env.PROOFREADING_RULES_DIR,
    stateDir,
    provider, modelId,
    thinkingLevel: process.env.PROOFREADING_THINKING_LEVEL,
    apiKey,
    offlinePartial: process.env.PROOFREADING_ENABLE_OFFLINE_PARTIAL === '1',
    logger: diagnostics,
    search,
  });
  if (runner.ready) runners[spec] = runner;
  else diagnostics?.log('model_skipped', { model: spec, reason: 'not_in_catalog' });
}
if (!Object.keys(runners).length) throw new Error('no_model_ready');
// 余额展示：仅当配置了 DeepSeek 密钥时启用，结果经可用性接口中转给已登录用户。
const balance = createBalanceProvider({ apiKey: providerKeys.deepseek, logger: diagnostics });
const store = openStore(join(stateDir, 'tasks.sqlite'));
const service = createBackend({
  store, runners, balance, signingSecret: secret, logger: diagnostics,
});
diagnostics?.log('backend_start', { port, host, models: Object.keys(runners), rule_version: Object.values(runners)[0]?.ruleVersion || '', online: Boolean(search) });
service.server.listen(port, host, () => { console.log(`Proofreading service listening on ${host}:${port}; models ${Object.keys(runners).join(', ')}`); service.kick(); });
// Secrets, manuscript text, prompts and full model outputs must never be logged.
