import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

// History retention: each user keeps only the newest tasks; older ones are pruned on submit.
export const HISTORY_LIMIT = 10;

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  let lastCreated = 0;
  // Strictly increasing timestamps keep retention ordering deterministic even for same-millisecond inserts.
  const createdAt = () => { const now = Date.now(); lastCreated = now > lastCreated ? now : lastCreated + 1; return new Date(lastCreated).toISOString(); };
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, version_id TEXT NOT NULL,
      rule_version TEXT NOT NULL, model TEXT NOT NULL,
      title TEXT NOT NULL, draft_date TEXT NOT NULL, publication_date TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, stages TEXT NOT NULL DEFAULT '[]',
      issues TEXT NOT NULL DEFAULT '[]', unverified TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS tasks_user_date ON tasks (user_id, created_at);`);
  // 旧库增量迁移：只添加列，不重写或删除已有稿件与结果。
  const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  if (!columns.has('verified')) db.exec("ALTER TABLE tasks ADD COLUMN verified TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('sources')) db.exec("ALTER TABLE tasks ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('result_text')) db.exec("ALTER TABLE tasks ADD COLUMN result_text TEXT NOT NULL DEFAULT ''");
  if (!columns.has('result_format')) db.exec("ALTER TABLE tasks ADD COLUMN result_format TEXT NOT NULL DEFAULT ''");
  if (!columns.has('display_marks')) db.exec('ALTER TABLE tasks ADD COLUMN display_marks TEXT');
  if (!columns.has('location_status')) db.exec("ALTER TABLE tasks ADD COLUMN location_status TEXT NOT NULL DEFAULT ''");
  if (!columns.has('usage')) db.exec("ALTER TABLE tasks ADD COLUMN usage TEXT NOT NULL DEFAULT '{}' ");
  if (!columns.has('thinking_level')) db.exec("ALTER TABLE tasks ADD COLUMN thinking_level TEXT NOT NULL DEFAULT ''");
  if (!columns.has('started_at')) db.exec('ALTER TABLE tasks ADD COLUMN started_at TEXT');
  if (!columns.has('finished_at')) db.exec('ALTER TABLE tasks ADD COLUMN finished_at TEXT');
  // 旧任务不推测开始时间；服务重启终止执行中的任务，保留已有起止时间。
  const restartedAt = new Date().toISOString();
  db.prepare("UPDATE tasks SET status = 'failed', note = '服务重启，任务未完成；请人工确认是否重新提交。', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE status = 'running'").run(restartedAt, restartedAt);
  const select = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?');
  function detail(id, userId) {
    const row = select.get(id, userId);
    return row && { id: row.id, title: row.title,
      version_id: row.version_id, rule_version: row.rule_version, model: row.model,
      created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at, finished_at: row.finished_at,
      content: row.content, status: row.status, result_text: row.result_text, result_format: row.result_format,
      display_marks: row.display_marks === null ? null : JSON.parse(row.display_marks), location_status: row.location_status,
      usage: JSON.parse(row.usage || '{}'),
      thinking_level: row.thinking_level ?? '',
      stages: JSON.parse(row.stages), issues: JSON.parse(row.issues), unverified: JSON.parse(row.unverified), verified: JSON.parse(row.verified ?? '[]'), sources: JSON.parse(row.sources ?? '[]'), note: row.note };
  }
  return {
    db,
    detail,
    list(userId) { return db.prepare('SELECT id, title, status, updated_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId); },
    queued() { return db.prepare("SELECT id, user_id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC").all(); },
    create(userId, key, input, ruleVersion = '', model = '') {
      const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT id, request_hash, model FROM tasks WHERE user_id = ? AND idempotency_key = ?').get(userId, key);
        if (existing) {
          if (existing.request_hash !== requestHash || existing.model !== model) throw new Error('idempotency_conflict');
          db.exec('COMMIT');
          return { id: existing.id, existing: true };
        }
        const id = randomUUID();
        const now = createdAt();
        db.prepare('INSERT INTO tasks (id, user_id, idempotency_key, request_hash, version_id, rule_version, model, title, draft_date, publication_date, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, userId, key, requestHash, randomUUID(), ruleVersion, model, input.title, input.draft_date ?? '', input.publication_date ?? '', input.content, 'queued', now, now);
        // Prune this user's oldest finished tasks beyond the retention window, oldest first.
        // Queued/running tasks are never deleted, and only the submitting user's rows are touched.
        const pruned = db.prepare(`SELECT id FROM tasks WHERE user_id = ? AND status NOT IN ('queued','running')
          AND id NOT IN (SELECT id FROM tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`).all(userId, userId, HISTORY_LIMIT).map(row => row.id);
        for (const pruneId of pruned) db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(pruneId, userId);
        db.exec('COMMIT');
        return { id, existing: false, pruned };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    update(id, fields) {
      const allowed = ['status', 'stages', 'issues', 'unverified', 'note', 'title', 'verified', 'sources', 'result_text', 'result_format', 'display_marks', 'location_status', 'usage', 'thinking_level'];
      const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
      if (!entries.length) return;
      const now = new Date().toISOString();
      // 只在真实状态转换时记录，阶段更新/结果读取不改变校对起止时间。
      const previous = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)?.status;
      if (fields.status === 'running' && previous === 'queued') entries.push(['started_at', now]);
      if (['completed', 'partial', 'failed', 'cancelled'].includes(fields.status) && ['queued', 'running'].includes(previous)) entries.push(['finished_at', now]);
      const jsonFields = new Set(['stages', 'issues', 'unverified', 'verified', 'sources', 'usage', 'display_marks']);
      const values = entries.map(([key, value]) => jsonFields.has(key) ? JSON.stringify(value) : value);
      db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now, id);
    },
    close() { db.close(); },
  };
}
