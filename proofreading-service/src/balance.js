// DeepSeek 余额查询：API Key 只在本模块与后台进程内使用，绝不下发给浏览器或写入日志。
// 结果缓存 ttlMs，失败时同样缓存空值，避免供应商故障时高频重试；永远不抛错、不阻塞可用性接口。
export function createBalanceProvider({ url = 'https://api.deepseek.com/user/balance', apiKey, ttlMs = 300_000, fetchImpl = fetch, now = () => Date.now(), logger = null } = {}) {
  if (!apiKey) return null;
  let cache = null; // { at, data }
  let inflight = null;
  async function refresh() {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`balance_http_${response.status}`);
    const body = await response.json();
    const info = Array.isArray(body?.balance_infos) ? body.balance_infos.find(entry => entry.currency === 'CNY') || body.balance_infos[0] : null;
    if (!info || typeof info.total_balance !== 'string') throw new Error('balance_unexpected_shape');
    return { total: info.total_balance, currency: info.currency || 'CNY', is_available: body?.is_available === true };
  }
  return {
    async get() {
      if (cache && now() - cache.at < ttlMs) return cache.data;
      if (!inflight) {
        inflight = refresh()
          .then(data => { cache = { at: now(), data }; return data; })
          .catch(error => { cache = { at: now(), data: null }; logger?.log('balance_unavailable', { error: error instanceof Error ? error.message : String(error) }); return null; })
          .finally(() => { inflight = null; });
      }
      return inflight;
    },
  };
}
