import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedBindHost } from '../src/bind-host.js';

test('loopback is always allowed and remains the default posture', () => {
  assert.equal(isAllowedBindHost('127.0.0.1'), true);
  assert.equal(isAllowedBindHost('::1'), true);
});

test('wildcard and RFC1918 private addresses are allowed for container deployments', () => {
  for (const host of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.10', '172.18.0.7', '172.31.255.1']) {
    assert.equal(isAllowedBindHost(host), true);
  }
});

test('public addresses, names and malformed values are rejected', () => {
  for (const host of ['119.28.143.201', '172.32.0.1', '172.1.0.1', 'example.com', '', undefined, null, 8788]) {
    assert.equal(isAllowedBindHost(host), false);
  }
});
