// 受控 TinyFish Search 客户端：只发送检索词，不发送稿件原文。
// 不调用 TinyFish Fetch、Agent 或 Browser。
// 任何失败都抛错，由调用方降级为“该条待核实”，绝不让检索故障变成任务失败。
const DEFAULT_SEARCH_URL = 'https://api.search.tinyfish.ai';

function httpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function createTinyFishClient({ apiKey, searchUrl = DEFAULT_SEARCH_URL, searchTimeoutMs = 60_000 }) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  async function request(url) {
    const response = await fetch(url, { method: 'GET', headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(searchTimeoutMs) });
    if (!response.ok) throw new Error(`tinyfish_http_${response.status}`);
    return await response.json();
  }
  return {
    online: true,
    /** 搜索：返回 [{ title, url, snippet }]，只保留 https 结果。 */
    async search(query, { limit = 5 } = {}) {
      // 中文稿件按中文/中国地区检索；TinyFish 默认是英文/美国，易错过本地官方结果。
      const endpoint = new URL(searchUrl);
      endpoint.searchParams.set('query', query);
      endpoint.searchParams.set('language', 'zh');
      endpoint.searchParams.set('location', 'CN');
      const data = await request(endpoint.href);
      if (!data || !Array.isArray(data.results)) throw new Error('tinyfish_bad_search_shape');
      const seen = new Set();
      const results = [];
      for (const item of data.results) {
        if (!item || typeof item.url !== 'string') continue;
        const url = httpsUrl(item.url.trim());
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({ title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : url, url, snippet: typeof item.snippet === 'string' ? item.snippet.replace(/\s+/g, ' ').trim().slice(0, 500) : '' });
        if (results.length >= limit) break;
      }
      return results;
    },
  };
}
