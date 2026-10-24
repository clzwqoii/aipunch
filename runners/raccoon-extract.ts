import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setEnvValue } from '../core/dotenv.ts';

// 小浣熊凭证冷启动：读桌面客户端明文登录态写入 .env。
// 源文件 ~/.box-agent/config/auth.json（可用 RACCOON_BOX_AGENT_CONFIG_DIR /
// BOX_AGENT_CONFIG_DIR 覆盖目录），全平台明文、无需解密；只读，不修改客户端登录态。
// 用法：npm run raccoon-extract [-- --print]
function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
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
  let auth: { refresh_token?: string; access_token?: string };
  try {
    auth = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`${file} 解析失败: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!auth.refresh_token) {
    console.error(`${file} 中无 refresh_token，客户端可能未登录`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--print')) {
    console.log(`RACCOON_REFRESH_TOKEN=${auth.refresh_token}`);
    return;
  }
  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, 'RACCOON_REFRESH_TOKEN', auth.refresh_token);
  console.log(`RACCOON_REFRESH_TOKEN=${mask(auth.refresh_token)} 已写入 ${envFile}（token 不明文显示）`);
  console.log('config.json 加账号：{ "provider": "raccoon", "name": "main", "refreshTokenEnv": "RACCOON_REFRESH_TOKEN", "enabled": true }');
}

main();
