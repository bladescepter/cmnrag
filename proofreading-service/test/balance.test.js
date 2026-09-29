import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalanceProvider } from '../src/balance.js';

const okBody = JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.00', granted_balance: '8.00', topped_up_balance: '80.00' }] });

test('balance provider caches success and failure for the ttl window', async () => {
  let clock = 0;
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => JSON.parse(okBody) }; };
  const provider = createBalanceProvider({ apiKey: 'sk-test', ttlMs: 1000, fetchImpl, now: () => clock });
  const first = await provider.get();
  assert.deepEqual(first, { total: '88.00', currency: 'CNY', is_available: true });
  await provider.get();
  assert.equal(calls, 1); // 缓存期内不重复请求
  clock = 1001;
  await provider.get();
  assert.equal(calls, 2);
});

test('balance provider never throws: http errors and bad shapes cache null', async () => {
  let clock = 0;
  let mode = 'http_error';
  const fetchImpl = async () => {
    if (mode === 'http_error') return { ok: false, status: 429 };
    if (mode === 'bad_shape') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => JSON.parse(okBody) };
  };
  const provider = createBalanceProvider({ apiKey: 'sk-test', ttlMs: 1000, fetchImpl, now: () => clock });
  assert.equal(await provider.get(), null);
  clock = 1001; mode = 'bad_shape';
  assert.equal(await provider.get(), null);
  clock = 2002; mode = 'ok';
  assert.equal((await provider.get()).total, '88.00'); // 恢复后自动回到正常
  assert.equal(createBalanceProvider({ apiKey: '' }), null); // 无密钥时禁用
});
