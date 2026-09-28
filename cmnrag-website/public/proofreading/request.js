import { networkFailureMessage } from './network-errors.js';

// Retry only read-only requests. A disconnected submission may already have incurred model cost.
export async function requestJson(path, options = {}, { fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const readOnly = method === 'GET';
  for (let attempt = 0; ; attempt++) {
    let response, data;
    try {
      response = await fetchImpl('/api/proofreading' + path, {
        credentials: 'same-origin', ...options,
        ...(readOnly && !options.signal ? { signal: AbortSignal.timeout(10000) } : {}),
      });
      if (readOnly && [502, 503, 504].includes(response.status) && attempt < 3) {
        await response.body?.cancel();
        await sleep([500, 1200, 2500][attempt]);
        continue;
      }
      data = await response.json();
    } catch {
      if (!readOnly || options.signal?.aborted || attempt >= 3) throw new Error(networkFailureMessage(method, path));
      await sleep([500, 1200, 2500][attempt]);
      continue;
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('请先登录后使用校对工作台。');
      if ([502, 503, 504].includes(response.status)) throw new Error('网页连接暂不可用，正在等待恢复；不要重复提交稿件。');
      if (response.status === 413) throw new Error('稿件超过单次请求 200 KB 的传输保护上限；请拆分后提交。');
      throw new Error(typeof data.error === 'string' ? `操作未完成：${data.error}` : '操作未完成，请稍后重试。');
    }
    return data;
  }
}
