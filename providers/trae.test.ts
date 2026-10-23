import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trae, parseTraeUsage } from './trae.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'trae', name: 'main', token: '', refreshToken: 'tr-1' };

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

// 按 wallechfox/Trae-Checkin 实测契约路由 mock：ExchangeToken（api.trae.com.cn）与 claim（api.trae.cn）
function mockTrae(handlers: {
  exchange?: () => Response;
  claim?: () => Response;
  usage?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/oauth/ExchangeToken')) return handlers.exchange!();
    if (u.includes('/checkin_credits/claim')) return handlers.claim!();
    if (u.includes('/pay/ide_user_ent_usage')) return handlers.usage?.() ?? new Response('{}', { status: 500 });
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const EXCHANGE_OK = () =>
  new Response(JSON.stringify({ code: 0, Result: { Token: 'jwt-1', RefreshToken: 'tr-2', TokenExpireAt: 1790000000000 } }), {
    status: 200,
  });

async function withDeviceEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    TRAE_DEVICE_ID: process.env.TRAE_DEVICE_ID,
    TRAE_MACHINE_ID: process.env.TRAE_MACHINE_ID,
    TRAE_USER_ID: process.env.TRAE_USER_ID,
  };
  process.env.TRAE_DEVICE_ID = '626064396416234';
  process.env.TRAE_MACHINE_ID = 'machine-1';
  process.env.TRAE_USER_ID = 'uid-1';
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('refreshToken 先经 ExchangeToken 换 JWT，再 claim；请求体与请求头符合契约', async () => {
  await withDeviceEnv(async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const ctx = ctxWith(
      mockTrae({
        exchange: EXCHANGE_OK,
        claim: () => new Response(JSON.stringify({ code: 0, data: { credits: 300 } }), { status: 200 }),
        onCall: (url, init) => calls.push({ url, init }),
      }),
    );
    const result = await trae.checkin(account, ctx);
    assert.equal(result.ok, true);
    assert.match(result.message, /300/);

    const exchange = calls.find((c) => c.url.includes('ExchangeToken'));
    assert.ok(exchange, '应先调 ExchangeToken');
    const exchangeBody = JSON.parse(String(exchange!.init?.body));
    assert.equal(exchangeBody.ClientID, 'ono9krqynydwx5');
    assert.equal(exchangeBody.RefreshToken, 'tr-1');
    assert.equal(exchangeBody.ClientSecret, '-');

    const claim = calls.find((c) => c.url.includes('/checkin_credits/claim'));
    assert.ok(claim, '应调 claim');
    const headers = claim!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Cloud-IDE-JWT jwt-1');
    assert.equal(headers['X-User-Region'], 'CN');
    assert.equal(headers['x-device-id'], '626064396416234');
    // 9074 的真因是设备指纹不完整：machine-id / uid / app-id / 版本 / 品牌缺一不可
    assert.equal(headers['x-machine-id'], 'machine-1');
    assert.equal(headers['x-uid'], 'uid-1');
    assert.equal(headers['x-app-id'], '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8');
    assert.equal(headers['x-app-version'], '0.1.69');
    assert.equal(headers['x-ide-version-type'], 'stable');
    assert.match(headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(String(claim!.init?.body)), { req_source: 2 });
    assert.equal(result.rotatedRefreshToken, 'tr-2');
  });
});

test('claim 返回 9095 判定成功（今日已领取，幂等）', async () => {
  const ctx = ctxWith(
    mockTrae({
      exchange: EXCHANGE_OK,
      claim: () => new Response(JSON.stringify({ code: 9095, message: 'already checked in' }), { status: 200 }),
    }),
  );
  const result = await trae.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /已领取/);
});

test('claim 返回 9074 判定失败（设备号问题，积分未到账）', async () => {
  const ctx = ctxWith(
    mockTrae({
      exchange: EXCHANGE_OK,
      claim: () => new Response(JSON.stringify({ code: 9074, message: '当前参与用户太多' }), { status: 200 }),
    }),
  );
  const result = await trae.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /9074/);
});

test('claim 返回 1001 时自动刷新重试一次后成功', async () => {
  let claimCount = 0;
  const ctx = ctxWith(
    mockTrae({
      exchange: EXCHANGE_OK,
      claim: () => {
        claimCount += 1;
        if (claimCount === 1) return new Response(JSON.stringify({ code: 1001, message: 'token expired' }), { status: 200 });
        return new Response(JSON.stringify({ code: 0, data: { credits: 200 } }), { status: 200 });
      },
    }),
  );
  const result = await trae.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.equal(claimCount, 2);
});

test('ExchangeToken 失败时不发起 claim，判定失败', async () => {
  let claimCalled = false;
  const ctx = ctxWith(
    mockTrae({
      exchange: () => new Response(JSON.stringify({ code: 401, message: 'invalid refresh token' }), { status: 200 }),
      claim: () => {
        claimCalled = true;
        return new Response('{}', { status: 200 });
      },
    }),
  );
  const result = await trae.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.equal(claimCalled, false);
  assert.match(result.message, /刷新失败/);
});

test('已有 token 且无 refreshToken 时直接 claim，不刷新', async () => {
  let exchangeCalled = false;
  const ctx = ctxWith(
    mockTrae({
      exchange: () => {
        exchangeCalled = true;
        return EXCHANGE_OK();
      },
      claim: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    }),
  );
  const result = await trae.checkin({ ...account, token: 'jwt-direct', refreshToken: undefined }, ctx);
  assert.equal(result.ok, true);
  assert.equal(exchangeCalled, false);
});

test('缺少凭证判定失败且不发起请求', async () => {
  let called = false;
  const ctx = ctxWith((async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const result = await trae.checkin({ provider: 'trae', name: 'main', token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('无 TRAE_DEVICE_ID 时请求不带 x-device-id 头', async () => {
  const prev = process.env.TRAE_DEVICE_ID;
  delete process.env.TRAE_DEVICE_ID;
  try {
    let seen: string | undefined = 'unset';
    const ctx = ctxWith(
      mockTrae({
        exchange: EXCHANGE_OK,
        claim: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
        onCall: (url, init) => {
          if (url.includes('/claim')) seen = (init?.headers as Record<string, string>)?.['x-device-id'];
        },
      }),
    );
    await trae.checkin(account, ctx);
    assert.equal(seen, undefined);
  } finally {
    if (prev !== undefined) process.env.TRAE_DEVICE_ID = prev;
  }
});

test('parseTraeUsage 汇总套餐额度与已用积分', () => {
  const usage = parseTraeUsage({
    user_entitlement_pack_list: [
      { entitlement_base_info: { quota: { credits_limit: 1000 }, end_time: 1790000000000 }, usage: { credits_amount: 250 } },
      { entitlement_base_info: { quota: { credits_limit: 500 } }, usage: { credits_amount: 500 } },
    ],
  });
  assert.deepEqual(usage, { limit: 1500, used: 750, remain: 750, unlimited: false });
});

test('parseTraeUsage 识别无限额度与空套餐', () => {
  assert.equal(
    parseTraeUsage({ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: -1 } } }] })?.unlimited,
    true,
  );
  assert.equal(parseTraeUsage({ user_entitlement_pack_list: [] }), null);
});

test('签到成功后附带剩余积分（usage 查询失败不影响签到判定）', async () => {
  await withDeviceEnv(async () => {
    const ctx = ctxWith(
      mockTrae({
        exchange: EXCHANGE_OK,
        claim: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
        usage: () =>
          new Response(
            JSON.stringify({
              user_entitlement_pack_list: [
                { entitlement_base_info: { quota: { credits_limit: 1000 } }, usage: { credits_amount: 250 } },
              ],
            }),
            { status: 200 },
          ),
      }),
    );
    const result = await trae.checkin(account, ctx);
    assert.equal(result.ok, true);
    assert.match(result.message, /剩余 750\/1000/);

    const broken = ctxWith(
      mockTrae({
        exchange: EXCHANGE_OK,
        claim: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
        usage: () => new Response('boom', { status: 500 }),
      }),
    );
    const stillOk = await trae.checkin(account, broken);
    assert.equal(stillOk.ok, true);
    assert.doesNotMatch(stillOk.message, /剩余/);
  });
});
