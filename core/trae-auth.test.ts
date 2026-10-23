import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRAE_CLIENT_ID, buildTraeAuthUrl, newTraeDevice, parseTraeCallback } from './trae-auth.ts';

test('newTraeDevice 生成 16 位设备号与 32 位机器号', () => {
  const d = newTraeDevice();
  assert.match(d.deviceId, /^\d{16}$/);
  assert.match(d.machineId, /^[0-9a-f]{32}$/);
});

test('buildTraeAuthUrl 带上 IDE 授权页所需参数与设备号', () => {
  const d = newTraeDevice();
  const callback = 'http://127.0.0.1:4567/authorize';
  const url = new URL(buildTraeAuthUrl(d, callback));
  assert.equal(url.origin + url.pathname, 'https://www.trae.cn/authorization');
  assert.equal(url.searchParams.get('client_id'), TRAE_CLIENT_ID);
  assert.equal(url.searchParams.get('auth_callback_url'), callback);
  assert.equal(url.searchParams.get('auth_type'), 'local');
  assert.equal(url.searchParams.get('device_id'), d.deviceId);
  assert.equal(url.searchParams.get('x_device_id'), d.deviceId);
  assert.equal(url.searchParams.get('machine_id'), d.machineId);
  assert.ok(url.searchParams.get('login_trace_id'));
});

test('parseTraeCallback 解析 userJwt/userInfo', () => {
  const q = new URLSearchParams({
    userJwt: JSON.stringify({ Token: 'jwt-1', RefreshToken: 'rt-1' }),
    userInfo: JSON.stringify({ UserID: 123, ScreenName: 'alice' }),
  });
  assert.deepEqual(parseTraeCallback(q), {
    token: 'jwt-1',
    refreshToken: 'rt-1',
    userId: '123',
    screenName: 'alice',
  });
});

test('parseTraeCallback 兼容只回 refreshToken 的页面', () => {
  const q = new URLSearchParams({ refreshToken: 'rt-2' });
  const parsed = parseTraeCallback(q);
  assert.equal(parsed.token, '');
  assert.equal(parsed.refreshToken, 'rt-2');
});

test('parseTraeCallback 无凭证或 error 时抛错', () => {
  assert.throws(() => parseTraeCallback(new URLSearchParams({})), /未返回 token/);
  assert.throws(
    () => parseTraeCallback(new URLSearchParams({ error: 'access_denied', error_description: '用户取消' })),
    /用户取消/,
  );
});
