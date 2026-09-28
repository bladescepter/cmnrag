import { mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openStore } from './store.js';
import { createBackend } from './server.js';
import { createPiRunner } from './pi-runner.js';
import { createDiagnosticsLogger } from './diagnostics.js';
import { createTinyFishClient } from './tinyfish.js';

if (!process.env.PROOFREADING_STATE_DIR) throw new Error('PROOFREADING_STATE_DIR is required');
const stateDir = resolve(process.env.PROOFREADING_STATE_DIR);
const host = process.env.PROOFREADING_HOST || '127.0.0.1';
const port = Number(process.env.PROOFREADING_PORT || 8788);
const secret = process.env.PROOFREADING_SIGNING_SECRET;
if (!secret || secret.length < 32 || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', '::1'].includes(host)) throw new Error('Missing/invalid private binding or signing configuration');
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
const runner = await createPiRunner({
  rulesDir: process.env.PROOFREADING_RULES_DIR,
  stateDir,
  provider: process.env.PROOFREADING_MODEL_PROVIDER,
  modelId: process.env.PROOFREADING_MODEL_ID,
  thinkingLevel: process.env.PROOFREADING_THINKING_LEVEL,
  apiKey: process.env.PROOFREADING_MODEL_API_KEY,
  offlinePartial: process.env.PROOFREADING_ENABLE_OFFLINE_PARTIAL === '1',
  logger: diagnostics,
  search,
});
const store = openStore(join(stateDir, 'tasks.sqlite'));
const service = createBackend({
  store, runner, signingSecret: secret, logger: diagnostics,
});
diagnostics?.log('backend_start', { port, host, runner_ready: runner.ready, online: Boolean(search) });
service.server.listen(port, host, () => { console.log(`Proofreading service listening on ${host}:${port}; runner ${runner.ready ? 'pi-skill-v1' : 'disabled'}`); service.kick(); });
// Secrets, manuscript text, prompts and full model outputs must never be logged.
