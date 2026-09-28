// 技能检索门槛：四遍完成后，必要事项合并为一次 2–3 条 Search 查询。
// 不抓取网页；搜索摘要不足以证明的事实保持待核实。不存在事实数量配额。
export function searchPlan(queries, pending = []) {
  if (Array.isArray(queries) && queries.length >= 2 && queries.length <= 3 &&
    queries.every(query => typeof query === 'string' && query.trim() && query.length <= 200)) {
    const unique = [...new Set(queries.map(query => query.trim()))];
    if (unique.length >= 2) return unique;
  }
  // A missing/malformed model search plan must not silently skip required fact checking.
  // Use only the model's explicit pending facts, never the whole draft or local anchor warnings.
  const items = [...new Set(pending.filter(item => typeof item === 'string' && item.trim())
    .map(item => item.replace(/\s+/g, ' ').trim().slice(0, 120)))];
  if (!items.length) return [];
  const buckets = Array.from({ length: Math.min(3, Math.max(2, items.length)) }, () => []);
  for (let i = 0; i < items.length; i++) {
    const bucket = buckets[i % buckets.length];
    if ([...bucket, items[i]].join(' ').length <= 190) bucket.push(items[i]);
  }
  if (items.length === 1) buckets[1].push(items[0]);
  return buckets.map((bucket, index) => `${bucket.join(' ')} ${index === 1 ? '官网' : '官方原文'}`.trim()).filter(query => query.length > 3 && query.length <= 200);
}

function citableResult(result) {
  try {
    const url = new URL(result.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export async function collectEvidence(search, queries, logger = null) {
  const results = [];
  const seen = new Set();
  for (const query of queries) {
    try {
      for (const result of await search.search(query)) {
        if (seen.has(result.url)) continue;
        seen.add(result.url);
        results.push(result);
      }
    } catch (error) {
      logger?.log('search_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  logger?.log('websearch_done', { queries: queries.length, results: results.length,
    citable_snippets: results.filter(result => citableResult(result) && result.snippet).length });
  return results;
}

// 来源是否权威由核查模型依技能判断；程序只接受本次 HTTPS 检索中有逐字引文的摘要，不以 .gov.cn 后缀代替判断。
export function applyVerdicts(items, verdicts, sources, locateIssue = () => { throw new Error('invalid_anchor'); }) {
  const verified = [];
  const issues = [];
  const resolved = new Set();
  for (const verdict of verdicts) {
    if (!verdict || !['correct', 'incorrect', 'verified'].includes(verdict.status) || !items.includes(verdict.item) || resolved.has(verdict.item)) continue;
    // Contradictory duplicate judgments are not evidence of either correctness or error.
    if (verdicts.some(other => other?.item === verdict.item && other.status !== verdict.status)) continue;
    if (typeof verdict.note !== 'string' || !verdict.note.trim()) continue;
    const evidence = (Array.isArray(verdict.evidence) ? verdict.evidence : [])
      .flatMap(e => {
        const source = sources.find(source => source.url === e?.url && citableResult(source));
        if (!source || typeof e.excerpt !== 'string' || e.excerpt.trim().length < 4) return [];
        if (typeof source.snippet !== 'string' || !source.snippet.includes(e.excerpt.trim())) return [];
        return [{ title: source.title.slice(0, 200), url: source.url, excerpt: e.excerpt.trim().slice(0, 500) }];
      });
    if (!evidence.length) continue;
    if (verdict.status === 'incorrect') {
      const issue = verdict.issue;
      if (!issue || typeof issue.reason !== 'string' || !issue.reason.trim() || typeof issue.suggestion !== 'string' || !issue.suggestion.trim()) continue;
      let anchor;
      try { anchor = locateIssue(issue); } catch { continue; }
      issues.push({ ...issue, category: 'accuracy', evidence, anchor });
    } else {
      verified.push({ text: verdict.item, note: verdict.note.trim().slice(0, 300), evidence });
    }
    resolved.add(verdict.item);
  }
  return { verified, issues, remaining: items.filter(item => !resolved.has(item)) };
}
