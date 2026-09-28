import { createHmac, timingSafeEqual } from 'node:crypto';

const base64url = (value) => Buffer.from(value).toString('base64url');
export function signTestToken(userId, secret, now = Date.now()) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: String(userId), aud: 'proofreading-service', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60 }));
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

export function verifyWorkerToken(value, secret, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('Bearer ')) return null;
  const parts = value.slice(7).split('.');
  if (parts.length !== 3 || parts.some(p => !/^[a-zA-Z0-9_-]+$/.test(p))) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (h.alg !== 'HS256' || h.typ !== 'JWT' || p.aud !== 'proofreading-service') return null;
    if (!/^[1-9]\d{0,15}$/.test(p.sub) || !Number.isSafeInteger(Number(p.sub))) return null;
    if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.iat > seconds + 5 || p.iat < seconds - 90 || p.exp <= seconds || p.exp - p.iat !== 60) return null;
    return Number(p.sub);
  } catch { return null; }
}
