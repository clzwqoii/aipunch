import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raccoon } from './raccoon.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = {
  provider: 'raccoon',
  name: 'main',
  token: 'at-1',
  refreshToken: 'rt-1',
};

function ctxWith(fetchImpl: typeof fetch, now = new Date('2026-10-24T18:00:00+08:00')): RunContext {
  return { now, fetch: fetchImpl };
}

function mockRaccoon(handlers: {
  refresh?: () => Response;
  settingInfo?: (headers: Record<string, string>) => Response;
  bills?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/auth/v1/refresh')) return handlers.refresh!();
    if (u.includes('/office/v3/setting_info')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return handlers.settingInfo!(headers);
    }
    if (u.includes('/points/v1/bills')) return handlers.bills!();
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const REFRESH_OK = () =>
  new Response(JSON.stringify({ code: 0, data: { access_token: 'at-fresh' } }), { status: 200 });

const SETTING_OK = () =>
  new Response(JSON.stringify({ code: 0, message: 'success', data: { point_grant_toast: '每日积分已发放' } }), { status: 200 });

// 真实账单条目形状（2026-10-24 实测）：biz_type=daily_grant 带 grant_at/expire_at；
// 消耗/清零条目没有这两个字段，也非 daily_grant。
function billsPage(items: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ code: 0, data: { items } }), { status: 200 });
}

const consumption = {
  bill_id: 2,
  biz_type: 'desktop',
  event_name: '桌面端 LLM 对话消耗',
  client_type: 'desktop',
  points: -2,
  created_at: '2026-10-24T16:55:04+08:00',
};

const grantExtended = {
  bill_id: 1,
  biz_type: 'daily_grant',
  event_name: '每日积分发放',
  client_type: 'web',
  points: 300,
  created_at: '2026-10-24T16:55:13+08:00',
  grant_at: '2026-10-24T00:00:00+08:00',
  expire_at: '2026-10-30T23:59:59+08:00',
};

// 未登录日档位：当日 00:00 发放、当日 23:59:59 清零（差 86399 秒）
const grantSameDay = {
  ...grantExtended,
  created_at: '2026-10-24T00:00:00+08:00',
  expire_at: '2026-10-24T23:59:59+08:00',
};

test('全流程：token 直用不刷新 → setting_info 带桌面客户端头 → 最新 daily_grant 延效 7 天判成功', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let refreshCalled = false;
  const ctx = ctxWith(
    mockRaccoon({
      refresh: () => {
        refreshCalled = true;
        return REFRESH_OK();
      },
      settingInfo: () => SETTING_OK(),
      bills: () => billsPage([consumption, grantExtended, { ...grantSameDay, grant_at: '2026-10-23T00:00:00+08:00', expire_at: '2026-10-23T23:59:59+08:00' }]),
      onCall: (url, init) => calls.push({ url, init }),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.equal(refreshCalled, false, '有可用 token 时不应刷新（与客户端共享会话，能不刷新就不刷新）');
  assert.match(result.message, /延长/);
  assert.match(result.message, /10-30/);

  const triggerCall = calls.find((c) => c.url.includes('/office/v3/setting_info'));
  assert.ok(triggerCall, '应触发 setting_info');
  const headers = triggerCall!.init?.headers as Record<string, string>;
  assert.equal(headers['X-Client-Platform'], 'desktop-windows');
  assert.equal(headers['X-Client-Version'], 'v1.0.0');
  assert.equal(headers['X-Raccoon-Language'], 'zh');
  assert.equal(headers.Authorization, 'Bearer at-1');
});

test('setting_info 401 时刷新重试，轮换 refresh_token 透出', async () => {
  let settingCalls = 0;
  const ctx = ctxWith(
    mockRaccoon({
      refresh: () =>
        new Response(JSON.stringify({ code: 0, data: { access_token: 'at-fresh', refresh_token: 'rt-2' } }), { status: 200 }),
      settingInfo: (headers) => {
        settingCalls += 1;
        return settingCalls === 1
          ? new Response('{"code":401,"message":"unauthorized"}', { status: 401 })
          : SETTING_OK();
      },
      bills: () => billsPage([grantExtended]),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.equal(settingCalls, 2, '401 后应带新 token 重试一次');
  assert.equal(result.rotatedRefreshToken, 'rt-2');
});

test('最新发放是当日清零档（未登录）判失败：有效期未延长', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      settingInfo: () => SETTING_OK(),
      bills: () => billsPage([grantSameDay]),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /有效期未延长/);
});

test('账单中无 daily_grant 记录判失败', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      settingInfo: () => SETTING_OK(),
      bills: () => billsPage([consumption]),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /daily_grant|每日发放/);
});

test('最新发放是「昨天的延效记录」判失败：今日未发放，不拿昨天的延效谎报今天', async () => {
  // 真实形态：10-25 延效到 10-31；10-26 11:00 若服务端还没建当日行，最新记录仍是昨天这条
  const yesterdayExtended = {
    ...grantExtended,
    created_at: '2026-10-25T11:25:31+08:00',
    grant_at: '2026-10-25T00:00:00+08:00',
    expire_at: '2026-10-31T23:59:59+08:00',
  };
  const ctx = ctxWith(
    mockRaccoon({ settingInfo: () => SETTING_OK(), bills: () => billsPage([yesterdayExtended]) }),
    new Date('2026-10-26T11:00:00+08:00'),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /今日未发放|不是今天/);
});

test('「今天」按北京时间判定：UTC 日期落后一天时当日记录仍算今天', async () => {
  // CF worker 跑在 UTC：11:00 北京 = 03:00 UTC，UTC 日期同样是 10-26，用 03:30Z 构造跨日风险
  const todayGrant = {
    ...grantExtended,
    created_at: '2026-10-26T09:00:00+08:00',
    grant_at: '2026-10-26T00:00:00+08:00',
    expire_at: '2026-11-01T23:59:59+08:00',
  };
  const ctx = ctxWith(
    mockRaccoon({ settingInfo: () => SETTING_OK(), bills: () => billsPage([todayGrant]) }),
    new Date('2026-10-26T03:30:00Z'),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, true);
});

test('setting_info 返回 code!=0 判失败', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      settingInfo: () => new Response(JSON.stringify({ code: 500, message: 'boom' }), { status: 200 }),
      bills: () => billsPage([grantExtended]),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /boom|500/);
});

test('只有 refreshToken 无 token 时先刷新再触发（不发注定 401 的请求）', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ctx = ctxWith(
    mockRaccoon({
      refresh: REFRESH_OK,
      settingInfo: (headers) => {
        assert.equal(headers.Authorization, 'Bearer at-fresh');
        return SETTING_OK();
      },
      bills: () => billsPage([grantExtended]),
      onCall: (url, init) => calls.push({ url, init }),
    }),
  );
  const result = await raccoon.checkin({ ...account, token: '' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url.includes('/auth/v1/refresh'), true, '第一个请求应是刷新');
});

test('刷新失败时不触发 setting_info，判定失败', async () => {
  let triggerCalled = false;
  const ctx = ctxWith(
    mockRaccoon({
      refresh: () => new Response(JSON.stringify({ code: 401, message: 'invalid refresh token' }), { status: 401 }),
      settingInfo: () => {
        triggerCalled = true;
        return SETTING_OK();
      },
      bills: () => billsPage([grantExtended]),
    }),
  );
  const result = await raccoon.checkin({ ...account, token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(triggerCalled, false);
  assert.match(result.message, /刷新失败/);
});

test('bills 核对接口失败判定失败', async () => {
  const ctx = ctxWith(
    mockRaccoon({
      settingInfo: () => SETTING_OK(),
      bills: () => new Response('gateway error', { status: 502 }),
    }),
  );
  const result = await raccoon.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /核对/);
});

test('缺少凭证判定失败且不发起请求', async () => {
  let called = false;
  const ctx = ctxWith(
    (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  );
  const result = await raccoon.checkin({ provider: 'raccoon', name: 'main', token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});
