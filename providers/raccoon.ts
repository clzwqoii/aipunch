import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';

// 商汤小浣熊每日积分（登录触发型，2026-10-19 用户账本实证 + 2026-10-24 复测）：
// 每日积分 00:00 无条件自动发放（当日清零）；**当天有登录动作时有效期延长至 7 天**。
// 积分本身闭眼发，「签到」的真正价值是延长有效期——所以成功判据是
// 最新 daily_grant 条目的 expire_at − grant_at 档位（当日清零 ≈ 86399s，延效 ≈ 604799s），
// 而非「今日有入账」（那只证明发放存在，不证明延效）。纯时长差值判定，零时区依赖。
// 登录动作的归因未定（setting_info / refresh / 独立登录事件），当前组合拳一次全覆盖：
// token 直用（能不刷新就不刷新，凭证与桌面客户端共享会话）→ setting_info（桌面客户端头）→ bills 核对。
// 组合不生效时再按 setting_info-only / refresh-only 做归因实验（实验日不可碰客户端）。
//   POST {origin}/api/web/auth/v1/refresh   body { refresh_token } → data.access_token / data.refresh_token
//   GET  {origin}/api/web/office/v3/setting_info   桌面客户端头，客户端启动即调（Agent2API desktop-grant 链 + dsh-our-free-model #430 双来源确认）
//   GET  {origin}/api/web/points/v1/bills?paging.limit=100&paging.offset=0   核对延效档位
// 冷启动：npm run raccoon-extract 读 ~/.box-agent/config/auth.json 明文写 .env。
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
// 延效下限：超过 2 天视为「已延长」（实测只有两档：86399s / 604799s，2 天居中即可）
const EXTENDED_MIN_MS = 48 * 3600_000;

// 北京时间自然日（上游按 UTC+8 零点发放；北京无夏令时，+8h 后取 UTC 日期即为北京日期）。
// 不能用时长护栏代替：昨天那条延效记录距今不足 48h，会把昨天的延效谎报成今天成功。
function beijingDateKey(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

type JsonBody = {
  code?: number;
  message?: string;
  msg?: string;
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

export const raccoon: Provider = {
  id: 'raccoon',
  name: '商汤小浣熊',
  async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    let accessToken = account.token;
    let rotatedRefreshToken: string | undefined;
    if (!accessToken && !account.refreshToken) {
      return { ok: false, message: '账号缺少凭证：需要 tokenEnv 或 refreshTokenEnv' };
    }
    // 只有 refreshToken 时直接先换（access token 实测存活 ≥7 天，为空时没必要先打一发注定 401 的）
    if (!accessToken && account.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(account.refreshToken, ctx);
        accessToken = refreshed.accessToken;
        rotatedRefreshToken = refreshed.rotatedRefreshToken;
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    }

    // 第一步：setting_info 触发（token 直用；401/403 才刷新重试一次）
    const triggerOnce = () =>
      ctx.fetch(SETTING_INFO_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...CLIENT_HEADERS },
      });
    let triggerRes = await triggerOnce();
    if ((triggerRes.status === 401 || triggerRes.status === 403) && account.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(account.refreshToken, ctx);
        accessToken = refreshed.accessToken;
        rotatedRefreshToken = refreshed.rotatedRefreshToken;
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      triggerRes = await triggerOnce();
    }
    const trigger = await parseJson(triggerRes);
    if (!trigger.data) {
      return {
        ok: false,
        message: `触发失败: HTTP ${triggerRes.status} ${trigger.text.slice(0, 100)}`,
        rotatedRefreshToken,
      };
    }
    if (trigger.data.code !== 0) {
      return {
        ok: false,
        message: `触发失败: code=${trigger.data.code} ${trigger.data.message ?? trigger.data.msg ?? ''}`.trim(),
        rotatedRefreshToken,
      };
    }

    // 第二步：bills 核对最新 daily_grant 的延效档位（成功判据是有效期被延长，不是有入账）
    const billsRes = await ctx.fetch(BILLS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    const bills = await parseJson(billsRes);
    if (!bills.data || bills.data.code !== 0) {
      return {
        ok: false,
        message: `账本核对失败: HTTP ${billsRes.status} ${String(bills.data?.message ?? bills.text).slice(0, 100)}`,
        detail: { trigger: trigger.data },
        rotatedRefreshToken,
      };
    }
    const items = (bills.data.data?.items ?? []) as Array<Record<string, unknown>>;
    // 账单按 created_at 倒序，首条 daily_grant 即最新发放
    const latest = items.find((item) => item.biz_type === 'daily_grant') as
      | { points?: unknown; created_at?: unknown; grant_at?: unknown; expire_at?: unknown }
      | undefined;
    if (!latest) {
      return {
        ok: false,
        message: '账单窗口内无每日发放（daily_grant）记录',
        detail: { trigger: trigger.data },
        rotatedRefreshToken,
      };
    }
    const grantAt = Date.parse(String(latest.grant_at ?? ''));
    const expireAt = Date.parse(String(latest.expire_at ?? ''));
    // created_at 带 +08:00 偏移，前 10 位即北京日期；服务端的当日行可能惰性创建，
    // 「今天有没有发放」只能按这条记录的创建日判定（不看 now 与 grant_at 的时长差）
    const createdDate = String(latest.created_at ?? '').slice(0, 10);
    const today = beijingDateKey(ctx.now.getTime());
    if (!Number.isFinite(grantAt) || !Number.isFinite(expireAt) || !createdDate) {
      return {
        ok: false,
        message: `发放记录缺少 created_at/grant_at/expire_at: ${JSON.stringify(latest).slice(0, 120)}`,
        detail: { trigger: trigger.data },
        rotatedRefreshToken,
      };
    }
    if (createdDate !== today) {
      return {
        ok: false,
        message: `今日未发放：最新发放记录创建于 ${createdDate}（不是今天 ${today}）——登录触发性未生效，次日重试`,
        detail: { trigger: trigger.data, latestGrant: latest },
        rotatedRefreshToken,
      };
    }
    const validMs = expireAt - grantAt;
    if (validMs < EXTENDED_MIN_MS) {
      return {
        ok: false,
        message: `有效期未延长（当日至 ${String(latest.expire_at)} 清零）——登录触发性未生效，明日重试`,
        detail: { trigger: trigger.data, latestGrant: latest },
        rotatedRefreshToken,
      };
    }
    return {
      ok: true,
      message: `每日积分 +${Number(latest.points ?? 0)} 已发放，有效期已延长至 ${String(latest.expire_at)}`,
      detail: { trigger: trigger.data, latestGrant: latest },
      rotatedRefreshToken,
    };
  },
};
