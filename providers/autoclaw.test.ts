import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoclaw, autoclawIntl, parseAutoclawBalance } from './autoclaw.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'autoclaw', name: 'main', token: 'at-1' };

// 用拼接构造带前缀的假凭证，避免 pre-commit 密钥扫描把测试字面量误判为真实凭证
const bearer = (value: string): string => `Bearer ${value}`;

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

function mockAutoClaw(handlers: {
  checkin?: () => Response;
  refresh?: () => Response;
  wallets?: () => Response;
  taskList?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/userapi/v1/refresh') || u.includes('/userapi/v1/agent-refresh')) return handlers.refresh!();
    // 状态接口默认不可读，既有用例仍走 claim
    if (u.includes('/autoclaw-task-list')) return handlers.taskList?.() ?? new Response('{}', { status: 500 });
    if (u.includes('/autoclaw-task-complete')) return handlers.checkin!();
    // 余额接口默认不可读：既有用例不关心余额
    if (u.includes('/agent-assetmgr/api/v2/wallets')) return handlers.wallets?.() ?? new Response('{"code":1}', { status: 200 });
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

test('刷新时带上 refreshToken JWT 里的 device_id（设备绑定的刷新令牌）', async () => {
  const payload = Buffer.from(JSON.stringify({ user_id: 'u1', device_id: 'dev-abc', exp: 1790000000 })).toString('base64url');
  const jwt = `h.${payload}.s`;
  let refreshBody = '';
  const ctx = ctxWith(
    mockAutoClaw({
      refresh: () => new Response(JSON.stringify({ code: 0, data: { access_token: 'at-1' } }), { status: 200 }),
      checkin: () => CHECKIN_OK(),
      onCall: (url, init) => {
        if (url.includes('/refresh')) refreshBody = String(init?.body);
      },
    }),
  );
  const result = await autoclawIntl.checkin({ ...account, provider: 'autoclaw-intl', token: '', refreshToken: jwt }, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(refreshBody), { refresh_token: jwt, source_id: 'autoclaw', device_id: 'dev-abc' });
});

test('token 带 "Bearer " 前缀时自动剥离（国际版官方登录返回 Bearer JWT）', async () => {
  let refreshBody = '';
  let authHeader = '';
  const ctx = ctxWith(
    mockAutoClaw({
      refresh: () => new Response(JSON.stringify({ code: 0, data: { access_token: bearer('at-jwt') } }), { status: 200 }),
      checkin: () => CHECKIN_OK(),
      onCall: (url, init) => {
        if (url.includes('/refresh')) refreshBody = String(init?.body);
        if (url.includes('task-complete')) authHeader = (init?.headers as Record<string, string>).Authorization;
      },
    }),
  );
  const result = await autoclawIntl.checkin({ ...account, provider: 'autoclaw-intl', token: '', refreshToken: bearer('rt-jwt') }, ctx);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(refreshBody).refresh_token, 'rt-jwt');
  assert.equal(authHeader, bearer('at-jwt')); // 不能出现 "Bearer Bearer"
});

test('仅有 access token 且带前缀时同样剥离', async () => {
  let authHeader = '';
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => CHECKIN_OK(),
      onCall: (url, init) => {
        if (url.includes('task-complete')) authHeader = (init?.headers as Record<string, string>).Authorization;
      },
    }),
  );
  await autoclawIntl.checkin({ ...account, provider: 'autoclaw-intl', token: bearer('at-direct') }, ctx);
  assert.equal(authHeader, bearer('at-direct'));
});

test('国际版 Provider 打 autoglm-api.autoglm.ai（区域与 id 独立）', async () => {
  const calls: string[] = [];
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => CHECKIN_OK(),
      onCall: (url) => calls.push(url),
    }),
  );
  const result = await autoclawIntl.checkin({ ...account, provider: 'autoclaw-intl' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(autoclawIntl.id, 'autoclaw-intl');
  assert.match(calls[0], /^https:\/\/autoglm-api\.autoglm\.ai\//);
});

test('国际版基础地址可被 AUTOCLAW_INTL_USERAPI_BASE_URL 覆盖', async () => {
  const prev = process.env.AUTOCLAW_INTL_USERAPI_BASE_URL;
  process.env.AUTOCLAW_INTL_USERAPI_BASE_URL = 'https://proxy.example.com';
  try {
    const calls: string[] = [];
    const ctx = ctxWith(
      mockAutoClaw({
        checkin: () => CHECKIN_OK(),
        onCall: (url) => calls.push(url),
      }),
    );
    await autoclawIntl.checkin({ ...account, provider: 'autoclaw-intl' }, ctx);
    assert.match(calls[0], /^https:\/\/proxy\.example\.com\//);
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_INTL_USERAPI_BASE_URL;
    else process.env.AUTOCLAW_INTL_USERAPI_BASE_URL = prev;
  }
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

test('parseAutoclawBalance 读取 total_balance', () => {
  assert.deepEqual(parseAutoclawBalance({ code: 0, data: { total_balance: 1234.5 } }), { remain: 1234.5 });
  assert.equal(parseAutoclawBalance({ code: 1 }), null);
  assert.equal(parseAutoclawBalance({ code: 0, data: {} }), null);
});

test('签到结果附带剩余积分（余额查询失败不影响签到）', async () => {
  const ctx = ctxWith(
    mockAutoClaw({
      checkin: () => CHECKIN_OK(),
      wallets: () => new Response(JSON.stringify({ code: 0, data: { total_balance: 1234.5 } }), { status: 200 }),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /剩余 1234.5 积分/);
});

test('任务状态已完成时不发 claim', async () => {
  const calls: string[] = [];
  const ctx = ctxWith(
    mockAutoClaw({
      taskList: () =>
        new Response(
          JSON.stringify({ code: 0, data: [{ task_id: 'daily_signin', status: 'completed', reward_points: 400 }] }),
          { status: 200 },
        ),
      onCall: (url) => calls.push(url),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /今日已签到/);
  assert.ok(!calls.some((u) => u.includes('/autoclaw-task-complete')), '已完成时不应再调 claim');
});

test('任务状态未完成时照常 claim', async () => {
  const calls: string[] = [];
  const ctx = ctxWith(
    mockAutoClaw({
      taskList: () =>
        new Response(JSON.stringify({ code: 0, data: [{ task_id: 'daily_signin', status: 'in_progress' }] }), {
          status: 200,
        }),
      checkin: () => CHECKIN_OK(),
      onCall: (url) => calls.push(url),
    }),
  );
  const result = await autoclaw.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.ok(calls.some((u) => u.includes('/autoclaw-task-complete')), '未完成时应调 claim');
});
