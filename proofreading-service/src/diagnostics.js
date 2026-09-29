import { appendFileSync, mkdirSync, statSync, renameSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

// 诊断日志：只记录事件名、时长、计数与错误码；绝不记录稿件、提示词、模型输出或密钥原文。
// 同步追加写入：进程卡死或崩溃时，已写下的行不会丢失——最后一行即卡住位置。
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  [/\b(?:tp|ttp)-[A-Za-z0-9_-]{6,}/g, '***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***'],
];

export function redactDiagnostic(value, maxChars = 300) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // 数组（如搜索词清单）逐项脱敏后保留，最多 20 项；修复此前被静默折看为 "object" 的丢失。
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactDiagnostic(item, maxChars));
  if (typeof value !== 'string') return typeof value;
  let text = value.length > maxChars ? value.slice(0, maxChars) : value;
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function createDiagnosticsLogger(filePath, { maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!filePath) return null;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = openSync(filePath, 'wx', 0o600); // 已存在时抛 EEXIST，属正常
    closeSync(fd);
  } catch (error) {
    if (error?.code !== 'EEXIST') return null; // 日志不可用时返回 null，不影响任务本身
  }
  return {
    log(event, fields = {}) {
      if (typeof event !== 'string' || !event) return;
      const record = { t: new Date().toISOString(), event };
      for (const [key, value] of Object.entries(fields)) {
        if (key === 't' || key === 'event') continue;
        record[key] = redactDiagnostic(value);
      }
      let line;
      try { line = JSON.stringify(record); } catch { return; }
      try {
        try {
          if (statSync(filePath).size + line.length + 1 > maxBytes) renameSync(filePath, `${filePath}.1`); // 单次轮转，覆盖旧的 .1
        } catch { /* 轮转失败则继续追加 */ }
        appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
      } catch { /* 写入失败不影响任务 */ }
    },
  };
}
