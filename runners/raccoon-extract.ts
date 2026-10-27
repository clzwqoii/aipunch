import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setEnvValue } from '../core/dotenv.ts';

// 小浣熊凭证冷启动：读桌面客户端明文登录态写入 .env。
// 源文件 ~/.box-agent/config/auth.json（可用 RACCOON_BOX_AGENT_CONFIG_DIR /
// BOX_AGENT_CONFIG_DIR 覆盖目录），全平台明文、无需解密；只读，不修改客户端登录态。
// 客户端形如 { access_token, office_identity }——2026-10-25 登录后已不再保存 refresh_token，
// 所以只给 access 是常态：照写，refresh 沿用 .env 现有值并在输出里说明。
// 用法：npm run raccoon-extract [-- --print]

export type AuthJson = { access_token?: string; refresh_token?: string };

// 决定写哪些变量（纯函数，便于测试）：provider 只需 access 即可跑通，
// 只有「两者都缺」才是真的未登录
export function planEnvWrites(
  auth: AuthJson,
  existing: { refresh?: string },
): { writes: Array<{ key: string; value: string }>; warning?: string } {
  const writes: Array<{ key: string; value: string }> = [];
  if (auth.access_token) writes.push({ key: 'RACCOON_ACCESS_TOKEN', value: auth.access_token });
  if (auth.refresh_token) writes.push({ key: 'RACCOON_REFRESH_TOKEN', value: auth.refresh_token });
  if (writes.length === 0) {
    throw new Error('auth.json 中既无 access_token 也无 refresh_token，客户端可能未登录');
  }
  if (!auth.refresh_token) {
    return {
      writes,
      warning: existing.refresh
        ? '客户端未提供 refresh_token：沿用 .env 现有值'
        : '客户端未提供 refresh_token 且 .env 无现有值：access_token 到期后需重新登录客户端再提取',
    };
  }
  return { writes };
}

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

function readExistingRefresh(envFile: string): string | undefined {
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('RACCOON_REFRESH_TOKEN='));
  return line?.slice('RACCOON_REFRESH_TOKEN='.length).trim() || undefined;
}

function main(): void {
  const dir =
    process.env.RACCOON_BOX_AGENT_CONFIG_DIR ??
    process.env.BOX_AGENT_CONFIG_DIR ??
    join(homedir(), '.box-agent', 'config');
  const file = join(dir, 'auth.json');
  if (!existsSync(file)) {
    console.error(`未找到 ${file}，请先在本机小浣熊客户端登录（或用 RACCOON_BOX_AGENT_CONFIG_DIR 指定目录）`);
    process.exitCode = 1;
    return;
  }
  let auth: AuthJson;
  try {
    auth = JSON.parse(readFileSync(file, 'utf8')) as AuthJson;
  } catch (err) {
    console.error(`${file} 解析失败: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const envFile = join(process.cwd(), '.env');
  let plan: ReturnType<typeof planEnvWrites>;
  try {
    plan = planEnvWrites(auth, { refresh: readExistingRefresh(envFile) });
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--print')) {
    for (const { key, value } of plan.writes) console.log(`${key}=${value}`);
    if (plan.warning) console.error(`# ${plan.warning}`);
    return;
  }
  for (const { key, value } of plan.writes) {
    setEnvValue(envFile, key, value);
    console.log(`${key}=${mask(value)} 已写入 ${envFile}（token 不明文显示）`);
  }
  if (plan.warning) console.warn(`[提示] ${plan.warning}`);
  console.log('config.json 加账号：{ "provider": "raccoon", "name": "main", "tokenEnv": "RACCOON_ACCESS_TOKEN", "refreshTokenEnv": "RACCOON_REFRESH_TOKEN", "enabled": true }');
}

// 仅直接执行时运行；被测试 import 时不能读写真实文件
if (/raccoon-extract\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  main();
}
