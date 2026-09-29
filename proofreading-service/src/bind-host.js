// 监听地址白名单：默认只允许本机回环（开发与单机形态）。
// 生产容器形态允许显式配置通配或 RFC1918 私网地址——前提是容器端口不发布到宿主公网，
// 仅 Docker 内网（如 hermes-net）可达，公网流量一律经 Caddy TLS 反代进入。
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const WILDCARD = new Set(['0.0.0.0', '::']);
const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isAllowedBindHost(host) {
  if (typeof host !== 'string' || !host.trim()) return false;
  return LOOPBACK.has(host) || WILDCARD.has(host) || PRIVATE.some(pattern => pattern.test(host));
}
