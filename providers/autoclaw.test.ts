import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoclaw } from './autoclaw.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'autoclaw', name: 'main', token: 'at-1' };

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

function mockAutoClaw(handlers: {
  checkin?: () => Response;
  refresh?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/userapi/v1/refresh') || u.includes('/userapi/v1/agent-refresh')) return handlers.refresh!();
    if (u.includes('/autoclaw-task-complete')) return handlers.checkin!();
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const CHECKIN_OK = (reward = 100) =>
  new Response(JSON.stringify({ code: 0, data: { success: true, reward_points: reward, task_id: 'daily_signin' } }), { status: 200 });

test('签到成功（reward_points>0）：请求命中 task-complete 且带签名头', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => CHECKIN_OK(),
      onCall: (url, init) => calls.push({ url, init }),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /100/);
  const call = calls.find((c) => c.url.includes('/autoclaw-task-complete'));
  assert.ok(call, '应 POST task-complete');
  assert.deepEqual(JSON.parse(String(call!.init?.body)), { task_id: 'daily_signin' });
  const headers = call!.init?.headers as Record<string, string>;
  assert.equal(headers['X-Auth-Appid'], '100003');
  assert.equal(headers.Authorization, 'Bearer at-1');
  assert.match(headers['X-Auth-Sign'], /^[0-9a-f]{32}$/);
  assert.ok(headers['X-Auth-TimeStamp'], '应带秒级时间戳');
});

test('今日已签（already_completed，success=false，reward_points=0）判定成功', async () => {
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () =>
        new Response(JSON.stringify({ code: 0, data: { success: false, already_completed: true, reward_points: 0 } }), { status: 200 }),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /已签|已领取/);
});

test('code=410000（登录态过期）判定失败', async () => {
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => new Response(JSON.stringify({ code: 410000, msg: 'token expired' }), { status: 200 }),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /过期|登录态/);
});

test('code=400002（签名校验失败）判定失败', async () => {
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => new Response(JSON.stringify({ code: 400002, msg: 'sign error' }), { status: 200 }),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /签名/);
});

test('HTTP 429 判定失败（限流）', async () => {
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => new Response(JSON.stringify({ code: 429, msg: 'too many requests' }), { status: 429 }),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /限流|429/);
});

test('有 refreshToken 时先刷新再用新 token 签到，轮换值透出', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ctx = ctxWith(
    mockAutoClaw({
      refresh: () => new Response(JSON.stringify({ code: 0, data: { access_token: 'at-fresh', refresh_token: 'rt-2' } }), { status: 200 }),
      checkin: () => CHECKIN_OK(),
      onCall: (url, init) => calls.push({ url, init }),
    }),
  );
  const result = await autoclaw.checkin({ ...account, refreshToken: 'rt-1' }, ctx);
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /\/userapi\/v1\/refresh/);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { refresh_token: 'rt-1', source_id: 'autoclaw' });
  const checkinCall = calls.find((c) => c.url.includes('/autoclaw-task-complete'));
  assert.equal((checkinCall!.init?.headers as Record<string, string>).Authorization, 'Bearer at-fresh');
  assert.equal(result.rotatedRefreshToken, 'rt-2');
});

test('刷新遇 400002 时降级 agent-refresh 重试', async () => {
  const calls: string[] = [];
  let refreshCount = 0;
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/userapi/v1/refresh') || u.includes('/userapi/v1/agent-refresh')) {
      refreshCount += 1;
      if (refreshCount === 1) return new Response(JSON.stringify({ code: 400002 }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: { access_token: 'at-fresh' } }), { status: 200 });
    }
    return CHECKIN_OK();
  }) as typeof fetch);
  const result = await autoclaw.checkin({ ...account, refreshToken: 'rt-1' }, ctx);
  assert.equal(result.ok, true);
  assert.ok(calls.some((u) => u.includes('/userapi/v1/refresh')));
  assert.ok(calls.some((u) => u.includes('/userapi/v1/agent-refresh')));
});

test('缺少凭证判定失败且不发起请求', async () => {
  let called = false;
  const ctx = ctxWith((async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const result = await autoclaw.checkin({ provider: 'autoclaw', name: 'main', token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});
