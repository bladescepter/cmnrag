import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { signTestToken } from './auth.js';
import { hasLocalAuthSchema } from './local-auth-schema.js';
import { createDiagnosticsLogger } from './diagnostics.js';
import { observeChild } from './child-observer.js';
import { createWorkerRecovery } from './worker-recovery.js';
import { stopChild } from './stop-child.js';

const serviceDir = fileURLToPath(new URL('../', import.meta.url));
const websiteDir = resolve(serviceDir, '../cmnrag-website');
const projectRoot = resolve(serviceDir, '..');
const stateDir = join(serviceDir, 'data', 'web-test');
const varsFile = join(websiteDir, '.dev.vars');
const marker = '# cmnrag-proofreading-local-v1';
const backendUrl = 'http://127.0.0.1:8788/';
const siteUrl = 'http://127.0.0.1:8787';
const cliEnv = { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8',
  NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', CI: '1', WRANGLER_SEND_METRICS: 'false' };
const children = new Set();
const retiring = new WeakSet();
let supervisor = null;
let workerRecovery = null;
let stopping = false;
let resolveStop;
const stopSignal = new Promise(resolve => { resolveStop = resolve; });

function parseManagedVars(text) {
  if (!text.startsWith(marker + '\n')) throw new Error('已有非本工具创建的 .dev.vars；不会覆盖，请先自行处理');
  const entries = new Map();
  for (const line of text.trim().split('\n').slice(1)) {
    const match = line.match(/^([A-Z_]+)="([A-Za-z0-9:./-]+)"$/);
    if (!match || entries.has(match[1])) throw new Error('本机 Worker 配置格式无效；不会覆盖');
    entries.set(match[1], match[2]);
  }
  if (entries.size !== 4 || entries.get('PROOFREADING_BACKEND_URL') !== backendUrl || entries.get('PROOFREADING_LOCAL_LOOPBACK') !== '1' ||
    !/^[a-f0-9]{64}$/.test(entries.get('PROOFREADING_SIGNING_SECRET') || '') || !/^[a-f0-9]{32}$/.test(entries.get('ADMIN_INIT_SECRET') || '')) {
    throw new Error('本机 Worker 配置不符合预期；不会覆盖');
  }
  return entries;
}
async function localVars() {
  try {
    const info = await lstat(varsFile);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('已有 .dev.vars 权限不安全；需要 0600');
    return parseManagedVars(await readFile(varsFile, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const content = `${marker}\nPROOFREADING_BACKEND_URL="${backendUrl}"\nPROOFREADING_SIGNING_SECRET="${randomBytes(32).toString('hex')}"\nPROOFREADING_LOCAL_LOOPBACK="1"\nADMIN_INIT_SECRET="${randomBytes(16).toString('hex')}"\n`;
  const file = await open(varsFile, 'wx', 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
  return parseManagedVars(content);
}
function stop(reason = 'shutdown') {
  if (stopping) return;
  stopping = true;
  workerRecovery?.close();
  if (reason === 'child_exit' || reason === 'child_error') process.exitCode = 1;
  supervisor?.log('supervisor_stop', { reason });
  resolveStop();
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* child already exited */ }
  }
}
function launch(command, args, options, service) {
  if (stopping) throw new Error('本地服务启动已停止');
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(child);
  child.once('close', () => children.delete(child));
  supervisor?.log('child_start', { service, pid: child.pid ?? null });
  observeChild(child, service, supervisor, {
    isStopping: () => stopping || retiring.has(child), stop,
    onUnexpectedExit: (name, reason) => workerRecovery ? workerRecovery.unexpectedExit(name, reason) : stop(reason),
  });
  return child;
}
async function waitFor(url, check, child, attempts = 100) {
  for (let i = 0; i < attempts && !stopping; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error('本地服务提前退出；没有提交任何模型任务');
    try {
      const response = await fetch(url, { ...check(), signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok && child.exitCode === null && !child.signalCode) return;
    } catch { /* startup not complete */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('本地服务启动超时或未就绪；没有提交任何模型任务');
}
async function assertFreePort(port) {
  const server = createServer();
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady); });
  await new Promise((resolveDone, reject) => server.close(error => error ? reject(error) : resolveDone()));
}
function onSigInt() { stop('SIGINT'); }
function onSigTerm() { stop('SIGTERM'); }
process.on('SIGINT', onSigInt);
process.on('SIGTERM', onSigTerm);
try {
  const envInfo = await lstat(join(serviceDir, '.env'));
  if (!envInfo.isFile() || (envInfo.mode & 0o077)) throw new Error('测试 Key 文件不存在或权限不是 0600');
  await access(join(projectRoot, '..', 'proofreading', '.pi', 'skills', 'proofreading', 'SKILL.md'));
  await assertFreePort(8788);
  await assertFreePort(8787);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  supervisor = createDiagnosticsLogger(join(stateDir, 'supervisor.jsonl'));
  if (!supervisor) throw new Error('本地服务诊断日志不可写');
  supervisor.log('supervisor_start', {});
  const signing = await localVars();
  const rulesDir = join(projectRoot, '..', 'proofreading', '.pi', 'skills', 'proofreading');
  const backend = launch(process.execPath, ['--env-file=.env', 'src/main.js'], { cwd: serviceDir, env: {
    ...cliEnv, PROOFREADING_STATE_DIR: join(stateDir, 'backend'), PROOFREADING_RULES_DIR: rulesDir,
    PROOFREADING_SIGNING_SECRET: signing.get('PROOFREADING_SIGNING_SECRET'), PROOFREADING_ENABLE_OFFLINE_PARTIAL: '1',
  } }, 'backend');
  await waitFor(backendUrl + 'api/proofreading/availability', () => ({ headers: { authorization: `Bearer ${signTestToken(1, signing.get('PROOFREADING_SIGNING_SECRET'))}` } }), backend);
  const persistTo = join(stateDir, 'worker');
  if (!(await hasLocalAuthSchema(persistTo))) {
    const migration = launch('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--yes', `--file=${join(websiteDir, 'migrations', '0004_auth.sql')}`, `--persist-to=${persistTo}`], { cwd: websiteDir, env: cliEnv }, 'migration');
    await new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => {
        try { process.kill(-migration.pid, 'SIGTERM'); } catch { /* already exited */ }
        reject(new Error('本地 D1 认证表初始化超时；未连接生产数据库'));
      }, 60000);
      migration.once('exit', code => {
        clearTimeout(timer);
        code === 0 ? resolveDone() : reject(new Error('本地 D1 认证表初始化失败；未连接生产数据库'));
      });
      migration.once('error', () => {
        clearTimeout(timer);
        reject(new Error('本地 D1 认证表初始化失败；未连接生产数据库'));
      });
    });
  }
  async function startWorker() {
    // 直接调用本项目已安装的 Wrangler CLI，避免引入 npm exec 包装进程。
    const worker = launch(join(websiteDir, 'node_modules', '.bin', 'wrangler'), ['dev', '--local', '--ip', '127.0.0.1', '--port', '8787', '--host', '127.0.0.1', `--persist-to=${persistTo}`, '--show-interactive-dev-session=false'], { cwd: websiteDir, env: cliEnv }, 'worker');
    try {
      await waitFor(siteUrl + '/health', () => ({}), worker);
    } catch (error) {
      // A failed readiness probe must not leave a living process holding the port across retries.
      retiring.add(worker);
      await stopChild(worker);
      throw error;
    }
  }
  workerRecovery = createWorkerRecovery({ logger: supervisor, stop, restart: startWorker });
  await startWorker();
  workerRecovery.markReady();
  supervisor.log('supervisor_ready', {});
  console.log(`本机网页已就绪：${siteUrl}/proofreading/`);
  console.log('首次使用：打开本机 /login.html 注册；管理员初始化码保存在 cmnrag-website/.dev.vars 的 ADMIN_INIT_SECRET，勿发给他人。注册后回登录页登录。');
  console.log('只提交已去敏、获准外传的稿件；每次提交均会询问确认，不限制每日篇数。此模式调用 MiMo 并可能计费；配置 TinyFish 后仅按校对技能要求进行必要联网核查。按 Ctrl+C 停止两项本地服务。');
  await stopSignal;
} catch (error) {
  supervisor?.log('supervisor_error', { code: error?.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'startup_failed' });
  const safe = error?.code === 'EADDRINUSE' ? '本机测试端口被占用，请先停止已启动的测试服务' :
    typeof error?.message === 'string' && /^(已有|本机 Worker|测试 Key|本地服务|本地 D1)/.test(error.message) ? error.message :
    '本机测试环境启动失败（详情不写入日志，未触发模型调用）';
  console.error(safe);
  process.exitCode = 1;
} finally {
  stop();
  supervisor?.log('supervisor_end', { exit_code: process.exitCode ?? 0 });
  process.off('SIGINT', onSigInt);
  process.off('SIGTERM', onSigTerm);
}
