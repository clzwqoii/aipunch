import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';

// 商汤小浣熊每日积分（登录触发型，契约来源 CencYun/agent2api，2026-09 实测）：
// 每日积分由桌面客户端调用 setting_info 时按天幂等触发，再用积分账单核对到账——
// 所谓「自动到账」是客户端代劳，API 层面可自动化（用户一手账本实证需登录才拿得到）。
//   POST {origin}/api/web/auth/v1/refresh   body { refresh_token } → data.access_token / data.refresh_token
//   GET  {origin}/api/web/office/v3/setting_info   桌面客户端头，按天幂等触发发放
//   GET  {origin}/api/web/points/v1/bills?paging.limit=20&paging.offset=0   核对今日账本积分入账
// 成功判据是「今日账单确有积分入账」而非 HTTP 状态（Agent2API 同款口径，不谎报成功）。
// 冷启动：~/.box-agent/config/auth.json 明文（access_token/refresh_token，全平台无需解密）。
const ORIGIN = process.env.RACCOON_MAIN_SITE_URL ?? 'https://xiaohuanxiong.com';
const AUTH_BASE = `${ORIGIN}/api/web/auth/v1`;
const SETTING_INFO_URL = `${ORIGIN}/api/web/office/v3/setting_info`;
// 窗口取 100：活跃账号几分钟就能烧掉 20 条消耗账单，会把赠送条目挤出窗口（实测）
const BILLS_URL = `${ORIGIN}/api/web/points/v1/bills?paging.limit=100&paging.offset=0`;
const CLIENT_HEADERS = {
  'X-Client-Platform': 'desktop-windows',
  'X-Client-Version': 'v1.0.0',
  'X-Raccoon-Language': 'zh',
};

type JsonBody = {
  code?: number;
  message?: string;
  msg?: string;
  access_token?: string;
  refresh_token?: string;
  data?: Record<string, unknown>;
};

async function parseJson(res: Response): Promise<{ data: JsonBody | null; text: string }> {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

async function refreshAccessToken(
  refreshToken: string,
  ctx: RunContext,
): Promise<{ accessToken: string; rotatedRefreshToken?: string }> {
  const res = await ctx.fetch(`${AUTH_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const { data, text } = await parseJson(res);
  const payload = data?.data as { access_token?: string; refresh_token?: string } | undefined;
  const accessToken = payload?.access_token;
  if (res.status === 401 || !accessToken) {
    throw new Error(`refreshToken 刷新失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  // 轮换容忍：响应不带新 refresh_token 时沿用旧值（不透出轮换）
  const rotated = payload?.refresh_token;
  return { accessToken, rotatedRefreshToken: rotated && rotated !== refreshToken ? rotated : undefined };
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const raccoon: Provider = {
  id: 'raccoon',
  name: '商汤小浣熊',
  async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    let accessToken = account.token;
    let rotatedRefreshToken: string | undefined;
    if (account.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(account.refreshToken, ctx);
        accessToken = refreshed.accessToken;
        rotatedRefreshToken = refreshed.rotatedRefreshToken;
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    }
    if (!accessToken) {
      return { ok: false, message: '账号缺少 token：需要 tokenEnv 或 refreshTokenEnv' };
    }

    // 第一步：触发每日积分发放（按天幂等，重复调用不重复发放）
    const triggerRes = await ctx.fetch(SETTING_INFO_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...CLIENT_HEADERS },
    });
    const trigger = await parseJson(triggerRes);
    if (!trigger.data) {
      return {
        ok: false,
        message: `触发失败: HTTP ${triggerRes.status} ${trigger.text.slice(0, 100)}`,
        rotatedRefreshToken,
      };
    }

    // 第二步：核对今日账本确有积分入账（成功判据是实收，不是 HTTP 状态）
    const billsRes = await ctx.fetch(BILLS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    const bills = await parseJson(billsRes);
    if (!bills.data) {
      return {
        ok: false,
        message: `账本核对失败: HTTP ${billsRes.status} ${bills.text.slice(0, 100)}`,
        detail: { trigger: trigger.data },
        rotatedRefreshToken,
      };
    }
    const items = (bills.data.data?.items ?? []) as Array<Record<string, unknown>>;
    const today = localDate(ctx.now);
    const todayPoints = items
      .filter((item) => Number(item.points) > 0 && String(item.created_at ?? '').slice(0, 10) === today)
      .reduce((sum, item) => sum + Number(item.points), 0);

    if (todayPoints <= 0) {
      return {
        ok: false,
        message: '触发后今日账本无积分入账（未生效，下轮重试）',
        detail: { trigger: trigger.data, bills: bills.data },
        rotatedRefreshToken,
      };
    }
    return {
      ok: true,
      message: `每日积分已到账：+${todayPoints} 积分`,
      detail: { trigger: trigger.data, todayPoints, rotatedRefreshToken },
      rotatedRefreshToken,
    };
  },
};
