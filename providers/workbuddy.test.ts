import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workbuddy, sendSmsCode, loginWithSms } from './workbuddy.ts';
import { queryBalance } from './workbuddy-tasks.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'workbuddy', name: 'main', token: 'tk' };

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

test('code=0 判定成功，请求命中 daily-checkin 且带 Bearer 头', async () => {
  const calls: Array<{ url: string; auth?: string }> = [];
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return new Response(JSON.stringify({ code: 0, data: { points: 100 } }), { status: 200 });
  }) as typeof fetch);
  const result = await workbuddy.checkin(account, ctx);
  assert.equal(result.ok, true);
  const checkinCall = calls.find((c) => c.url.includes('/v2/billing/meter/daily-checkin'));
  assert.ok(checkinCall, '应调用 daily-checkin');
  assert.equal(checkinCall?.auth, 'Bearer tk');
});

test('code=10001 今日已签到也判定成功（幂等）', async () => {
  const ctx = ctxWith(
    (async () =>
      new Response(JSON.stringify({ code: 10001, message: '今天已签到' }), { status: 200 })) as typeof fetch,
  );
  const result = await workbuddy.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /已签到/);
});

test('服务端错误 code 判定失败并带上 message', async () => {
  const ctx = ctxWith(
    (async () => new Response(JSON.stringify({ code: 500, message: 'boom' }), { status: 200 })) as typeof fetch,
  );
  const result = await workbuddy.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /boom/);
});

test('非 JSON 响应判定失败', async () => {
  const ctx = ctxWith((async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch);
  const result = await workbuddy.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /非 JSON/);
});

test('有 refreshToken 时先刷新，再用返回的 accessToken 签到', async () => {
  const calls: Array<{ url: string; auth?: string }> = [];
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (u.includes('/v2/plugin/auth/token/refresh')) {
      return new Response(JSON.stringify({ accessToken: 'fresh-access' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as typeof fetch);
  const result = await workbuddy.checkin({ ...account, refreshToken: 'rt' }, ctx);
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /token\/refresh/);
  const checkinCall = calls.find((c) => c.url.includes('/v2/billing/meter/daily-checkin'));
  assert.equal(checkinCall?.auth, 'Bearer fresh-access');
});

test('刷新失败时不发起签到请求，判定失败', async () => {
  let checkinCalled = false;
  const ctx = ctxWith((async (url: string | URL | Request) => {
    if (String(url).includes('/token/refresh')) {
      return new Response(JSON.stringify({ code: 401, message: 'invalid refresh token' }), { status: 200 });
    }
    checkinCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const result = await workbuddy.checkin({ ...account, refreshToken: 'bad-rt' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(checkinCalled, false);
  assert.match(result.message, /刷新失败/);
});

test('刷新返回轮换的新 refreshToken 时提示更新 Secret', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    if (String(url).includes('/token/refresh')) {
      return new Response(JSON.stringify({ accessToken: 'a2', refreshToken: 'rt2' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as typeof fetch);
  const result = await workbuddy.checkin({ ...account, refreshToken: 'rt1' }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /轮换/);
});

test('既无 token 也无 refreshToken 时判定失败', async () => {
  const ctx = ctxWith((async () => new Response('{}', { status: 200 })) as typeof fetch);
  const result = await workbuddy.checkin({ provider: 'workbuddy', name: 'x', token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /token/);
});

test('sendSmsCode 请求 send-sms 接口并携带 phone', async () => {
  const seen: { url: string; body?: string } = { url: '' };
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = init?.body as string | undefined;
    return new Response(JSON.stringify({ code: 0, data: { expires_in: 300 } }), { status: 200 });
  }) as typeof fetch);
  await sendSmsCode('22644212509', ctx);
  assert.match(seen.url, /www\.workbuddy\.cn\/v2\/plugin\/login\/send-sms/);
  assert.deepEqual(JSON.parse(seen.body ?? '{}'), { phone: '22644212509' });
});

test('sendSmsCode 服务端错误时抛出带 msg 的异常', async () => {
  const ctx = ctxWith(
    (async () =>
      new Response(JSON.stringify({ code: 10000, msg: 'keycloak SPI returned status=400' }), { status: 500 })) as typeof fetch,
  );
  await assert.rejects(() => sendSmsCode('22644212509', ctx), /keycloak SPI/);
});

test('loginWithSms 用手机号+验证码换取 accessToken/refreshToken', async () => {
  const seen: { url: string; body?: string } = { url: '' };
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = init?.body as string | undefined;
    return new Response(JSON.stringify({ code: 0, data: { accessToken: 'at', refreshToken: 'rt' } }), { status: 200 });
  }) as typeof fetch);
  const tokens = await loginWithSms('22644212509', '123456', ctx);
  assert.deepEqual(tokens, { accessToken: 'at', refreshToken: 'rt' });
  assert.match(seen.url, /\/v2\/plugin\/login\/token/);
  assert.deepEqual(JSON.parse(seen.body ?? '{}'), {
    login_method: 'phone',
    phone: '22644212509',
    sms_code: '123456',
  });
});

test('loginWithSms 响应缺少 token 时抛错', async () => {
  const ctx = ctxWith((async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })) as typeof fetch);
  await assert.rejects(() => loginWithSms('22644212509', '123456', ctx), /缺少/);
});

test('checkin 的轮换信息出现在 detail.rotatedRefreshToken', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    if (String(url).includes('/token/refresh')) {
      return new Response(JSON.stringify({ accessToken: 'a2', refreshToken: 'rt2' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as typeof fetch);
  const result = await workbuddy.checkin({ ...account, refreshToken: 'rt1' }, ctx);
  assert.equal(result.ok, true);
  assert.equal((result.detail as { rotatedRefreshToken?: string }).rotatedRefreshToken, 'rt2');
});

// 增值任务（余额对比 + 连登管家）的 mock：默认全部降级（无套餐、档位锁定、无抽奖次数）
function taskMock(overrides: {
  balanceRemain?: number[];
  redeemOkTiers?: string[];
  lotteryChances?: number;
} = {}) {
  let balanceCall = 0;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/get-user-resource')) {
      const remain = overrides.balanceRemain?.[balanceCall] ?? 0;
      balanceCall++;
      return new Response(
        JSON.stringify({ code: 0, data: { accounts: [{ CycleCapacityRemain: remain, CycleCapacitySize: 1000 }] } }),
        { status: 200 },
      );
    }
    if (u.includes('/redeem')) {
      return new Response('', { status: 200 });
    }
    if (u.includes('/lottery/summary')) {
      return new Response(
        JSON.stringify({ code: 0, data: { chances: overrides.lotteryChances ?? 0, module: { enabled: true } } }),
        { status: 200 },
      );
    }
    if (u.includes('/lottery/draw')) {
      return new Response(JSON.stringify({ code: 0, data: { prize: '积分' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as typeof fetch;
}

test('签到成功后消息包含积分到账对比', async () => {
  const ctx = ctxWith(taskMock({ balanceRemain: [100, 200] }));
  const result = await workbuddy.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /积分 100→200/);
});

test('detail 中包含余额对比与连登管家结果（供 --verbose 诊断）', async () => {
  const ctx = ctxWith(taskMock({ balanceRemain: [100, 200], lotteryChances: 1 }));
  const result = await workbuddy.checkin(account, ctx);
  const detail = result.detail as {
    balanceBefore: { remain: number } | null;
    balanceAfter: { remain: number } | null;
    streak: { redeemed: string[]; draws: number };
  };
  assert.equal(detail.balanceBefore?.remain, 100);
  assert.equal(detail.balanceAfter?.remain, 200);
  assert.deepEqual(detail.streak.redeemed, ['7d', '14d', '28d']);
  assert.equal(detail.streak.draws, 1);
});

test('余额查询失败时签到仍判成功且消息无积分段', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/get-user-resource')) {
      return new Response('gateway error', { status: 502 });
    }
    if (u.includes('/redeem')) {
      return new Response(JSON.stringify({ code: 403 }), { status: 403 });
    }
    if (u.includes('/lottery/summary')) {
      return new Response(JSON.stringify({ code: 0, data: { chances: 0, module: { enabled: true } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as typeof fetch);
  const result = await workbuddy.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.message, '签到成功');
});

test('连登管家兑换与抽奖结果进入签到消息', async () => {
  const ctx = ctxWith(taskMock({ lotteryChances: 2 }));
  const result = await workbuddy.checkin(account, ctx);
  assert.match(result.message, /连登管家: 兑换7d\/14d\/28d/);
  assert.match(result.message, /抽奖x2/);
});

test('余额按当前周期口径：未启用的套餐容量不计入（与站点一致）', async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                { Status: 0, CycleCapacityRemain: 316, CycleCapacitySize: 500, CapacityRemain: 316, CapacitySize: 500 },
                { Status: 0, CycleCapacityRemain: 0, CycleCapacitySize: 500, CapacityRemain: 500, CapacitySize: 500 },
              ],
            },
          },
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const r = await queryBalance('tk', ctxWith(fake));
  assert.equal(r.balance?.remain, 316);
});

test('缺少周期字段时回落到 Capacity 字段', async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [{ Status: 0, CapacityRemain: 700, CapacitySize: 1000 }] } } } }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const r = await queryBalance('tk', ctxWith(fake));
  assert.equal(r.balance?.remain, 700);
});
