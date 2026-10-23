import { randomUUID } from 'node:crypto';
import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';

// Trae CN 签到（逆向自桌面端，四来源交叉验证：wallechfox/Trae-Checkin 实测 /
// L0NE-6/Trae-AutoCheckin / hyang0/trae-checkin / ronghms/TraeTools）：
//   POST https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken
//     body { ClientID, RefreshToken, ClientSecret:'-', UserID } → Result/data: { Token, RefreshToken, TokenExpireAt }
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim
//     Authorization: Cloud-IDE-JWT <jwt>；X-User-Region: CN；x-device-id（真实注册设备号）
//     body { req_source: 2 }；code=0 成功；9095=今日已领；9074=设备指纹不全或请求被拒（积分未到账，判失败）；
//     1001/1002=鉴权失效（自动刷新重试一次）
// 设备号与 refreshToken 有两条来源：`npm run trae-login` 浏览器授权（独立会话，推荐）
// 或 `npm run trae-extract` 提取本机客户端登录态（与客户端共享会话）。
// 一个设备号一天限签一个账号。真实 token 实跑判决（2026-10-19，Trae CN）：
// ClientID 走 IDE 谱系 ono9krqynydwx5（SOLO 谱系为 en1oxy7wnw8j9n，用 TRAE_CLIENT_ID 覆盖）；
// req_source=2 有效；ExchangeToken 无需设备签名（未出现 20405）。
// 2026-10-23 实跑补正：9074 的真因是 claim 请求设备指纹头不全（缺 x-machine-id/x-uid/app-id 等），
// 补齐 magpie 同款 IDE 头后同一设备号签到成功；设备绑定接口（DeviceProof）不必要。
const EXCHANGE_URL = 'https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken';
const CLAIM_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim';
const CLIENT_ID = process.env.TRAE_CLIENT_ID ?? 'ono9krqynydwx5';
const REQ_SOURCE = Number(process.env.TRAE_REQ_SOURCE ?? '2');
const APP_VERSION = process.env.TRAE_APPVERSION ?? '0.1.43';
// 设备指纹头：2026-10-23 实跑确认，缺 x-machine-id / x-uid / app-id 等头会被判 9074
// （「当前参与用户过多」的真因是设备指纹不完整，与 16/19 位设备号无关）
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const CLIENT_VERSION = process.env.TRAE_CLIENT_VERSION ?? '0.1.69';
const CLIENT_VERSION_CODE = process.env.TRAE_CLIENT_VERSION_CODE ?? '20260917';
const DEVICE_BRAND = 'ASUS TUF Gaming A15 FA507RM_FA507RM';

const CONGESTION_HINTS = /太多|拥挤|繁忙|稍后|频繁|限流|too many|busy|later|retry|frequent/i;
const ALREADY_HINTS = /已签|已领|明日|already|claimed|checked/i;

type JsonBody = {
  code?: number;
  message?: string;
  credits?: number;
  Token?: string;
  AccessToken?: string;
  RefreshToken?: string;
  data?: Record<string, unknown>;
  Result?: Record<string, unknown>;
};

async function parseJson(res: Response): Promise<{ data: JsonBody | null; text: string }> {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

// 响应可能是扁平的、data 包裹的或 Result 包裹的——合并后统一读取（wallechfox 同款双路径）
function unwrap(data: JsonBody | null): JsonBody {
  if (!data) return {};
  const inner = (data.Result ?? data.data) as JsonBody | undefined;
  return inner && typeof inner === 'object' ? { ...data, ...inner } : data;
}

async function exchangeToken(
  refreshToken: string,
  ctx: RunContext,
): Promise<{ jwt: string; rotatedRefreshToken?: string }> {
  const res = await ctx.fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `Trae/${APP_VERSION}` },
    body: JSON.stringify({
      ClientID: CLIENT_ID,
      RefreshToken: refreshToken,
      ClientSecret: '-',
      UserID: process.env.TRAE_USER_ID ?? '',
    }),
  });
  const { data, text } = await parseJson(res);
  const body = unwrap(data);
  const jwt = body.Token ?? body.AccessToken;
  if (!jwt) {
    throw new Error(`refreshToken 刷新失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return { jwt, rotatedRefreshToken: body.RefreshToken };
}

function claimHeaders(jwt: string, deviceId: string): Record<string, string> {
  const uid = process.env.TRAE_USER_ID ?? '';
  const machineId = process.env.TRAE_MACHINE_ID ?? '';
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${jwt}`,
    'X-Cloudide-Token': jwt,
    'x-ide-token': jwt,
    ...(uid ? { 'x-uid': uid } : {}),
    'x-app-id': APP_ID,
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
    ...(machineId ? { 'x-machine-id': machineId } : {}),
    'x-request-id': randomUUID(),
    'x-app-version': CLIENT_VERSION,
    'x-app-version-code': CLIENT_VERSION_CODE,
    'x-ide-version': CLIENT_VERSION,
    'x-ide-version-code': CLIENT_VERSION_CODE,
    'x-ide-version-type': 'stable',
    'x-device-cpu': 'AMD',
    'x-device-brand': DEVICE_BRAND,
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
    'x-system-type': 'Windows',
    'User-Agent': `Trae/${APP_VERSION}`,
    'X-User-Region': 'CN',
  };
}

export const trae: Provider = {
  id: 'trae',
  name: 'Trae',
  async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    const deviceId = process.env.TRAE_DEVICE_ID ?? '';
    let jwt = account.token;
    let rotatedRefreshToken: string | undefined;
    if (account.refreshToken) {
      try {
        const refreshed = await exchangeToken(account.refreshToken, ctx);
        jwt = refreshed.jwt;
        rotatedRefreshToken = refreshed.rotatedRefreshToken;
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    }
    if (!jwt) {
      return { ok: false, message: '账号缺少 token：需要 tokenEnv 或 refreshTokenEnv' };
    }

    const doClaim = (token: string): Promise<Response> =>
      ctx.fetch(CLAIM_URL, {
        method: 'POST',
        headers: claimHeaders(token, deviceId),
        body: JSON.stringify({ req_source: REQ_SOURCE }),
      });

    let res = await doClaim(jwt);
    let parsed = await parseJson(res);
    let body = unwrap(parsed.data);

    // 1001/1002 鉴权失效：强制刷新一次再重试（wallechfox 同款策略）
    if ((body.code === 1001 || body.code === 1002) && account.refreshToken) {
      try {
        const refreshed = await exchangeToken(account.refreshToken, ctx);
        jwt = refreshed.jwt;
        if (refreshed.rotatedRefreshToken) rotatedRefreshToken = refreshed.rotatedRefreshToken;
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      res = await doClaim(jwt);
      parsed = await parseJson(res);
      body = unwrap(parsed.data);
    }

    if (!parsed.data) {
      return { ok: false, message: `HTTP ${res.status}，响应非 JSON: ${parsed.text.slice(0, 120)}`, rotatedRefreshToken };
    }
    const code = body.code ?? 0;
    const message = body.message ?? '';

    if (code === 0) {
      const credits = typeof body.credits === 'number' ? `：积分 ${body.credits}` : '';
      return { ok: true, message: `签到成功${credits}`, detail: { status: res.status, body, rotatedRefreshToken }, rotatedRefreshToken };
    }
    if (code === 9095 || ALREADY_HINTS.test(message)) {
      return { ok: true, message: '今日已领取（服务端幂等跳过）', detail: { status: res.status, body, rotatedRefreshToken }, rotatedRefreshToken };
    }
    if (code === 9074 || res.status === 429 || res.status >= 500 || CONGESTION_HINTS.test(message)) {
      // 9074 真因是设备指纹不完整（缺 machine-id/uid/app-id 等头），且积分未到账——判失败下轮重试
      return {
        ok: false,
        message: `触发限流/设备校验（code=${code}）：积分未到账，下轮重试。需带齐 TRAE_DEVICE_ID / TRAE_MACHINE_ID / TRAE_USER_ID`,
        detail: { status: res.status, body, rotatedRefreshToken },
        rotatedRefreshToken,
      };
    }
    return { ok: false, message: `签到失败: code=${code} ${message}`, detail: { status: res.status, body, rotatedRefreshToken }, rotatedRefreshToken };
  },
};
