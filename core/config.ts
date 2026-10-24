import { readFileSync } from 'node:fs';
import type { Account, AccountSpec } from './types.ts';

export interface ConfigFile {
  accounts: AccountSpec[];
}

export function loadConfig(path: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`配置文件读取失败（需为合法 JSON）: ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ConfigFile).accounts)) {
    throw new Error(`配置文件缺少 accounts 数组: ${path}`);
  }
  return parsed as ConfigFile;
}

// 信任边界校验：token 一律经 tokenEnv / refreshTokenEnv 从环境变量注入，配置文件永不持有密钥。
// env 源可注入：Workers 里 Secrets 绑定到 handler 的 env 参数而非 process.env
export function resolveAccounts(
  config: ConfigFile,
  env: Record<string, string | undefined> = process.env,
): Account[] {
  if (config.accounts.length === 0) {
    throw new Error('配置文件中没有账号');
  }
  return config.accounts.map((spec, i) => {
    if (!spec.provider || !spec.name) {
      throw new Error(`accounts[${i}] 缺少 provider 或 name`);
    }
    if (!spec.tokenEnv && !spec.refreshTokenEnv) {
      throw new Error(`accounts[${i}] (${spec.provider}/${spec.name}) 需要 tokenEnv 或 refreshTokenEnv 之一，token 必须走环境变量`);
    }
    const who = `${spec.provider}/${spec.name}`;
    let token = '';
    if (spec.tokenEnv) {
      token = env[spec.tokenEnv] ?? '';
      if (!token) {
        throw new Error(`账号 ${who} 的环境变量 ${spec.tokenEnv} 未设置`);
      }
    }
    let refreshToken: string | undefined;
    if (spec.refreshTokenEnv) {
      refreshToken = env[spec.refreshTokenEnv];
      if (!refreshToken) {
        throw new Error(`账号 ${who} 的环境变量 ${spec.refreshTokenEnv} 未设置`);
      }
    }
    return { provider: spec.provider, name: spec.name, token, refreshToken, refreshTokenEnv: spec.refreshTokenEnv, enabled: spec.enabled };
  });
}
