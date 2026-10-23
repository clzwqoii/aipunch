import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryBalance, runStreakManager } from './workbuddy-tasks.ts';
import type { RunContext } from '../core/types.ts';

function ctxWith(fetchImpl: typeof fetch): RunContext {
  return { now: new Date(), fetch: fetchImpl };
}

const TOKEN = 'at';

test('queryBalance 聚合 cycle 套餐剩余/总额度，平铺字段求和', async () => {
  const ctx = ctxWith((async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          accounts: [
            { PackageName: '月度积分', CycleCapacityRemain: 800, CycleCapacitySize: 1000 },
            { PackageName: '新手包', CapacityRemain: 500, CapacitySize: 500 },
          ],
        },
      }),
      { status: 200 },
    )) as typeof fetch);
  const result = await queryBalance(TOKEN, ctx);
  assert.deepEqual(result.balance, { remain: 1300, total: 1500 });
  assert.ok(result.raw, '应携带原始响应用于诊断');
});

test('queryBalance 兼容 PascalCase 字段名（Accounts/CycleCapacityRemain）', async () => {
  const ctx = ctxWith((async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          Accounts: [{ PackageName: '月度积分', CycleCapacityRemain: 800, CycleCapacitySize: 1000 }],
        },
      }),
      { status: 200 },
    )) as typeof fetch);
  assert.deepEqual((await queryBalance(TOKEN, ctx)).balance, { remain: 800, total: 1000 });
});

test('queryBalance 解析真实嵌套 data.Response.Data.Accounts，只统计 Status=0，余额按周期口径', async () => {
  const ctx = ctxWith((async () =>
    new Response(
      JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          Response: {
            Data: {
              TotalCount: 3,
              Accounts: [
                { PackageName: '已用完', Status: 3, CapacityRemain: 0, CapacitySize: 100 },
                { PackageName: '签到包', Status: 0, CapacityRemain: 100, CapacitySize: 100 },
                {
                  PackageName: '个人体验版',
                  Status: 0,
                  CapacityRemain: 500,
                  CapacitySize: 500,
                  CycleCapacityRemain: 0,
                  CycleCapacitySize: 500,
                },
              ],
            },
          },
        },
      }),
      { status: 200 },
    )) as typeof fetch);
  // 个人体验版 cycle 余量为 0（未启用/未循环），站点不计入；只算签到包的 100
  assert.deepEqual((await queryBalance(TOKEN, ctx)).balance, { remain: 100, total: 600 });
});

test('queryBalance remain 超出 size 时钳制到 size', async () => {
  const ctx = ctxWith((async () =>
    new Response(
      JSON.stringify({ code: 0, data: { accounts: [{ CycleCapacityRemain: 1200, CycleCapacitySize: 1000 }] } }),
      { status: 200 },
    )) as typeof fetch);
  assert.deepEqual((await queryBalance(TOKEN, ctx)).balance, { remain: 1000, total: 1000 });
});

test('queryBalance 无 accounts 时 balance 为 null', async () => {
  const ctx = ctxWith((async () => new Response(JSON.stringify({ code: 0, data: { accounts: [] } }), { status: 200 })) as typeof fetch);
  const result = await queryBalance(TOKEN, ctx);
  assert.equal(result.balance, null);
  assert.ok(result.raw, '空 accounts 也应携带原始响应');
});

test('queryBalance 请求体包含分页、产品码与状态过滤', async () => {
  let body: Record<string, unknown> = {};
  const ctx = ctxWith((async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse((init?.body as string) ?? '{}');
    return new Response(JSON.stringify({ code: 0, data: { accounts: [] } }), { status: 200 });
  }) as typeof fetch);
  await queryBalance(TOKEN, ctx);
  assert.equal(body.PageNumber, 1);
  assert.equal(body.ProductCode, 'p_tcaca');
  assert.deepEqual(body.Status, [0, 3]);
  assert.ok(String(body.PackageEndTimeRangeBegin ?? '').length > 0);
});

test('runStreakManager 尝试兑换全部档位，403 视为未解锁跳过', async () => {
  const ctx = ctxWith((async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/redeem')) {
      const tier = JSON.parse((init?.body as string) ?? '{}').tier;
      if (tier === '7d') {
        return new Response('', { status: 200 }); // 成功返回空 body
      }
      return new Response(JSON.stringify({ code: 403, msg: '连续登录天数不足' }), { status: 403 });
    }
    if (u.includes('/lottery/summary')) {
      return new Response(JSON.stringify({ code: 0, data: { chances: 0, module: { enabled: true } } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const summary = await runStreakManager(TOKEN, ctx);
  assert.deepEqual(summary.redeemed, ['7d']);
  assert.equal(summary.draws, 0);
  assert.deepEqual(summary.attempts, [
    { tier: '7d', ok: true, status: 200 },
    { tier: '14d', ok: false, status: 403 },
    { tier: '28d', ok: false, status: 403 },
  ]);
});

test('runStreakManager 按抽奖次数循环抽奖', async () => {
  let drawCalls = 0;
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/lottery/draw')) {
      drawCalls++;
      return new Response(JSON.stringify({ code: 0, data: { prize: '积分' } }), { status: 200 });
    }
    if (u.includes('/lottery/summary')) {
      return new Response(JSON.stringify({ code: 0, data: { chances: 2, module: { enabled: true } } }), { status: 200 });
    }
    if (u.includes('/redeem')) {
      return new Response(JSON.stringify({ code: 403 }), { status: 403 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const summary = await runStreakManager(TOKEN, ctx);
  assert.equal(summary.draws, 2);
  assert.equal(drawCalls, 2);
});

test('runStreakManager 抽奖模块关闭时不抽奖', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/lottery/summary')) {
      return new Response(JSON.stringify({ code: 0, data: { chances: 5, module: { enabled: false } } }), { status: 200 });
    }
    if (u.includes('/redeem')) {
      return new Response(JSON.stringify({ code: 403 }), { status: 403 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  assert.equal((await runStreakManager(TOKEN, ctx)).draws, 0);
});

test('runStreakManager 抽奖状态获取失败时记 note 且不抛错', async () => {
  const ctx = ctxWith((async (url: string | URL | Request) => {
    if (String(url).includes('/lottery/summary')) {
      return new Response('gateway error', { status: 502 });
    }
    if (String(url).includes('/redeem')) {
      return new Response(JSON.stringify({ code: 403 }), { status: 403 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const summary = await runStreakManager(TOKEN, ctx);
  assert.deepEqual(summary.redeemed, []);
  assert.equal(summary.draws, 0);
  assert.ok(summary.note);
});
