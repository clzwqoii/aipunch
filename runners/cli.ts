import { join } from 'node:path';
import { runCheckins } from '../core/executor.ts';
import { loadConfig, resolveAccounts } from '../core/config.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { persistRotatedTokens, rotationNotices } from '../core/token-rotation.ts';
import '../providers/index.ts';

async function main(): Promise<void> {
  loadDotEnv(); // 本地 .env（gitignored）中的凭证注入环境变量
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  let configPath = process.env.CHECKIN_CONFIG ?? 'config.json';
  const configFlagIndex = args.indexOf('--config');
  if (configFlagIndex >= 0) {
    configPath = args[configFlagIndex + 1];
    if (!configPath) {
      throw new Error('--config 后缺少配置文件路径');
    }
  }

  if (dryRun) {
    const config = loadConfig(configPath);
    for (const spec of config.accounts) {
      const state = spec.enabled === false ? ' (disabled)' : '';
      const creds: string[] = [];
      if (spec.tokenEnv) {
        creds.push(`token=${process.env[spec.tokenEnv] ? 'OK' : `MISSING(${spec.tokenEnv})`}`);
      }
      if (spec.refreshTokenEnv) {
        creds.push(`refresh=${process.env[spec.refreshTokenEnv] ? 'OK' : `MISSING(${spec.refreshTokenEnv})`}`);
      }
      console.log(`[dry-run] ${spec.provider}/${spec.name} ${creds.join(' ') || 'no-credential'}${state}`);
    }
    console.log(`[dry-run] 共 ${config.accounts.length} 个账号，未发起任何请求`);
    return;
  }

  const accounts = resolveAccounts(loadConfig(configPath));
  const result = await runCheckins(accounts, { now: new Date(), fetch: globalThis.fetch });

  for (const r of result.results) {
    console.log(`${r.ok ? '[OK]' : '[FAIL]'} ${r.provider}/${r.account}: ${r.message} (${r.durationMs}ms)`);
    if (verbose) {
      const detailJson = JSON.stringify(r.detail ?? null);
      // ponytail: 原始响应可能很大（几十个套餐包），截断到 2000 字符，完整结构看代码里的字段
      console.log(`  detail: ${detailJson.length > 2000 ? `${detailJson.slice(0, 2000)}…(truncated)` : detailJson}`);
    }
  }
  console.log(`完成: ${result.succeeded}/${result.total} 成功`);

  const rotatedFile = process.env.CHECKIN_ROTATED_TOKEN_FILE;
  if (rotatedFile) {
    const lines = persistRotatedTokens(result, rotatedFile);
    if (lines.length > 0) {
      console.log(`refreshToken 已轮换，新值写入 ${rotatedFile}（CI 将回写 Secret）`);
    }
  } else if (!process.env.GITHUB_ACTIONS) {
    // 本地且未配置文件输出：把轮换出的新 token 自动写回 .env（与桌面客户端写回登录态同思路），
    // 写回失败（如 .env 不可写）才退化为打印，让用户手动更新
    const envFile = join(process.cwd(), '.env');
    for (const notice of rotationNotices(result)) {
      try {
        setEnvValue(envFile, notice.name, notice.token);
        console.log(`${notice.name} 已轮换，新值已自动写入 .env（无需手动操作）`);
      } catch {
        console.log(`\n${notice.name} 已轮换，.env 写回失败，请手动更新：\n${notice.token}`);
      }
    }
  }

  if (result.succeeded < result.total) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`运行失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
