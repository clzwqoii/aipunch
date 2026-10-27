import { createHash, randomUUID } from 'node:crypto';
import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';

// AutoClaw（智谱 Z.ai 的 OpenClaw 一键部署客户端）每日签到。
// 契约双来源交叉验证：CencYun/agent2api（2026-09-19 实测）与 Zhengyuuuui/autoclaw2api
// （2026-09-22 逆向桌面端 1.18.5 bundle）；短信登录契约为单来源（autoclaw2api），
// 成功路径待真实 token 最终确认。
//   POST {userapi}/autoclaw-proxy/proxy/autoclaw-task-complete  body {"task_id":"daily_signin"}
//     code=0 且 (reward_points>0 || (success && !already_completed)) = 本次领到；
//     already_completed=true = 今日已签（服务端按天幂等）；410000/401 = 登录态过期；
//     400002 = 签名校验失败；429 = 限流
//   POST {userapi}/userapi/v1/refresh  body {refresh_token, source_id:"autoclaw"}
//     400002 时降级 POST /userapi/v1/agent-refresh；响应 data.access_token/refresh_token
// 签名头（桌面端客户端指纹，非本项目密钥）：X-Auth-Sign = MD5("{appId}&{ts}&{appKey}")，ts 为秒
const APP_ID = '100003';
const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5';
const CLIENT_VERSION = '1.18.5';
// 双区域：CN 与 Intl 是两套账号体系与主机（Agent2API 同款两 Provider 建模，
// 避免地区沦为账号属性导致串号）；CN 与 Intl Provider 可并存。
const CN_BASE = 'https://autoglm-acceleration-api.zhipuai.cn';
const INTL_BASE = 'https://autoglm-api.autoglm.ai';

function resolveBase(envName: string, fallback: string): string {
  return process.env[envName] ?? fallback;
}

// 短信登录仅国内版支持（国际版登录是 Zai/Google OAuth，且有阿里云风控验证码，
// 纯 CLI 无法自动化，凭证走环境变量注入）
function cnBase(): string {
  return resolveBase('AUTOCLAW_USERAPI_BASE_URL', CN_BASE);
}

// 国际版官方登录返回 "Bearer <JWT>" 形态，直接用会出现 "Bearer Bearer ..." / 刷新被拒
function normalizeToken(value: string | undefined): string {
  return (value ?? '').replace(/^Bearer\s+/i, '').trim();
}

// 刷新令牌与签发时的设备绑定（JWT 内有 device_id）；刷新必须回传同一个，否则 400001
function deviceIdOf(refreshToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(refreshToken.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    return typeof payload.device_id === 'string' ? payload.device_id : '';
  } catch {
    return '';
  }
}

export function signedHeaders(token: string, opts: { web?: boolean } = {}): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = createHash('md5').update(`${APP_ID}&${ts}&${APP_KEY}`).digest('hex');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Version': opts.web ? '1.12.1' : CLIENT_VERSION,
    'X-Tm': opts.web ? 'web' : process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux',
    'X-Product': 'autoclaw',
    'X-Client-Type': opts.web ? 'web' : 'pc',
    'X-Channel': 'official',
    'X-Harness-Type': 'zcode',
    'X-Lang': 'zh-CN',
    'X-Auth-Appid': APP_ID,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// 积分余额（magpie 实测）：GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw
// 响应 { code:0, data:{ total_balance, wallets[] } }
const WALLETS_PATH = '/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw';

// 登录奖励（CN +10000 / Intl +4000 这类活动福利）**没有领取接口**：
// 服务端在客户端启动动作 POST /userapi/v1/user-info 时按活跃自动入账
// （Agent2API 2026-10-15 逐条实测：签到、refresh、home-fetch 都不触发，只有 user-info 会）。
// 入账后从积分流水确认：只取入账方向，按 metadata.event_type 前缀识别活动入账。
const USER_INFO_PATH = '/userapi/v1/user-info';
const LEDGERS_PATH =
  '/agent-assetmgr/api/v1/ledgers_std?asset_type=point&wallet_type=all&cursor=&page_size=50&flow_direction=income';
const PROMOTION_EVENT_PREFIXES = ['autoclaw_user_active', 'autoclaw_user_signup_day'];
const PROMOTION_ACTIVITY_PREFIXES = [
  'autoclaw_user_active_reward',
  'autoclaw_user_active_bonus',
  'autoclaw_new_user_day_1_to_7_bonus',
];

// 北京自然日（流水 grant_date 即北京日期；北京无 DST，+8h 取 UTC 日期）
function beijingDateKey(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

// 触发「登录活跃」：失败不影响签到（活动福利是附加收益，不能升级成签到失败）
async function triggerLoginActive(token: string, base: string, deviceId: string, ctx: RunContext): Promise<boolean> {
  try {
    const res = await ctx.fetch(`${base}${USER_INFO_PATH}`, {
      method: 'POST',
      headers: signedHeaders(token),
      body: JSON.stringify({ source_id: 'autoclaw', device_id: deviceId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 今日活动福利合计（登录奖励等）；查不到返回 null，不计入结论
async function queryTodayPromotion(token: string, base: string, ctx: RunContext): Promise<number | null> {
  try {
    const res = await ctx.fetch(`${base}${LEDGERS_PATH}`, { headers: signedHeaders(token) });
    if (!res.ok) return null;
    const { data } = await parseJson(res);
    const entries = (data?.data as { entries?: unknown } | undefined)?.entries;
    if (!Array.isArray(entries)) return null;
    const today = beijingDateKey(ctx.now.getTime());
    const total = entries.reduce((sum, entry) => {
      const e = entry as { amount?: unknown; metadata?: Record<string, unknown> };
      const meta = e.metadata ?? {};
      // event_time 才是入账时刻（epoch 秒）；grant_date 是活动周期键，会比实际入账早一天
      const eventMs = Number(meta.event_time) * 1000;
      const entryDate =
        Number.isFinite(eventMs) && eventMs > 0
          ? beijingDateKey(eventMs)
          : String(meta.grant_date ?? '');
      if (entryDate !== today) return sum;
      const eventType = String(meta.event_type ?? '');
      const activityId = String(meta.activity_id ?? '');
      const hit =
        PROMOTION_EVENT_PREFIXES.some((p) => eventType.startsWith(p)) ||
        PROMOTION_ACTIVITY_PREFIXES.some((p) => activityId.startsWith(p));
      const amount = Number(e.amount);
      return hit && Number.isFinite(amount) ? sum + amount : sum;
    }, 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

export function parseAutoclawBalance(body: unknown): { remain: number } | null {
  const root = (body ?? {}) as { code?: unknown; data?: Record<string, unknown> };
  if (root.code !== undefined && Number(root.code) !== 0) return null;
  const total = Number(root.data?.total_balance);
  if (!Number.isFinite(total)) return null;
  return { remain: Math.round(total * 100) / 100 };
}

interface SigninStatus {
  status: string;
  reward: number;
}

async function querySigninStatus(token: string, base: string, ctx: RunContext): Promise<SigninStatus | null> {
  try {
    const res = await ctx.fetch(`${base}/autoclaw-proxy/proxy/autoclaw-task-list`, { headers: signedHeaders(token) });
    if (!res.ok) return null;
    const { data } = await parseJson(res);
    const tasks = (data?.data as unknown[] | undefined) ?? [];
    if (!Array.isArray(tasks)) return null;
    const task = tasks.find((t) => (t as Record<string, unknown>)?.task_id === 'daily_signin') as
      | Record<string, unknown>
      | undefined;
    if (!task) return null;
    return { status: String(task.status ?? ''), reward: Number(task.reward_points) || 0 };
  } catch {
    return null;
  }
}

interface BalanceResult {
  balance: { remain: number } | null;
  error?: string; // 仅进 detail（verbose 可见），不影响签到判定
}

async function queryBalance(token: string, base: string, ctx: RunContext): Promise<BalanceResult> {
  try {
    const res = await ctx.fetch(`${base}${WALLETS_PATH}`, { headers: signedHeaders(token) });
    const { data, text } = await parseJson(res);
    const balance = parseAutoclawBalance(data);
    return { balance, error: balance ? undefined : `HTTP ${res.status} ${text.slice(0, 200)}` };
  } catch (err) {
    return { balance: null, error: (err as Error).message };
  }
}

type JsonBody = {
  code?: number;
  msg?: string;
  message?: string;
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

// 发送短信验证码（登录第一步；device_id 为客户端生成的任意 UUID，仅作指纹）
export async function sendSmsCode(phone: string, ctx: RunContext): Promise<void> {
  const res = await ctx.fetch(`${cnBase()}/userapi/v1/agent-send-code`, {
    method: 'POST',
    headers: signedHeaders('', { web: true }),
    body: JSON.stringify({ source_id: 'autoclaw', device_id: randomUUID(), phone }),
  });
  const { data } = await parseJson(res);
  if (!data || data.code !== 0) {
    throw new Error(`验证码发送失败: ${data?.msg ?? `HTTP ${res.status}`}`);
  }
}

// 手机号 + 验证码换取 accessToken / refreshToken（登录第二步）
export async function loginWithSms(
  phone: string,
  smsCode: string,
  ctx: RunContext,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await ctx.fetch(`${cnBase()}/userapi/v1/agent-login/`, {
    method: 'POST',
    headers: signedHeaders('', { web: true }),
    body: JSON.stringify({
      source_id: 'autoclaw',
      device_id: randomUUID(),
      phone,
      code: Number(smsCode),
      platform: 'web',
    }),
  });
  const { data } = await parseJson(res);
  if (!data || data.code !== 0) {
    throw new Error(`登录失败: ${data?.msg ?? `HTTP ${res.status}`}`);
  }
  const payload = data.data ?? {};
  const accessToken = (payload.access_token as string | undefined) ?? '';
  const refreshToken = (payload.refresh_token as string | undefined) ?? '';
  if (!accessToken) {
    throw new Error('登录响应缺少 access_token');
  }
  return { accessToken, refreshToken };
}

async function refreshAccessToken(
  refreshToken: string,
  ctx: RunContext,
  baseUrl: string,
): Promise<{ accessToken: string; rotatedRefreshToken?: string }> {
  const normalized = normalizeToken(refreshToken);
  const deviceId = process.env.AUTOCLAW_DEVICE_ID ?? process.env.AUTOCLAW_INTL_DEVICE_ID ?? deviceIdOf(normalized);
  const body = JSON.stringify({
    refresh_token: normalized,
    source_id: 'autoclaw',
    ...(deviceId ? { device_id: deviceId } : {}),
  });
  const call = (path: string) =>
    ctx.fetch(`${baseUrl}${path}`, { method: 'POST', headers: signedHeaders(''), body });
  let res = await call('/userapi/v1/refresh');
  let { data, text } = await parseJson(res);
  // 400002 = 签名校验失败：降级 agent-refresh 再试一次（autoclaw2api 同款策略）
  if (data?.code === 400002) {
    res = await call('/userapi/v1/agent-refresh');
    ({ data, text } = await parseJson(res));
  }
  const payload = data?.data as { access_token?: string; refresh_token?: string } | undefined;
  const accessToken = payload?.access_token;
  if (!data || data.code !== 0 || !accessToken) {
    throw new Error(`refreshToken 刷新失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return { accessToken: normalizeToken(accessToken), rotatedRefreshToken: normalizeToken(payload?.refresh_token) || undefined };
}

function createAutoClawProvider(id: string, name: string, baseUrl: () => string): Provider {
  return {
    id,
    name,
    async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    let accessToken = normalizeToken(account.token);
    let rotatedRefreshToken: string | undefined;
    if (account.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(account.refreshToken, ctx, baseUrl());
        accessToken = refreshed.accessToken;
        rotatedRefreshToken = refreshed.rotatedRefreshToken;
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    }
    if (!accessToken) {
      return { ok: false, message: '账号缺少 token：需要 tokenEnv 或 refreshTokenEnv' };
    }

    // 先「登录」再签到：登录奖励只在 user-info 上入账，签到接口不会触发它
    const deviceId = account.refreshToken ? deviceIdOf(account.refreshToken) : '';
    await triggerLoginActive(accessToken, baseUrl(), deviceId, ctx);

    // 成功结论统一走这里：附带今日活动福利（登录奖励）到账合计
    const finish = async (
      message: string,
      skipped?: boolean,
      detail?: Record<string, unknown>,
    ): Promise<CheckinResult> => {
      const promotion = await queryTodayPromotion(accessToken, baseUrl(), ctx);
      const suffix = promotion ? `（登录奖励 +${promotion} 已到账）` : '';
      return {
        ok: true,
        message: `${message}${suffix}`,
        skipped,
        detail: { ...detail, promotion },
        rotatedRefreshToken,
      };
    };

    const balanceResult = await queryBalance(accessToken, baseUrl(), ctx);
    const balance = balanceResult.balance;
    const balanceSuffix = balance ? `；剩余 ${balance.remain} 积分` : '';

    // 先查任务状态：已完成就不发 claim（避免重复请求与风控噪声）
    const signinStatus = await querySigninStatus(accessToken, baseUrl(), ctx);
    if (signinStatus?.status === 'completed') {
      return finish(
        `今日已签到（状态确认）${balanceSuffix}`,
        true,
        { status: 'completed', signinStatus, balance, balanceError: balanceResult.error },
      );
    }

    const res = await ctx.fetch(`${baseUrl()}/autoclaw-proxy/proxy/autoclaw-task-complete`, {
      method: 'POST',
      headers: signedHeaders(accessToken),
      body: JSON.stringify({ task_id: 'daily_signin' }),
    });
    const { data, text } = await parseJson(res);
    const payload = (data?.data ?? {}) as Record<string, unknown>;
    const code = data?.code;
    const msg = data?.msg ?? data?.message ?? '';

    // 410000/401：登录态过期；400002：签名校验失败（客户端指纹不匹配）
    if (code === 410000 || code === 401 || res.status === 401) {
      return { ok: false, message: `登录态已过期: ${msg || `code=${code}`}`, rotatedRefreshToken };
    }
    if (code === 400002) {
      return { ok: false, message: `签名校验失败（code=400002）: ${msg}`, rotatedRefreshToken };
    }
    if (res.status === 429) {
      return { ok: false, message: '触发限流（429），下轮重试', rotatedRefreshToken };
    }
    // 成功判定：code=0，或 code 缺失但 data 为非空对象（与桌面端 completeClientTask 一致）
    if (code !== 0 && !(code === undefined && Object.keys(payload).length > 0)) {
      return { ok: false, message: `签到失败: code=${code} ${msg || text.slice(0, 80)}`, rotatedRefreshToken };
    }

    const alreadyCompleted = payload.already_completed === true;
    const rewardPoints = typeof payload.reward_points === 'number' ? payload.reward_points : 0;
    if (alreadyCompleted || rewardPoints === 0) {
      return finish(
        `${alreadyCompleted ? '今日已签到（服务端幂等跳过）' : '签到成功（本次无积分奖励）'}${balanceSuffix}`,
        // 真签到但无奖励不是幂等跳过，不标 skipped
        alreadyCompleted || undefined,
        { status: res.status, body: data, balance, balanceError: balanceResult.error },
      );
    }
    return finish(`签到成功：+${rewardPoints} 积分${balanceSuffix}`, undefined, {
      status: res.status,
      body: data,
      balance,
      balanceError: balanceResult.error,
    });
    },
  };
}

// 国内版（autoclaw.zhipuai.cn / 短信登录）与国际版（autoclaw.z.ai / Zai·Google OAuth）
// 的 API 契约同构、仅主机不同；两 Provider 可并存（Agent2API 同款两 Provider 建模）。
export function autoclawIntlBase(): string {
  return resolveBase('AUTOCLAW_INTL_USERAPI_BASE_URL', INTL_BASE);
}

export const autoclaw = createAutoClawProvider('autoclaw', 'AutoClaw', () =>
  resolveBase('AUTOCLAW_USERAPI_BASE_URL', CN_BASE),
);
export const autoclawIntl = createAutoClawProvider('autoclaw-intl', 'AutoClaw 国际版', autoclawIntlBase);
