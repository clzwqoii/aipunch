import { randomBytes, randomInt, randomUUID } from 'node:crypto';

// Trae CN 浏览器授权（协议逆向自 magpie-community/opencode-trae-auth）：
//   打开 www.trae.cn/authorization（IDE 自己的 OAuth 授权页，ClientID ono9krqynydwx5），
//   页面回调到 127.0.0.1，携带 userJwt（Token+RefreshToken）或仅 refreshToken。
// 与 `npm run trae-extract` 的区别：那条路抠的是本机客户端正在用的会话，客户端一刷新就互踢；
// 浏览器授权签发独立会话，与客户端各有一条轮换链，互不影响。
// 设备指纹（deviceId/machineId）在授权时一并申报，签到请求要带齐（见 providers/trae.ts）；
// 2026-10-23 实跑确认：不需要设备签名（DeviceProof），设备绑定接口会回 20403。
export const TRAE_CLIENT_ID = 'ono9krqynydwx5';
export const TRAE_AUTH_PAGE = 'https://www.trae.cn/authorization';
const BRAND = 'ASUS TUF Gaming A15 FA507RM_FA507RM';

export interface TraeDevice {
  deviceId: string; // 16 位数字
  machineId: string; // 32 位 hex
}

export interface TraeCallback {
  token: string;
  refreshToken: string;
  userId: string;
  screenName: string;
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function newTraeDevice(): TraeDevice {
  const deviceId = Array.from({ length: 16 }, (_, i) => (i === 0 ? randomInt(1, 10) : randomInt(0, 10))).join('');
  return { deviceId, machineId: randomBytes(16).toString('hex') };
}

export function buildTraeAuthUrl(device: TraeDevice, callbackUrl: string): string {
  const q = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.24254',
    auth_type: 'local',
    client_id: TRAE_CLIENT_ID,
    redirect: '0',
    login_trace_id: randomUUID(),
    auth_callback_url: callbackUrl,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: BRAND,
    x_device_type: 'windows',
    x_os_version: 'Windows 10 Pro',
    x_env: '',
    x_app_version: '3.3.65',
    x_app_type: 'stable',
    hide_saas_login: 'false',
  });
  return `${TRAE_AUTH_PAGE}?${q}`;
}

export function parseTraeCallback(q: URLSearchParams): TraeCallback {
  const error = q.get('error');
  if (error) throw new Error(`授权失败: ${q.get('error_description') || error}`);
  const jwt = parseJson(q.get('userJwt'));
  const info = parseJson(q.get('userInfo'));
  const token = str(jwt.Token ?? jwt.token);
  const refreshToken = str(jwt.RefreshToken ?? jwt.refreshToken ?? q.get('refreshToken'));
  if (!refreshToken) throw new Error('授权页未返回 token（refreshToken）');
  return {
    token,
    refreshToken,
    userId: str(info.UserID ?? info.userId),
    screenName: str(info.ScreenName ?? info.screenName),
  };
}
