import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../src/single-draft.js', import.meta.url);

test('dry-run with synthetic text requires no real key and does not call provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofreading-cli-test-'));
  try {
    const draft = join(dir, 'test.md');
    writeFileSync(draft, '去敏的虚构测试句子。', { mode: 0o600 });
    const run = spawnSync(process.execPath, [cli.pathname, draft], {
      encoding: 'utf8', env: { ...process.env, PROOFREADING_MODELS: '', PROOFREADING_MODEL_PROVIDER: 'xiaomi', PROOFREADING_MODEL_ID: 'mimo-v2.6-flash', PROOFREADING_MODEL_API_KEY: 'sk-synthetic-test-only' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /没有调用模型/);
    assert.doesNotMatch(run.stdout + run.stderr, /sk-synthetic-test-only/);
    const wrongType = spawnSync(process.execPath, [cli.pathname, draft], {
      encoding: 'utf8', env: { ...process.env, PROOFREADING_MODELS: '', PROOFREADING_MODEL_PROVIDER: 'xiaomi', PROOFREADING_MODEL_ID: 'mimo-v2.6-flash', PROOFREADING_MODEL_API_KEY: 'tp-synthetic-test-only' },
    });
    assert.notEqual(wrongType.status, 0);
    assert.match(wrongType.stderr, /不匹配/);
    const multiple = spawnSync(process.execPath, [cli.pathname, draft], {
      encoding: 'utf8', env: { ...process.env, PROOFREADING_MODELS: 'xiaomi/mimo-v2.6-flash,deepseek/deepseek-flash', PROOFREADING_API_KEY_XIAOMI: 'sk-synthetic-multi-test-only', PROOFREADING_MODEL_PROVIDER: '', PROOFREADING_MODEL_ID: '', PROOFREADING_MODEL_API_KEY: '' },
    });
    assert.equal(multiple.status, 0, multiple.stderr);
    assert.match(multiple.stdout, /没有调用模型/);
    assert.doesNotMatch(multiple.stdout + multiple.stderr, /sk-synthetic-multi-test-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
