import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Inspect only the Wrangler-local D1 schema; do not read users or sessions. */
export async function hasLocalAuthSchema(persistTo, { proofreadingPermission = false } = {}) {
  const directory = join(persistTo, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  let files;
  try { files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (files.length !== 1) return false;
  const db = new DatabaseSync(join(directory, files[0]), { readOnly: true });
  try {
    const tables = new Set(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)').all('table', 'users', 'sessions').map(row => row.name));
    if (!tables.has('users') || !tables.has('sessions')) return false;
    return !proofreadingPermission || db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'proofreading_enabled');
  } finally { db.close(); }
}
