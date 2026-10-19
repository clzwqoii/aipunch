import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codearts } from './codearts.ts';
import { newDpopKeyPair } from '../core/codearts-dpop.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'codearts', name: 'main', token: '', refreshToken: 'rt-1' };

function ctxWith(fetchImpl: typeof fetch, now = new Date()): RunContext {
  return { now, fetch: fetchImpl };
}

const CRED_RESPONSE = {
  code: 0,
  credentials: {
    access_key_id: 'AK-1',
    secret_access_key: 'SK-1',
    security_token: 'ST-1',
    refresh_token: 'rt-2',
  },
};

// 环境准备：DPoP 私钥 + code_verifier（与 refresh_token 绑定）
const envKeys = ['CODEARTS_DPOP_KEY', 'CODEARTS_CODE_VERIFIER', 'CODEARTS_CLIENT_ID'] as const;
let savedEnv: Record<string, string | undefined> = {};
function withCodeArtsEnv<T>(fn: () => T): T {
  savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.CODEARTS_DPOP_KEY = JSON.stringify(newDpopKeyPair());
  process.env.CODEARTS_CODE_VERIFIER = 'verifier-1';
  delete process.env.CODEARTS_CLIENT_ID;
  try {
    return fn();
  } finally {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

function mockCodeArts(handlers: {
  token?: () => Response;
  delivery?: () => Response;
  claim?: () => Response;
  confirm?: () => Response;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    handlers.onCall?.(u, init);
    if (u.includes('/v1/oauth2/tokens')) return handlers.token!();
    if (u.includes('/v1/ops/delivery')) return handlers.delivery!();
    if (u.includes('/v1/ops/claim')) return handlers.claim!();
    if (u.includes('/v1/ops/confirm')) return handlers.confirm!();
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const TOKEN_OK = () => new Response(JSON.stringify(CRED_RESPONSE), { status: 200 });

const DELIVERY_ELIGIBLE = () =>
  new Response(
    JSON.stringify({
      code: 0,
      data: {
        items: [
          { campaignId: 3, status: 'CONFIRMED', title: '推荐码' },
          { campaignId: 1, status: 'ELIGIBLE', claimable: true, benefitAmount: 1000, title: '每日签到领积分', extra: { endTime: '2026-12-31T16:00:00Z' } },
        ],
      },
    }),
    { status: 200 },
  );

test('全流程：刷新换 STS 凭据 → delivery → claim → confirm，判定到账', async () => {
  await withCodeArtsEnv(async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const ctx = ctxWith(
      mockCodeArts({
        token: TOKEN_OK,
        delivery: DELIVERY_ELIGIBLE,
        claim: () => new Response(JSON.stringify({ code: 0, message: 'ok' }), { status: 200 }),
        confirm: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
        onCall: (url, init) => calls.push({ url, init }),
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, true);
    assert.match(result.message, /1000/);

    const tokenCall = calls.find((c) => c.url.includes('/v1/oauth2/tokens'));
    assert.ok(tokenCall, '应先刷新');
    const tokenHeaders = tokenCall!.init?.headers as Record<string, string>;
    assert.ok(tokenHeaders.DPoP, '应带 DPoP proof');
    assert.match(String(tokenCall!.init?.body), /grant_type=refresh_token/);

    const deliveryCall = calls.find((c) => c.url.includes('/v1/ops/delivery'));
    assert.ok(deliveryCall);
    assert.match(deliveryCall!.url, /channel=IDE/);
    const deliveryHeaders = deliveryCall!.init?.headers as Record<string, string>;
    assert.match(deliveryHeaders.Authorization, /^SDK-HMAC-SHA256 Access=AK-1, /);
    assert.equal(deliveryHeaders['Agent-Type'], 'PromptCenter'); // ops 系列必带，漏了报 TM.00001001

    const claimCall = calls.find((c) => c.url.includes('/v1/ops/claim'));
    assert.ok(claimCall, '应 claim');
    const claimBody = JSON.parse(String(claimCall!.init?.body));
    assert.equal(claimBody.campaignId, 1);
    assert.equal(claimBody.channel, 'IDE');
    assert.match(claimBody.idempotentKey, /^claim_1_\d+$/);

    const confirmCall = calls.find((c) => c.url.includes('/v1/ops/confirm'));
    assert.ok(confirmCall, 'claim 后必须 confirm');
    assert.deepEqual(JSON.parse(String(confirmCall!.init?.body)), { campaignId: 1 });

    assert.equal(result.rotatedRefreshToken, 'rt-2');
  });
});

test('CONFIRMED 判定今日已签到，不调 claim/confirm', async () => {
  await withCodeArtsEnv(async () => {
    let claimCalled = false;
    const ctx = ctxWith(
      mockCodeArts({
        token: TOKEN_OK,
        delivery: () =>
          new Response(JSON.stringify({ code: 0, data: { items: [{ campaignId: 1, status: 'CONFIRMED', benefitAmount: 1000 }] } }), { status: 200 }),
        claim: () => {
          claimCalled = true;
          return new Response('{}', { status: 200 });
        },
        confirm: () => new Response('{}', { status: 200 }),
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, true);
    assert.match(result.message, /已签到/);
    assert.equal(claimCalled, false);
  });
});

test('CLAIMED（已领未确认）只补 confirm，判定成功', async () => {
  await withCodeArtsEnv(async () => {
    let claimCalled = false;
    let confirmCalled = false;
    const ctx = ctxWith(
      mockCodeArts({
        token: TOKEN_OK,
        delivery: () =>
          new Response(JSON.stringify({ code: 0, data: { items: [{ campaignId: 1, status: 'CLAIMED', claimable: false }] } }), { status: 200 }),
        claim: () => {
          claimCalled = true;
          return new Response('{}', { status: 200 });
        },
        confirm: () => {
          confirmCalled = true;
          return new Response(JSON.stringify({ code: 0 }), { status: 200 });
        },
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, true);
    assert.equal(claimCalled, false);
    assert.equal(confirmCalled, true);
    assert.match(result.message, /确认/);
  });
});

test('delivery 返回错误信封（error_code）判定失败，不误报未开放', async () => {
  await withCodeArtsEnv(async () => {
    const ctx = ctxWith(
      mockCodeArts({
        token: TOKEN_OK,
        delivery: () => new Response(JSON.stringify({ error_code: 'TM.00001001', error_msg: '请求头Agent-Type为空' }), { status: 200 }),
        claim: () => new Response('{}', { status: 200 }),
        confirm: () => new Response('{}', { status: 200 }),
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /TM\.00001001|查询签到活动失败/);
  });
});

test('活动不存在判定成功（未开放）', async () => {
  await withCodeArtsEnv(async () => {
    const ctx = ctxWith(
      mockCodeArts({
        token: TOKEN_OK,
        delivery: () => new Response(JSON.stringify({ code: 0, data: { items: [{ campaignId: 3, status: 'ELIGIBLE', claimable: true }] } }), { status: 200 }),
        claim: () => new Response('{}', { status: 200 }),
        confirm: () => new Response('{}', { status: 200 }),
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, true);
    assert.match(result.message, /未开放/);
  });
});

test('claim 返回业务码失败（如 40001 未到刷新时间）判定失败', async () => {
  await withCodeArtsEnv(async () => {
    const ctx = ctxWith(
      mockCodeArts({
        token: TOKEN_OK,
        delivery: DELIVERY_ELIGIBLE,
        claim: () => new Response(JSON.stringify({ code: 40001, message: '尚未到达权益刷新时间' }), { status: 200 }),
        confirm: () => new Response('{}', { status: 200 }),
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /40001|刷新时间/);
  });
});

test('刷新失败不发起签到，判定失败', async () => {
  await withCodeArtsEnv(async () => {
    let deliveryCalled = false;
    const ctx = ctxWith(
      mockCodeArts({
        token: () => new Response(JSON.stringify({ code: 401, message: 'invalid refresh token' }), { status: 200 }),
        delivery: () => {
          deliveryCalled = true;
          return new Response('{}', { status: 200 });
        },
        claim: () => new Response('{}', { status: 200 }),
        confirm: () => new Response('{}', { status: 200 }),
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, false);
    assert.equal(deliveryCalled, false);
    assert.match(result.message, /刷新失败/);
  });
});

test('缺 CODEARTS_DPOP_KEY 判定失败且不发起请求', async () => {
  await withCodeArtsEnv(async () => {
    delete process.env.CODEARTS_DPOP_KEY;
    let called = false;
    const ctx = ctxWith((async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assert.match(result.message, /DPoP|凭据/);
  });
});

test('legacy 字段形态（access/secret/securitytoken）也能解析', async () => {
  await withCodeArtsEnv(async () => {
    const ctx = ctxWith(
      mockCodeArts({
        token: () =>
          new Response(
            JSON.stringify({ code: 0, credential: { access: 'AK-9', secret: 'SK-9', securitytoken: 'ST-9' } }),
            { status: 200 },
          ),
        delivery: () =>
          new Response(JSON.stringify({ code: 0, data: { items: [{ campaignId: 1, status: 'CONFIRMED' }] } }), { status: 200 }),
        claim: () => new Response('{}', { status: 200 }),
        confirm: () => new Response('{}', { status: 200 }),
        onCall: (url, init) => {
          if (url.includes('/v1/ops/delivery')) {
            assert.match((init?.headers as Record<string, string>).Authorization, /Access=AK-9/);
          }
        },
      }),
    );
    const result = await codearts.checkin(account, ctx);
    assert.equal(result.ok, true);
  });
});
