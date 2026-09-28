// 本机启动器只记录固定类别的诊断信号；绝不保存 stdout/stderr、命令行或环境变量。
const STDERR_HINTS = [
  ['heap_oom', /heap out of memory|allocation failed/i],
  ['process_signal', /SIGKILL|SIGTERM|SIGABRT/i],
  ['pipe_error', /\bEPIPE\b|broken pipe/i],
  ['port_in_use', /\bEADDRINUSE\b/i],
  ['network_error', /\bECONNRESET\b|\bETIMEDOUT\b|fetch failed|Failed to fetch/i],
  ['fatal_error', /FATAL ERROR|uncaught exception|unhandled rejection/i],
  ['cli_error', /\bError:|\berror\b/i],
];

export function observeChild(child, service, logger, { isStopping, stop, onUnexpectedExit = () => stop('child_exit') }) {
  child.stdout?.on('data', () => {});
  const seenHints = new Set();
  let tail = '';
  child.stderr?.on('data', chunk => {
    if (service !== 'worker') return; // 后台错误可能包含模型响应，不做分类或持久化。
    tail = (tail + String(chunk)).slice(-1024);
    for (const [hint, pattern] of STDERR_HINTS) {
      if (!seenHints.has(hint) && pattern.test(tail)) {
        seenHints.add(hint);
        logger?.log('child_stderr_hint', { service, hint });
      }
    }
  });
  let reported = false;
  child.on('error', error => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'unknown';
    logger?.log('child_error', { service, pid: child.pid ?? null, code });
    if (!reported) { reported = true; if (service === 'worker') onUnexpectedExit(service, 'child_error'); else stop('child_error'); }
  });
  child.on('exit', (code, signal) => {
    const expected = isStopping();
    logger?.log('child_exit', { service, pid: child.pid ?? null, code, signal, expected });
    if (!expected && !reported && service !== 'migration') {
      reported = true;
      onUnexpectedExit(service, 'child_exit');
    }
  });
}
