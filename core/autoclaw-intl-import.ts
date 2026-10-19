import { join } from 'node:path';

// Agent2API（CencYun/agent2api）账号库的只读导入：
//   {config_dir}/agent2api.db，表 accounts，一行一账号；原始 JSON 列存明文
//   accessToken/refreshToken（设计如此，为 /api/accounts/export 可迁移）。
//   国际版账号 provider = 'autoclaw-intl'；「导入桌面客户端」的记录故意不含 token，
//   因此必须选有 refreshToken 的记录（即经 Agent2API 自带 OAuth 登录添加的账号）。
// 说明：token 属于账号凭证，本模块仅用于读取用户本机、本人账号的数据。

export interface IntlAccountRecord {
  refreshToken: string;
  accessToken?: string;
  userId?: string;
  deviceId?: string;
  name?: string;
}

// Agent2API 的应用数据目录名随 Tauri bundle id 变化，按常见候选列举；
// runner 还会在标准配置根下递归找 agent2api.db 兜底。
const APP_IDS = ['Agent2API', 'agent2api', 'com.agent2api.app', 'com.agent2api.desktop', 'com.cencyun.agent2api'];

export function candidateDbPaths(homeDir: string, platform: NodeJS.Platform, appData?: string): string[] {
  const roots =
    platform === 'win32'
      ? [appData ?? join(homeDir, 'AppData', 'Roaming')]
      : platform === 'darwin'
        ? [join(homeDir, 'Library', 'Application Support')]
        : [join(homeDir, '.config'), join(homeDir, '.local', 'share')];
  return roots.flatMap((root) => APP_IDS.map((id) => join(root, id, 'agent2api.db')));
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function findIntlAccount(rows: Array<Record<string, unknown>>): IntlAccountRecord | null {
  for (const row of rows) {
    const candidates = [row, ...Object.values(row).map(parseMaybeJson).filter((v): v is Record<string, unknown> => v !== null)];
    for (const record of candidates) {
      // provider 可能在独立列或 JSON 内；两处都对 autoclaw-intl 才认
      const provider = pickString(record, ['provider']) ?? pickString(row, ['provider']);
      if (provider !== 'autoclaw-intl') continue;
      const refreshToken = pickString(record, ['refreshToken', 'refresh_token']);
      if (!refreshToken) continue;
      return {
        refreshToken,
        accessToken: pickString(record, ['accessToken', 'token', 'access_token']),
        userId: pickString(record, ['userId', 'user_id']),
        deviceId: pickString(record, ['deviceId', 'device_id']),
        name: pickString(record, ['name']),
      };
    }
  }
  return null;
}
