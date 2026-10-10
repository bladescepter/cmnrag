import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasLocalAuthSchema } from '../src/local-auth-schema.js';

test('only skips local D1 initialization when both auth tables exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofreading-local-schema-'));
  try {
    assert.equal(await hasLocalAuthSchema(dir), false);
    const d1 = join(dir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
    mkdirSync(d1, { recursive: true });
    const db = new DatabaseSync(join(d1, `${'a'.repeat(64)}.sqlite`));
    try {
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
      assert.equal(await hasLocalAuthSchema(dir), false);
      db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY)');
      assert.equal(await hasLocalAuthSchema(dir), true);
      db.exec('INSERT INTO users (id) VALUES (1)');
      assert.equal(await hasLocalAuthSchema(dir, { proofreadingPermission: true }), false);
      db.exec(readFileSync(new URL('../../cmnrag-website/migrations/0005_proofreading_access.sql', import.meta.url), 'utf8'));
      assert.equal(await hasLocalAuthSchema(dir, { proofreadingPermission: true }), true);
      assert.equal(db.prepare('SELECT proofreading_enabled FROM users WHERE id = 1').get().proofreading_enabled, 0);
      assert.throws(() => db.exec('UPDATE users SET proofreading_enabled = 2'), /CHECK constraint/);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
