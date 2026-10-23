import { join } from 'node:path';
import { exchangePat } from '../providers/qoder.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { installDnsFallback } from '../core/dns-fallback.ts';

// PAT 冷启动（Qoder CN 官方文档路径，macOS / Linux / CI 通用）：
// 控制台 → 设置 → API 令牌创建 PAT（pt- 前缀，仅显示一次）→ 兑换 jrt- 刷新令牌写 .env。
// 与 `npm run login`（WorkBuddy 短信登录）同用途；绕开 Windows DPAPI 本地解密。
// 用法（三选一）：
//   把 QODER_PAT=pt-xxx 写进 .env 后 npm run qoder-login   （推荐，.env 已 gitignore）
//   QODER_PAT=pt-xxx npm run qoder-login                   （注意：PAT 会留在 shell history）
//   npm run qoder-login -- --print                         （只打印到终端自行复制，不写 .env）
function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

async function main(): Promise<void> {
  loadDotEnv(); // 支持 QODER_PAT 写在 .env（gitignored）——比命令行参数不易泄露
  installDnsFallback();
  const args = process.argv.slice(2);
  const patFlag = args.indexOf('--pat');
  const pat = (patFlag >= 0 ? args[patFlag + 1] : undefined) ?? process.env.QODER_PAT ?? '';
  if (!pat) {
    console.error('缺少 PAT。用法：QODER_PAT=pt-xxx npm run qoder-login（Qoder 控制台 → 设置 → API 令牌创建）');
    process.exitCode = 1;
    return;
  }

  const creds = await exchangePat(pat, { now: new Date(), fetch: globalThis.fetch });
  if (args.includes('--print')) {
    console.log(`QODER_REFRESH_TOKEN=${creds.refreshToken}`);
    console.log(`QODER_TOKEN=${creds.token}`);
    return;
  }

  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, 'QODER_REFRESH_TOKEN', creds.refreshToken);
  setEnvValue(envFile, 'QODER_TOKEN', creds.token);
  console.log(`兑换成功：QODER_REFRESH_TOKEN=${mask(creds.refreshToken)} 已写入 ${envFile}（token 不明文显示）`);
  console.log('config.json 加账号：{ "provider": "qoder", "name": "main", "refreshTokenEnv": "QODER_REFRESH_TOKEN", "enabled": true }');
}

main().catch((err: unknown) => {
  console.error(`兑换失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
