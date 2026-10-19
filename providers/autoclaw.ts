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

function signedHeaders(token: string, opts: { web?: boolean } = {}): Record<string, string> {
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
  const body = JSON.stringify({ refresh_token: refreshToken, source_id: 'autoclaw' });
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
  return { accessToken, rotatedRefreshToken: payload?.refresh_token };
}

function createAutoClawProvider(id: string, name: string, baseUrl: () => string): Provider {
  return {
    id,
    name,
    async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    let accessToken = account.token;
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
      return {
        ok: true,
        message: alreadyCompleted ? '今日已签到（服务端幂等跳过）' : '签到成功（本次无积分奖励）',
        detail: { status: res.status, body: data, rotatedRefreshToken },
        rotatedRefreshToken,
      };
    }
    return {
      ok: true,
      message: `签到成功：+${rewardPoints} 积分`,
      detail: { status: res.status, body: data, rotatedRefreshToken },
      rotatedRefreshToken,
    };
    },
  };
}

// 国内版（autoclaw.zhipuai.cn / 短信登录）与国际版（autoclaw.z.ai / Zai·Google OAuth）
// 的 API 契约同构、仅主机不同；两 Provider 可并存（Agent2API 同款两 Provider 建模）。
export const autoclaw = createAutoClawProvider('autoclaw', 'AutoClaw', () =>
  resolveBase('AUTOCLAW_USERAPI_BASE_URL', CN_BASE),
);
export const autoclawIntl = createAutoClawProvider('autoclaw-intl', 'AutoClaw 国际版', () =>
  resolveBase('AUTOCLAW_INTL_USERAPI_BASE_URL', INTL_BASE),
);
