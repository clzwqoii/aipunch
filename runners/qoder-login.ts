import { join } from 'node:path';
import { exchangePat } from '../providers/qoder.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { installDnsFallback } from '../core/dns-fallback.ts';

// PAT 冷启动（官方文档路径，macOS / Linux / CI 通用）：
// 控制台 → 设置 → API 令牌创建 PAT（pt- 前缀，仅显示一次）→ 兑换 jrt- 刷新令牌写 .env。
// 与 `npm run login`（WorkBuddy 短信登录）同用途；绕开 Windows DPAPI 本地解密。
// 用法（三选一）：
//   把 QODER_PAT=pt-xxx 写进 .env 后 npm run qoder-login   （推荐，.env 已 gitignore）
//   QODER_PAT=pt-xxx npm run qoder-login                   （注意：PAT 会留在 shell history）
//   npm run qoder-login -- --print                         （只打印到终端自行复制，不写 .env）
// 国际版加 --intl：PAT 在 https://qoder.com/account/integrations 创建，读 QODER_INTL_PAT，
// 打 openapi.qoder.sh，写 QODER_INTL_REFRESH_TOKEN（两站会话不互通，凭证不能复用）。
const CN_TARGET = {
  base: undefined,
  patEnv: 'QODER_PAT',
  refreshEnv: 'QODER_REFRESH_TOKEN',
  tokenEnv: 'QODER_TOKEN',
  provider: 'qoder',
  patUrl: 'Qoder 控制台 → 设置 → API 令牌创建',
};
const INTL_TARGET = {
  base: 'https://openapi.qoder.sh',
  patEnv: 'QODER_INTL_PAT',
  refreshEnv: 'QODER_INTL_REFRESH_TOKEN',
  tokenEnv: 'QODER_INTL_TOKEN',
  provider: 'qoder-intl',
  patUrl: 'https://qoder.com/account/integrations',
};

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

async function main(): Promise<void> {
  loadDotEnv(); // 支持 PAT 写在 .env（gitignored）——比命令行参数不易泄露
  installDnsFallback();
  const args = process.argv.slice(2);
  const target = args.includes('--intl') ? INTL_TARGET : CN_TARGET;
  const patFlag = args.indexOf('--pat');
  const pat = (patFlag >= 0 ? args[patFlag + 1] : undefined) ?? process.env[target.patEnv] ?? '';
  if (!pat) {
    console.error(`缺少 PAT。用法：${target.patEnv}=pt-xxx npm run qoder-login${target.base ? ' -- --intl' : ''}（${target.patUrl}）`);
    process.exitCode = 1;
    return;
  }

  const creds = await exchangePat(pat, { now: new Date(), fetch: globalThis.fetch }, target.base);
  if (args.includes('--print')) {
    console.log(`${target.refreshEnv}=${creds.refreshToken}`);
    console.log(`${target.tokenEnv}=${creds.token}`);
    return;
  }

  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, target.refreshEnv, creds.refreshToken);
  setEnvValue(envFile, target.tokenEnv, creds.token);
  console.log(`兑换成功：${target.refreshEnv}=${mask(creds.refreshToken)} 已写入 ${envFile}（token 不明文显示）`);
  console.log(`config.json 加账号：{ "provider": "${target.provider}", "name": "main", "refreshTokenEnv": "${target.refreshEnv}", "enabled": true }`);
}

main().catch((err: unknown) => {
  console.error(`兑换失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
