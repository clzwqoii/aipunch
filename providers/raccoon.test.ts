import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raccoon } from './raccoon.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'raccoon', name: 'main', token: '', refreshToken: 'rt-1' };

function ctxWith(fetchImpl: typeof fetch, now = new Date()): RunContext {
  return { now, fetch: fetchImpl };
}

function mockRaccoon(handlers: {
  refresh?: () => Response;
  settingInfo?: () => Response;
  bills?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/auth/v1/refresh')) return handlers.refresh!();
    if (u.includes('/office/v3/setting_info')) return handlers.settingInfo!();
    if (u.includes('/points/v1/bills')) return handlers.bills!();
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const REFRESH_OK = () =>
  new Response(JSON.stringify({ code: 0, data: { access_token: 'at-fresh' } }), { status: 200 });

const TODAY = new Date().toISOString().slice(0, 10);

test('全流程：先刷新，再触发 setting_info（带桌面客户端头），最后 bills 核对到账', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ctx = ctxWith(
    mockRaccoon({
      refresh: REFRESH_OK,
      settingInfo: () => new Response(JSON.stringify({ code: 0, data: { point_grant_toast: '每日积分已发放' } }), { status: 200 }),
      bills: () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                { points: 300, created_at: `${TODAY}T08:00:00`, event_name: '每日积分' },
                { points: 500, created_at: '2026-10-18T08:00:00', event_name: '昨日积分' },
              ],
            },
          }),
          { status: 200 },
        ),
      onCall: (url, init) => calls.push({ url, init }),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /300/);

  const refreshCall = calls.find((c) => c.url.includes('/auth/v1/refresh'));
  assert.ok(refreshCall, '应先刷新');
  assert.deepEqual(JSON.parse(String(refreshCall!.init?.body)), { refresh_token: 'rt-1' });

  const triggerCall = calls.find((c) => c.url.includes('/office/v3/setting_info'));
  assert.ok(triggerCall, '应触发 setting_info');
  const headers = triggerCall!.init?.headers as Record<string, string>;
  assert.equal(headers['X-Client-Platform'], 'desktop-windows');
  assert.equal(headers['X-Client-Version'], 'v1.0.0');
  assert.equal(headers['X-Raccoon-Language'], 'zh');
  assert.equal(headers.Authorization, 'Bearer at-fresh');
});

test('bills 今日无入账判定失败（触发未生效，不谎报成功）', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      refresh: REFRESH_OK,
      settingInfo: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
      bills: () =>
        new Response(
          JSON.stringify({ code: 0, data: { items: [{ points: 300, created_at: '2026-10-18T08:00:00', event_name: '每日积分' }] } }),
          { status: 200 },
        ),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /无积分入账|未生效/);
});

test('bills 核对接口失败判定失败', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      refresh: REFRESH_OK,
      settingInfo: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
      bills: () => new Response('gateway error', { status: 502 }),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /核对/);
});

test('刷新失败时不触发 setting_info，判定失败', async () => {
  let triggerCalled = false;
  const ctx = ctxWith(
    mockRaccoon({
      refresh: () => new Response(JSON.stringify({ code: 401, message: 'invalid refresh token' }), { status: 200 }),
      settingInfo: () => {
        triggerCalled = true;
        return new Response('{}', { status: 200 });
      },
      bills: () => new Response('{}', { status: 200 }),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.equal(triggerCalled, false);
  assert.match(result.message, /刷新失败/);
});

test('已有 token 且无 refreshToken 时直接触发，不刷新', async () => {
  let refreshCalled = false;
  const ctx = ctxWith(
    mockRaccoon({
      refresh: () => {
        refreshCalled = true;
        return REFRESH_OK();
      },
      settingInfo: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
      bills: () =>
        new Response(JSON.stringify({ code: 0, data: { items: [{ points: 300, created_at: `${TODAY}T00:30:00` }] } }), { status: 200 }),
    }),
  );
  const result = await raccoon.checkin({ ...account, token: 'at-direct', refreshToken: undefined }, ctx);
  assert.equal(result.ok, true);
  assert.equal(refreshCalled, false);
});

test('缺少凭证判定失败且不发起请求', async () => {
  let called = false;
  const ctx = ctxWith((async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const result = await raccoon.checkin({ provider: 'raccoon', name: 'main', token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('刷新返回新 refresh_token 时透出轮换值', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      refresh: () => new Response(JSON.stringify({ code: 0, data: { access_token: 'at-fresh', refresh_token: 'rt-2' } }), { status: 200 }),
      settingInfo: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
      bills: () =>
        new Response(JSON.stringify({ code: 0, data: { items: [{ points: 300, created_at: `${TODAY}T00:30:00` }] } }), { status: 200 }),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.rotatedRefreshToken, 'rt-2');
});
