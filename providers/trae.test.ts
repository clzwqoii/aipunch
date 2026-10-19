import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trae } from './trae.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'trae', name: 'main', token: '', refreshToken: 'tr-1' };

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

// 按 wallechfox/Trae-Checkin 实测契约路由 mock：ExchangeToken（api.trae.com.cn）与 claim（api.trae.cn）
function mockTrae(handlers: {
  exchange?: () => Response;
  claim?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/oauth/ExchangeToken')) return handlers.exchange!();
    if (u.includes('/checkin_credits/claim')) return handlers.claim!();
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const EXCHANGE_OK = () =>
  new Response(JSON.stringify({ code: 0, Result: { Token: 'jwt-1', RefreshToken: 'tr-2', TokenExpireAt: 1790000000000 } }), {
    status: 200,
  });

function withDeviceEnv<T>(fn: () => T): T {
  const prev = process.env.TRAE_DEVICE_ID;
  process.env.TRAE_DEVICE_ID = '626064396416234';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TRAE_DEVICE_ID;
    else process.env.TRAE_DEVICE_ID = prev;
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
