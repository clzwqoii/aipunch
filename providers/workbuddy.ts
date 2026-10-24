import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';
import { queryBalance, runStreakManager } from './workbuddy-tasks.ts';
import type { Balance, StreakSummary } from './workbuddy-tasks.ts';

// WorkBuddy 签到接口（逆向自桌面端，已多方实测）：
//   POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
//   Authorization: Bearer <accessToken>，body {}
//   code=0 成功；code=10001 今日已签到（服务端幂等）
// 刷新接口（端点与请求头已经无效 token 探测确认；成功响应形状以真实 token 为准）：
//   POST https://www.codebuddy.cn/v2/plugin/auth/token/refresh
//   X-Refresh-Token / X-Auth-Refresh-Source: plugin / X-Domain: copilot.tencent.com
//   每次刷新会轮换 refreshToken（旧值作废），轮换值通过 CheckinResult.rotatedRefreshToken 透出
// 登录接口（官方插件登录，已探测确认；新版客户端加密登录态后的推荐凭证来源）：
//   POST https://www.workbuddy.cn/v2/plugin/login/send-sms   body { phone }
//   POST https://www.workbuddy.cn/v2/plugin/login/token      body { login_method:'phone', phone, sms_code }
const DAILY_CHECKIN_URL = 'https://www.codebuddy.cn/v2/billing/meter/daily-checkin';
const REFRESH_URL = 'https://www.codebuddy.cn/v2/plugin/auth/token/refresh';
const LOGIN_BASE = 'https://www.workbuddy.cn';
const BROWSER_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: LOGIN_BASE,
  Referer: `${LOGIN_BASE}/`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Safari/537.36',
};

type JsonBody = {
  code?: number;
  msg?: string;
  message?: string;
  accessToken?: string;
  refreshToken?: string;
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
  const res = await ctx.fetch(REFRESH_URL, {
    method: 'POST',
    headers: {
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': 'copilot.tencent.com',
    },
    body: JSON.stringify({}),
  });
  const { data, text } = await parseJson(res);
  const accessToken = data?.accessToken ?? (data?.data?.accessToken as string | undefined);
  if (!accessToken) {
    throw new Error(`refreshToken 刷新失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const rotatedRefreshToken = data?.refreshToken ?? (data?.data?.refreshToken as string | undefined);
  return { accessToken, rotatedRefreshToken };
}

// 发送短信验证码（官方插件登录流程第一步）
export async function sendSmsCode(phone: string, ctx: RunContext): Promise<void> {
  const res = await ctx.fetch(`${LOGIN_BASE}/v2/plugin/login/send-sms`, {
    method: 'POST',
    headers: BROWSER_HEADERS,
    body: JSON.stringify({ phone }),
  });
  const { data } = await parseJson(res);
  if (!data || data.code !== 0) {
    throw new Error(`验证码发送失败: ${data?.msg ?? `HTTP ${res.status}`}`);
  }
}

// 手机号 + 验证码换取 accessToken / refreshToken（官方插件登录流程第二步）
export async function loginWithSms(
  phone: string,
  smsCode: string,
  ctx: RunContext,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await ctx.fetch(`${LOGIN_BASE}/v2/plugin/login/token`, {
    method: 'POST',
    headers: BROWSER_HEADERS,
    body: JSON.stringify({ login_method: 'phone', phone, sms_code: smsCode }),
  });
  const { data } = await parseJson(res);
  if (!data || data.code !== 0) {
    throw new Error(`登录失败: ${data?.msg ?? `HTTP ${res.status}`}`);
  }
  const payload = data.data ?? {};
  const accessToken = (payload.accessToken as string | undefined) ?? (payload.access_token as string | undefined) ?? '';
  const refreshToken = (payload.refreshToken as string | undefined) ?? (payload.refresh_token as string | undefined) ?? '';
  if (!accessToken || !refreshToken) {
    throw new Error('登录响应缺少 accessToken / refreshToken');
  }
  return { accessToken, refreshToken };
}

export const workbuddy: Provider = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    let accessToken = account.token;
    let rotationWarning = '';
    let rotatedRefreshToken: string | undefined;
    if (account.refreshToken) {
      let refreshed: { accessToken: string; rotatedRefreshToken?: string };
      try {
        refreshed = await refreshAccessToken(account.refreshToken, ctx);
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      accessToken = refreshed.accessToken;
      if (refreshed.rotatedRefreshToken && refreshed.rotatedRefreshToken !== account.refreshToken) {
        rotatedRefreshToken = refreshed.rotatedRefreshToken;
        rotationWarning = '（refreshToken 已轮换）';
      }
    }
    if (!accessToken) {
      return { ok: false, message: '账号缺少 token：需要 tokenEnv 或 refreshTokenEnv' };
    }

    // 签到前余额（用于积分到账对比；失败不阻断主流程）
    let balanceBefore: Balance | null = null;
    let balanceBeforeRaw: unknown = null;
    try {
      const queried = await queryBalance(accessToken, ctx);
      balanceBefore = queried.balance;
      balanceBeforeRaw = queried.raw;
    } catch {
      balanceBefore = null;
    }

    const res = await ctx.fetch(DAILY_CHECKIN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const { data, text } = await parseJson(res);
    if (!data) {
      return { ok: false, message: `HTTP ${res.status}，响应非 JSON: ${text.slice(0, 200)}` };
    }
    const code = data.code;
    const message = data.message ?? data.msg ?? '';

    // 签到成功（含幂等已签）后的增值动作：积分对比 + 连登管家，全部降级不抛错
    // skipped=true 表示本轮为幂等跳过（今日已签），无新领取动作
    const finalizeSuccess = async (base: string, skipped = false): Promise<CheckinResult> => {
      const parts = [base];
      let balanceAfter: Balance | null = null;
      let balanceAfterRaw: unknown = null;
      try {
        const queried = await queryBalance(accessToken, ctx);
        balanceAfter = queried.balance;
        balanceAfterRaw = queried.raw;
      } catch {
        balanceAfter = null;
      }
      if (balanceBefore && balanceAfter) {
        parts.push(`积分 ${balanceBefore.remain}→${balanceAfter.remain}`);
      } else if (balanceAfter) {
        parts.push(`当前积分 ${balanceAfter.remain}`);
      }
      let streak: StreakSummary = { redeemed: [], draws: 0, attempts: [] };
      try {
        streak = await runStreakManager(accessToken, ctx);
      } catch {
        streak = { redeemed: [], draws: 0, attempts: [], note: '连登管家执行失败' };
      }
      if (streak.redeemed.length > 0) {
        parts.push(`连登管家: 兑换${streak.redeemed.join('/')}`);
      }
      if (streak.draws > 0) {
        parts.push(`抽奖x${streak.draws}`);
      }
      if (streak.note) {
        parts.push(streak.note);
      }
      return {
        ok: true,
        message: `${parts.join('；')}${rotationWarning}`,
        detail: {
          status: res.status,
          body: data,
          rotatedRefreshToken,
          balanceBefore,
          balanceAfter,
          balanceBeforeRaw,
          balanceAfterRaw,
          streak,
        },
        skipped: skipped || undefined,
        rotatedRefreshToken,
      };
    };

    if (code === 0) {
      return finalizeSuccess('签到成功');
    }
    if (code === 10001) {
      return finalizeSuccess('今日已签到（服务端幂等跳过）', true);
    }
    return { ok: false, message: `签到失败: code=${code} ${message}`, detail: { status: res.status, body: data, rotatedRefreshToken }, rotatedRefreshToken };
  },
};
