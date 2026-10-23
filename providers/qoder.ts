import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';

// Qoder CN 签到（逆向自桌面端，三来源交叉验证：dsh-qoder-connect 源码 / wallechfox-qoder-checkin 源码 / 客户端 main.log 抓包）：
//   POST {base}/api/v1/deviceToken/refresh   body { refresh_token }
//     → token（兼容 accessToken / device_token 字段）；每次轮换 refreshToken，但旧值不立即失效
//   GET  {base}/sash/api/v1/me/campaigns   Authorization: Bearer <token> + Cosy-ClientType: 10
//     → campaigns[]：actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE 才领取；CLAIMED 且在窗口内=今日已领
//   POST {base}/sash/api/v1/me/campaigns/<campaignId>/claim   body {}
//     → status=CLAIMED 或 replayed=true 判成功（服务端幂等，重复领取不重复到账）
// 每日奖励 10:00（UTC+8）刷新，每次 100 Credits，领取后 30 天有效。
// 成功路径待真实 token 最终确认（与 workbuddy 上线时同标准）。
const BASE = process.env.QODER_BASE_URL ?? 'https://openapi.qoder.com.cn';

// 设备标识头：Qoder 服务端据 Cosy-MachineToken 等识别设备，缺失时活动列表可能为空（wallechfox 实测）。
// 值从桌面客户端本地提取后经环境变量注入（青龙/CI 场景同理），为空则不发送该头。
// ponytail: 只做环境变量透传，不做客户端本地提取；提取工具链属桌面壳 L2 范畴
const MACHINE_HEADERS: Record<string, string> = {
  QODER_COSY_MACHINE_OS: 'Cosy-MachineOS',
  QODER_COSY_MACHINE_HOSTNAME: 'Cosy-MachineHostname',
  QODER_COSY_MACHINE_ID: 'Cosy-MachineId',
  QODER_COSY_MACHINE_TOKEN: 'Cosy-MachineToken',
  QODER_COSY_MACHINE_CODE: 'Cosy-MachineCode',
  QODER_COSY_MACHINE_TYPE: 'Cosy-MachineType',
  QODER_COSY_VERSION: 'Cosy-Version',
};

function deviceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [env, header] of Object.entries(MACHINE_HEADERS)) {
    const value = process.env[env];
    if (value) headers[header] = value;
  }
  return headers;
}

type JsonBody = {
  token?: string;
  accessToken?: string;
  device_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  message?: string;
  status?: string;
  replayed?: boolean;
  benefit?: unknown;
  campaigns?: unknown[];
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

// 刷新端点按令牌前缀分派（Agent2API 实测）：jrt-（PAT 兑换的作业令牌）与 drt-（设备流）
// 端点不可互换，混用会被判令牌无效；两条路径都只需 body 里的 refresh_token，无需 COSY 签名
function refreshUrl(refreshToken: string): string {
  return refreshToken.startsWith('jrt-')
    ? `${BASE}/api/v1/jobToken/refresh`
    : `${BASE}/api/v1/deviceToken/refresh`;
}

async function refreshAccessToken(
  refreshToken: string,
  ctx: RunContext,
): Promise<{ accessToken: string; rotatedRefreshToken?: string }> {
  const res = await ctx.fetch(refreshUrl(refreshToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const { data, text } = await parseJson(res);
  // 三来源字段形状不一致（token / accessToken / device_token），双路径兼容
  const accessToken = data?.token ?? data?.accessToken ?? data?.device_token;
  if (!accessToken) {
    throw new Error(`refreshToken 刷新失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const rotatedRefreshToken = data?.refreshToken ?? data?.refresh_token;
  return { accessToken, rotatedRefreshToken };
}

function campaignHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder/claim',
    ...deviceHeaders(),
  };
}

// PAT 兑换（Qoder CN 官方文档支持的冷启动路径，Agent2API 实测）：
// 用户在 Qoder 控制台 → 设置 → API 令牌创建 PAT（pt- 前缀，仅显示一次），
// POST /api/v1/jobToken/exchange body { personal_token } → { token, refresh_token }
// 换出的 refresh_token 为 jrt- 前缀，之后刷新走 jobToken/refresh（见 refreshUrl）。
// 该路径无需本地凭证文件解密，macOS / Linux / CI 通用，与 WorkBuddy 插件登录同定位。
export async function exchangePat(
  pat: string,
  ctx: RunContext,
): Promise<{ token: string; refreshToken: string }> {
  if (!pat) throw new Error('PAT 不能为空');
  const res = await ctx.fetch(`${BASE}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ personal_token: pat }),
  });
  const { data, text } = await parseJson(res);
  const token = data?.token;
  const refreshToken = data?.refresh_token ?? data?.refreshToken;
  if (!token || !refreshToken) {
    throw new Error(`PAT 兑换失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return { token, refreshToken };
}

// 账户额度（magpie 实测：PAT 作业令牌可读）：GET /sash/api/v2/me/usage
// 响应 { displayMode:'qoder'|'enterprise', qoderUsage:{ userQuota:{ total|cap, used, remaining } } }
export interface QoderUsage {
  limit: number;
  used: number;
  remain: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function parseQoderUsage(body: unknown): QoderUsage | null {
  const env = (body ?? {}) as Record<string, unknown>;
  if (env.displayMode !== 'qoder') return null;
  const usage = env.qoderUsage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const bucket = (usage.userQuota ?? usage.user_quota) as Record<string, unknown> | undefined;
  if (!bucket) return null;
  const limit = Number(bucket.total ?? bucket.cap);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainRaw = Number(bucket.remaining);
  const usedRaw = Number(bucket.used);
  const remain = Number.isFinite(remainRaw) ? remainRaw : Number.isFinite(usedRaw) ? limit - usedRaw : NaN;
  if (!Number.isFinite(remain) || remain < 0) return null;
  const used = Number.isFinite(usedRaw) ? usedRaw : limit - remain;
  return { limit: round2(limit), used: round2(used), remain: round2(remain) };
}

interface UsageResult {
  usage: QoderUsage | null;
  error?: string; // 仅进 detail，便于排查（不改变签到判定）
}

async function queryUsage(token: string, ctx: RunContext): Promise<UsageResult> {
  try {
    const res = await ctx.fetch(`${BASE}/sash/api/v2/me/usage`, { headers: campaignHeaders(token) });
    const text = await res.text();
    if (!res.ok) return { usage: null, error: `HTTP ${res.status} ${text.slice(0, 160)}` };
    const usage = parseQoderUsage(JSON.parse(text));
    return usage ? { usage } : { usage: null, error: `unparsed ${text.slice(0, 160)}` };
  } catch (err) {
    return { usage: null, error: (err as Error).message };
  }
}

export const qoder: Provider = {
  id: 'qoder',
  name: 'Qoder',
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

    const usageResult = await queryUsage(accessToken, ctx);
    const usage = usageResult.usage;
    const usageSuffix = usage ? `；剩余 ${usage.remain}/${usage.limit}` : '';
    const res = await ctx.fetch(`${BASE}/sash/api/v1/me/campaigns`, {
      headers: campaignHeaders(accessToken),
    });
    const { data, text } = await parseJson(res);
    if (!data) {
      return { ok: false, message: `查询活动失败: HTTP ${res.status}，响应非 JSON: ${text.slice(0, 120)}`, rotatedRefreshToken };
    }
    // campaigns 可能在顶层或 data 下（两来源形态不同）
    const rawCampaigns = (data.campaigns ?? data.data?.campaigns) as JsonBody['campaigns'];
    const campaigns = (rawCampaigns ?? []) as Array<Record<string, unknown>>;
    const benefits = campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT');
    const claimable = benefits.filter((c) => c.claimStatus === 'CLAIMABLE');
    const alreadyClaimed = benefits.some((c) => c.claimStatus === 'CLAIMED');

    if (claimable.length === 0) {
      return {
        ok: true,
        message: `${alreadyClaimed ? '今日已领取（服务端幂等跳过）' : '暂无可领取的签到活动（未开放或已结束）'}${usageSuffix}`,
        detail: { status: res.status, campaigns, usage, usageError: usageResult.error, rotatedRefreshToken },
        rotatedRefreshToken,
      };
    }

    const amounts: number[] = [];
    const errors: string[] = [];
    let replayed = false;
    for (const c of claimable) {
      const campaignId = String(c.campaignId);
      const claimRes = await ctx.fetch(`${BASE}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
        method: 'POST',
        headers: { ...campaignHeaders(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const claim = await parseJson(claimRes);
      // status 可能在顶层或 data 下；replayed=true 为幂等回放（今日已领过）
      const body = (claim.data?.data ?? claim.data) as JsonBody | undefined;
      const success = claimRes.status === 200 && (body?.status === 'CLAIMED' || body?.replayed === true);
      if (success) {
        if (body?.replayed === true) replayed = true;
        // 到账金额只认 claim 响应：回放时没有新积分到账，不能用活动对象的广告金额冒充
        const amount = (body?.benefit as { amount?: number } | undefined)?.amount;
        if (typeof amount === 'number') amounts.push(amount);
      } else {
        errors.push(`${campaignId}: HTTP ${claimRes.status} ${claim.text.slice(0, 80)}`);
      }
    }

    if (errors.length > 0) {
      return {
        ok: false,
        message: `领取失败 ${errors.length}/${claimable.length}: ${errors.join('; ')}`,
        detail: { status: res.status, campaigns, usage, usageError: usageResult.error, rotatedRefreshToken },
        rotatedRefreshToken,
      };
    }
    if (replayed && amounts.length === 0) {
      return {
        ok: true,
        message: `今日已领取（服务端幂等回放）${usageSuffix}`,
        detail: { status: res.status, claimed: claimable.length, campaigns, usage, usageError: usageResult.error, rotatedRefreshToken },
        rotatedRefreshToken,
      };
    }
    const amountText = amounts.length > 0 ? `到账 ${amounts.join('+')} Credits` : '领取成功';
    return {
      ok: true,
      message: `签到成功：${amountText}${usageSuffix}`,
      detail: { status: res.status, claimed: claimable.length, campaigns, usage, usageError: usageResult.error, rotatedRefreshToken },
      rotatedRefreshToken,
    };
  },
};
