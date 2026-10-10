import { describe, expect, it } from 'vitest';
import { requestJson } from '../public/proofreading/request.js';

describe('read-only connection recovery', () => {
  it('recovers GET from transport, gateway, and response-body failures', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await requestJson('/tasks/id', {}, {
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('connection lost');
        if (calls === 2) return new Response('gateway unavailable', { status: 502 });
        if (calls === 3) return new Response('{truncated');
        return Response.json({ status: 'completed' });
      }, sleep: async (ms: number) => { waits.push(ms); },
    });
    expect(result.status).toBe('completed');
    expect(calls).toBe(4);
    expect(waits).toEqual([500, 1200, 2500]);
  });
  it.each(['transport', 'body', 'gateway'])('never repeats a POST after %s failure', async failure => {
    let calls = 0;
    await expect(requestJson('/tasks', { method: 'POST' }, {
      fetchImpl: async () => {
        calls++;
        if (failure === 'transport') throw new Error('disconnected');
        return new Response(failure === 'body' ? '{truncated' : '{}', { status: failure === 'gateway' ? 503 : 200 });
      }, sleep: async () => { throw new Error('must not retry'); },
    })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('explains missing proofreading access without retrying or submitting a model task', async () => {
    let calls = 0;
    await expect(requestJson('/availability', {}, {
      fetchImpl: async () => { calls++; return Response.json({ error: 'proofreading_forbidden' }, { status: 403 }); },
      sleep: async () => { throw new Error('must not retry'); },
    })).rejects.toThrow('此账户尚未开通测试校对权限');
    expect(calls).toBe(1);
  });
  it('does not retry authentication errors or leak task identifiers on repeated failures', async () => {
    let calls = 0;
    const deps = { fetchImpl: async () => { calls++; return Response.json({}, { status: 401 }); }, sleep: async () => {} };
    await expect(requestJson('/tasks/private-id', {}, deps)).rejects.toThrow('请先登录');
    expect(calls).toBe(1);
    calls = 0;
    deps.fetchImpl = async () => { calls++; throw new Error('private-id'); };
    await expect(requestJson('/tasks/private-id', {}, deps)).rejects.not.toThrow('private-id');
    expect(calls).toBe(4);
  });
});
