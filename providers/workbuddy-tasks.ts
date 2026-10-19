import { randomUUID } from 'node:crypto';
import type { RunContext } from '../core/types.ts';

// WorkBuddy 增值任务（签到之后的「连登管家」与积分查询）。
// 接口来自 workbuddy2api-panel（Go）开源实现的逆向口径，端点已经无效 token 探针确认存在。
//   余额：POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource
//   兑换：POST https://www.workbuddy.cn/v2/activity/growth/redeem   { tier, client_token }
//   抽奖：GET  https://www.workbuddy.cn/v2/activity/growth/lottery/summary → chances
//         POST https://www.workbuddy.cn/v2/activity/growth/lottery/draw     { client_token }
// billing 请求头对齐参考实现的 BillingHeaders（X-CodeBuddy-Request 等）
const USER_RESOURCE_URL = 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource';
const REDEEM_URL = 'https://www.workbuddy.cn/v2/activity/growth/redeem';
const LOTTERY_SUMMARY_URL = 'https://www.workbuddy.cn/v2/activity/growth/lottery/summary';
const LOTTERY_DRAW_URL = 'https://www.workbuddy.cn/v2/activity/growth/lottery/draw';

const BILLING_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language': 'zh-CN',
  'X-CodeBuddy-Request': '1',
  'User-Agent': 'WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/2.63.2',
});

const GROWTH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.workbuddy.cn',
  Referer: 'https://www.workbuddy.cn/',
  'X-Client-Platform': 'web',
  'X-CodeBuddy-Request': '1',
});

// 服务端要求 UTC+8 的 "YYYY-MM-DD HH:mm:ss"
function cnTime(date: Date): string {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// 字段大小写不确定（Go 客户端大小写不敏感解包），两种都试
function pickNum(source: Record<string, number>, ...names: string[]): number {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number') {
      return value;
    }
  }
  return 0;
}

export interface Balance {
  remain: number;
  total: number;
}

export interface BalanceQueryResult {
  balance: Balance | null;
  raw: unknown; // 原始响应，诊断用（--verbose 输出）
}

// 查询积分余额；无有效套餐时 balance 为 null（网络异常由调用方 try/catch 兜底）
// 真实响应结构（已实测）：{ code, msg, data: { Response: { Data: { Accounts: [...] } } } }，
// 字段大小写不确定（Go 客户端大小写不敏感解包），各层都做双形态兼容；
// Status=0 为有效包，3 为已消耗/过期；实测 CycleCapacityRemain 对部分月包不可信，
// 因此 Capacity 字段优先，Cycle 仅作回退
export async function queryBalance(accessToken: string, ctx: RunContext): Promise<BalanceQueryResult> {
  const now = ctx.now;
  const farFuture = new Date(now.getTime() + 101 * 365.25 * 24 * 3600 * 1000);
  const res = await ctx.fetch(USER_RESOURCE_URL, {
    method: 'POST',
    headers: BILLING_HEADERS(accessToken),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: cnTime(now),
      PackageEndTimeRangeEnd: cnTime(farFuture),
    }),
  });
  const raw: unknown = await res.json().catch(() => null);
  const data = (raw as { data?: Record<string, unknown> } | null)?.data ?? {};
  const response = (data.Response ?? data.response ?? {}) as Record<string, unknown>;
  const inner = (response.Data ?? response.data ?? {}) as Record<string, unknown>;
  const accounts = (inner.Accounts ?? inner.accounts ?? data.Accounts ?? data.accounts) as
    | Array<Record<string, number>>
    | undefined;
  const active = Array.isArray(accounts)
    ? accounts.filter((account) => account.Status === undefined || account.Status === 0)
    : [];
  if (active.length === 0) {
    return { balance: null, raw };
  }
  let remain = 0;
  let total = 0;
  for (const account of active) {
    const accountRemain = pickNum(account, 'CapacityRemain', 'capacityRemain', 'CycleCapacityRemain', 'cycleCapacityRemain');
    const accountTotal = pickNum(account, 'CapacitySize', 'capacitySize', 'CycleCapacitySize', 'cycleCapacitySize');
    remain += Math.max(0, Math.min(accountRemain, accountTotal));
    total += accountTotal;
  }
  return { balance: total > 0 ? { remain, total } : null, raw };
}

export interface StreakSummary {
  redeemed: string[]; // 成功兑换的档位
  draws: number; // 成功抽奖次数
  attempts: Array<{ tier: string; ok: boolean; status: number }>; // 兑换尝试明细（诊断用）
  note?: string; // 降级说明
}

const TIERS = ['7d', '14d', '28d'];
const MAX_DRAWS_PER_RUN = 10; // ponytail: 单次抽奖上限，防服务端 chances 异常导致死循环

// 连登管家：尝试兑换全部档位（403=未解锁，跳过），再把抽奖次数抽完。
// 任何单步失败都降级不抛出——签到主流程不受影响
export async function runStreakManager(accessToken: string, ctx: RunContext): Promise<StreakSummary> {
  const redeemed: string[] = [];
  const attempts: Array<{ tier: string; ok: boolean; status: number }> = [];
  for (const tier of TIERS) {
    let ok = false;
    let status = 0;
    try {
      const res = await ctx.fetch(REDEEM_URL, {
        method: 'POST',
        headers: GROWTH_HEADERS(accessToken),
        body: JSON.stringify({ tier, client_token: randomUUID() }),
      });
      status = res.status;
      const json = (await res.json().catch(() => null)) as { code?: number } | null;
      ok = res.ok && (json === null || json.code === 0);
      if (ok) {
        redeemed.push(tier);
      }
    } catch {
      ok = false;
    }
    attempts.push({ tier, ok, status });
  }

  let draws = 0;
  let note: string | undefined;
  try {
    const res = await ctx.fetch(LOTTERY_SUMMARY_URL, {
      method: 'GET',
      headers: GROWTH_HEADERS(accessToken),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: { chances?: number; module?: { enabled?: boolean } };
    } | null;
    const chances = json?.data?.chances ?? 0;
    const enabled = json?.data?.module?.enabled ?? false;
    if (res.ok && enabled && chances > 0) {
      const count = Math.min(chances, MAX_DRAWS_PER_RUN);
      for (let i = 0; i < count; i++) {
        const drawRes = await ctx.fetch(LOTTERY_DRAW_URL, {
          method: 'POST',
          headers: GROWTH_HEADERS(accessToken),
          body: JSON.stringify({ client_token: randomUUID() }),
        });
        if (drawRes.ok) {
          draws++;
        }
      }
    } else if (!res.ok) {
      note = '抽奖状态获取失败';
    }
  } catch {
    note = '抽奖状态获取失败';
  }
  return { redeemed, draws, attempts, note };
}
