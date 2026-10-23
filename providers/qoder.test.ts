import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qoder, exchangePat, parseQoderUsage } from './qoder.ts';
import type { Account, RunContext } from '../core/types.ts';

const account: Account = { provider: 'qoder', name: 'main', token: '', refreshToken: 'drt-1' };

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

const CAMPAIGN_CLAIMABLE = {
  campaigns: [
    {
      campaignId: 'c1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { kind: 'CREDITS', amount: 100, validity: { days: 30 } },
    },
  ],
};

test('CLAIMABLE 活动：先刷新换 token，再查活动并领取，判定成功', async () => {
  const calls: Array<{ url: string; method: string; auth?: string }> = [];
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (u.includes('/api/v1/deviceToken/refresh')) {
      return new Response(JSON.stringify({ token: 'fresh-dt', refresh_token: 'drt-2' }), { status: 200 });
    }
    if (u.includes('/me/campaigns') && !u.includes('/claim')) {
      return new Response(JSON.stringify(CAMPAIGN_CLAIMABLE), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 });
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /deviceToken\/refresh/);
  const claimCall = calls.find((c) => c.url.includes('/campaigns/c1/claim'));
  assert.ok(claimCall, '应 POST claim');
  assert.equal(claimCall?.method, 'POST');
  assert.equal(claimCall?.auth, 'Bearer fresh-dt');
  assert.match(result.message, /100/);
  assert.equal(result.rotatedRefreshToken, 'drt-2');
});

test('claim 幂等回放（replayed=true）也判定成功', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/deviceToken/refresh')) {
      return new Response(JSON.stringify({ token: 'dt' }), { status: 200 });
    }
    if (u.includes('/claim')) {
      return new Response(JSON.stringify({ replayed: true }), { status: 200 });
    }
    return new Response(JSON.stringify(CAMPAIGN_CLAIMABLE), { status: 200 });
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /已领取|领取/);
});

test('今日已领取（CLAIMED 在窗口内）不发起 claim，判定成功', async () => {
  let claimCalled = false;
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/deviceToken/refresh')) {
      return new Response(JSON.stringify({ token: 'dt' }), { status: 200 });
    }
    if (u.includes('/claim')) {
      claimCalled = true;
      return new Response('{}', { status: 200 });
    }
    return new Response(
      JSON.stringify({ campaigns: [{ ...CAMPAIGN_CLAIMABLE.campaigns[0], claimStatus: 'CLAIMED' }] }),
      { status: 200 },
    );
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.equal(claimCalled, false);
  assert.match(result.message, /已领取/);
});

test('活动列表为空判定成功（活动未开放，非失败）', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/deviceToken/refresh')) {
      return new Response(JSON.stringify({ token: 'dt' }), { status: 200 });
    }
    return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /暂无可领取|未开放/);
});

test('campaigns 返回 401 判定失败且带状态码', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    if (String(url).includes('/deviceToken/refresh')) {
      return new Response(JSON.stringify({ token: 'dt' }), { status: 200 });
    }
    return new Response('unauthorized', { status: 401 });
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /401/);
});

test('刷新失败时不发起后续请求，判定失败', async () => {
  let campaignsCalled = false;
  const ctx = ctxWith((async (url: string | URL | Request) => {
    if (String(url).includes('/deviceToken/refresh')) {
      return new Response(JSON.stringify({ message: 'invalid refresh token' }), { status: 200 });
    }
    campaignsCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, false);
  assert.equal(campaignsCalled, false);
  assert.match(result.message, /刷新失败/);
});

test('缺少凭证判定失败且不发起请求', async () => {
  let called = false;
  const ctx = ctxWith((async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const result = await qoder.checkin({ provider: 'qoder', name: 'main', token: '' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('exchangePat：PAT 经 jobToken/exchange 换出 token 与 refresh_token', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify({ token: 'jt-1', refresh_token: 'jrt-1' }), { status: 200 });
  }) as typeof fetch);
  const creds = await exchangePat('pt-abc', ctx);
  assert.equal(creds.token, 'jt-1');
  assert.equal(creds.refreshToken, 'jrt-1');
  assert.match(calls[0].url, /\/api\/v1\/jobToken\/exchange/);
  assert.deepEqual(JSON.parse(calls[0].body), { personal_token: 'pt-abc' });
});

test('exchangePat：兑换响应缺字段判定失败', async () => {
  const ctx = ctxWith((async () => new Response(JSON.stringify({ message: 'bad pat' }), { status: 200 })) as typeof fetch);
  await assert.rejects(() => exchangePat('pt-bad', ctx), /兑换失败/);
});

test('jrt- 前缀的 refreshToken 走 jobToken/refresh（PAT 兑换链路）', async () => {
  const calls: string[] = [];
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/jobToken/refresh')) {
      return new Response(JSON.stringify({ token: 'jt-fresh', refresh_token: 'jrt-2' }), { status: 200 });
    }
    return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
  }) as typeof fetch);
  const result = await qoder.checkin({ ...account, refreshToken: 'jrt-1' }, ctx);
  assert.equal(result.ok, true);
  assert.ok(calls.some((u) => u.includes('/jobToken/refresh')), 'jrt- 应走 jobToken/refresh');
  assert.ok(!calls.some((u) => u.includes('/deviceToken/refresh')), '不应走 deviceToken/refresh');
  assert.equal(result.rotatedRefreshToken, 'jrt-2');
});

test('Cosy-MachineToken 环境变量透传到请求头', async () => {
  const prev = process.env.QODER_COSY_MACHINE_TOKEN;
  process.env.QODER_COSY_MACHINE_TOKEN = 'mt-1';
  try {
    let seen: string | undefined;
    const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/deviceToken/refresh')) {
        return new Response(JSON.stringify({ token: 'dt' }), { status: 200 });
      }
      seen = (init?.headers as Record<string, string> | undefined)?.['Cosy-MachineToken'];
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
    }) as typeof fetch);
    await qoder.checkin(account, ctx);
    assert.equal(seen, 'mt-1');
  } finally {
    if (prev === undefined) delete process.env.QODER_COSY_MACHINE_TOKEN;
    else process.env.QODER_COSY_MACHINE_TOKEN = prev;
  }
});

test('parseQoderUsage 取 userQuota 的额度与已用', () => {
  assert.deepEqual(
    parseQoderUsage({
      displayMode: 'qoder',
      qoderUsage: { userQuota: { total: 1000, used: 250, remaining: 750, unit: 'credits' } },
    }),
    { limit: 1000, used: 250, remain: 750 },
  );
  assert.equal(parseQoderUsage({ displayMode: 'enterprise' }), null);
  assert.equal(parseQoderUsage({}), null);
});

test('parseQoderUsage 兼容 snake_case 与 cap/remaining', () => {
  assert.deepEqual(
    parseQoderUsage({ displayMode: 'qoder', qoderUsage: { user_quota: { cap: 500, remaining: 300 } } }),
    { limit: 500, used: 200, remain: 300 },
  );
});

test('签到结果附带剩余额度（usage 查询失败不影响签到）', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/deviceToken/refresh')) {
      return new Response(JSON.stringify({ token: 'fresh-dt', refresh_token: 'drt-2' }), { status: 200 });
    }
    if (u.includes('/sash/api/v2/me/usage')) {
      return new Response(
        JSON.stringify({ displayMode: 'qoder', qoderUsage: { userQuota: { total: 1000, used: 250, remaining: 750 } } }),
        { status: 200 },
      );
    }
    if (u.includes('/me/campaigns') && !u.includes('/claim')) {
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch);
  const result = await qoder.checkin(account, ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /剩余 750\/1000/);
});
