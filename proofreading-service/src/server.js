import http from 'node:http';
import { verifyWorkerToken } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const categories = new Set(['political', 'grammar', 'policy', 'accuracy']);
function httpsEvidence(list) {
  return (Array.isArray(list) ? list : []).slice(0, 3).flatMap(e => {
    try { const url = new URL(e.url); return url.protocol === 'https:' && typeof e.title === 'string' ? [{ title: e.title.slice(0, 200), url: url.href, ...(typeof e.excerpt === 'string' ? { excerpt: e.excerpt.slice(0, 500) } : {}) }] : []; } catch { return []; }
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
// 标题取首行：短且不以句号结尾视为标题；否则截取开头并加省略号，待第一遍模型返回提炼式标题后替换。
export function extractTitle(content) {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
  const first = (lines[0] || '').replace(/^#+\s*/, '');
  if (!first) return '';
  if (lines.length > 1 && first.length <= 40 && !first.endsWith('。')) return first.slice(0, 120);
  return first.length > 20 ? `${first.slice(0, 20)}…` : first;
}
function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { content } = body;
  if (typeof content !== 'string' || !content.trim()) return null;
  return { title: extractTitle(content), draft_date: '', publication_date: '', content };
}
async function readJson(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) throw new Error('invalid_content_type');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200_000) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_json'); }
}
function validateIssues(task, issues) {
  if (!Array.isArray(issues) || issues.length > 100) throw new Error('invalid_results');
  const paragraphs = task.content.split('\n');
  const ids = new Set();
  const normalized = issues.map((issue) => {
    if (!issue || typeof issue !== 'object' || !categories.has(issue.category) || typeof issue.reason !== 'string' || !issue.reason.trim() || issue.reason.length > 3000 || typeof issue.quote !== 'string' || !issue.quote || typeof issue.suggestion !== 'string' || issue.suggestion.length > 2000) throw new Error('invalid_results');
    const { paragraph_id, start, end } = issue.anchor || {};
    if (typeof paragraph_id !== 'string' || !/^p\d+$/.test(paragraph_id) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error('invalid_anchor');
    const line = Number(paragraph_id.slice(1));
    if (typeof paragraphs[line] !== 'string' || start < 0 || end <= start || paragraphs[line].slice(start, end) !== issue.quote) throw new Error('invalid_anchor');
    const id = `${paragraph_id}-${start}-${end}`;
    if (ids.has(id)) throw new Error('duplicate_anchor');
    ids.add(id);
    const evidence = Array.isArray(issue.evidence) ? httpsEvidence(issue.evidence) : [];
    return { id, category: issue.category, reason: issue.reason, quote: issue.quote, suggestion: issue.suggestion, anchor: { version_id: task.version_id, paragraph_id, start, end }, evidence };
  });
  normalized.sort((a, b) => Number(a.anchor.paragraph_id.slice(1)) - Number(b.anchor.paragraph_id.slice(1)) || a.anchor.start - b.anchor.start);
  return normalized;
}
function validateSources(sources) {
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length > 15) throw new Error('invalid_results');
  return sources.flatMap(source => {
    if (!source || typeof source.url !== 'string' || source.url.length > 2048) return [];
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:') return [];
      return [{ url: url.href, title: typeof source.title === 'string' ? source.title.slice(0, 200) : '',
        snippet: typeof source.snippet === 'string' ? source.snippet.slice(0, 500) : '' }];
    } catch { return []; }
  });
}
function validateVerified(verified) {
  if (!Array.isArray(verified)) throw new Error('invalid_results');
  return verified.map(item => {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500) throw new Error('invalid_results');
    const evidence = httpsEvidence(item.evidence).filter(e => typeof e.excerpt === 'string' && e.excerpt.trim().length >= 4);
    if (!evidence.length) throw new Error('invalid_results');
    return { text: item.text.trim(), note: typeof item.note === 'string' ? item.note.slice(0, 500) : '', evidence };
  });
}

/** runner is injected so protocol, ownership and queue can be tested without model credentials. */
export function createBackend({ store, runner, signingSecret, logger = null }) {
  if (typeof signingSecret !== 'string' || signingSecret.length < 32) throw new Error('signing_secret_required');
  let running = false;
  let stopping = false;
  async function drain() {
    if (running || stopping || !runner.ready) return;
    running = true;
    try {
      while (!stopping && runner.ready) {
        const next = store.queued()[0];
        if (!next) break;
        const task = store.detail(next.id, next.user_id);
        const stages = [];
        store.update(next.id, { status: 'running' });
        logger?.log('queue_pick', { task: next.id, user: next.user_id });
        try {
          const result = await runner.run(task, (name) => {
            stages.push({ name, status: 'done' });
            store.update(task.id, { stages });
            logger?.log('stage_done', { task: task.id, stage: name });
          });
          if (result?.format === 'pi-final-text-v1') {
            if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('invalid_results');
            const status = result.incomplete ? 'partial' : 'completed';
            // Store the actual final assistant text, unchanged; no JSON/anchor/semantic postprocessor.
            store.update(task.id, { status, result_format: result.format, result_text: result.text, usage: result.usage || {},
              note: result.incomplete ? '技能执行未全部完成；保留 Pi 最终回答，不代表校对通过。' : '' });
            logger?.log('task_done', { task: task.id, status, format: result.format });
            continue;
          }
          // Legacy structured runners/results remain readable; the production runner uses final text.
          if (!result || !Array.isArray(result.issues) || !Array.isArray(result.unverified) || !Array.isArray(result.verified)) throw new Error('invalid_results');
          const issues = validateIssues(task, result.issues);
          const verified = validateVerified(result.verified);
          const sources = validateSources(result.sources);
          if (result.unverified.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error('invalid_unverified');
          const partial = result.unverified.length > 0;
          logger?.log('task_done', { task: task.id, status: partial ? 'partial' : 'completed', issues: issues.length, unverified: result.unverified.length, verified: verified.length });
          const refinedTitle = typeof result.title === 'string' ? result.title.trim() : '';
          const fields = { status: partial ? 'partial' : 'completed', issues, unverified: result.unverified, verified, sources,
            note: partial ? '部分意见需人工复核或事实核查未完成；搜索线索不等于已核实，待核实事项不可视为通过。' : '' };
          if (refinedTitle && refinedTitle.length <= 60) fields.title = refinedTitle;
          store.update(task.id, fields);
        } catch (error) {
          // Never convert a failed model, search or anchor validation into “无意见”.
          logger?.log('task_failed', { task: task.id, error: error instanceof Error ? error.message : String(error) });
          store.update(task.id, { status: 'failed', note: '校对未完成；请联系管理员核查任务记录。' });
        }
      }
    } finally { running = false; }
  }
  const kick = () => { void drain(); };
  async function handle(req, res) {
    const userId = verifyWorkerToken(req.headers.authorization, signingSecret);
    if (!userId) return json(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    if (url.search) return json(res, 404, { error: 'not_found' });
    if (path === '/api/proofreading/availability' && req.method === 'GET') return json(res, runner.ready ? 200 : 503, { ready: Boolean(runner.ready), execution: runner.execution || 'legacy', mode: runner.online ? 'online-test' : runner.offlinePartial ? 'offline-partial-test' : 'unavailable' });
    if (path === '/api/proofreading/tasks' && req.method === 'GET') return json(res, 200, { items: store.list(userId) });
    if (path === '/api/proofreading/tasks' && req.method === 'POST') {
      if (!runner.ready) return json(res, 503, { error: 'service_unavailable' });
      const key = req.headers['x-idempotency-key'];
      if (typeof key !== 'string' || !UUID.test(key)) return json(res, 400, { error: 'invalid_idempotency_key' });
      let body;
      try { body = await readJson(req); } catch (error) { return json(res, error.message === 'request_too_large' ? 413 : 400, { error: error.message }); }
      const input = validateInput(body);
      if (!input) return json(res, 400, { error: 'invalid_input' });
      if (Number.isSafeInteger(runner.maxDraftChars) && input.content.length > runner.maxDraftChars) return json(res, 413, { error: 'draft_too_long_for_test' });
      try {
        const { id, pruned } = store.create(userId, key, input, runner.ruleVersion || '', runner.model || '');
        if (pruned?.length) logger?.log('task_pruned', { user: userId, pruned: pruned.length }); // IDs only; history beyond the retention window is deleted oldest-first.
        kick();
        return json(res, 202, { id });
      } catch (error) {
        if (error.message === 'idempotency_conflict') return json(res, 409, { error: 'idempotency_conflict' });
        return json(res, 503, { error: 'database_unavailable' });
      }
    }
    const match = path.match(/^\/api\/proofreading\/tasks\/([^/]+)$/);
    if (match && req.method === 'GET' && UUID.test(match[1])) {
      const task = store.detail(match[1], userId);
      return task ? json(res, 200, task) : json(res, 404, { error: 'not_found' });
    }
    return json(res, 404, { error: 'not_found' });
  }
  const server = http.createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) json(res, 503, { error: 'service_unavailable' }); else res.destroy();
  }); });
  return { server, kick, stop() { stopping = true; server.close(); }, drain };
}
