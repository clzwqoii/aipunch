import { join } from 'node:path';
import { runCheckins } from '../core/executor.ts';
import { loadConfig, resolveAccounts } from '../core/config.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { fetchWithTimeout } from '../core/http.ts';
import { installDnsFallback } from '../core/dns-fallback.ts';
import { persistRotatedTokens, rotationNotices } from '../core/token-rotation.ts';
import '../providers/index.ts';

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${flag} 后缺少值`);
  return value;
}

async function main(): Promise<void> {
  loadDotEnv(); // 本地 .env（gitignored）中的凭证注入环境变量
  // 代理残留会让系统 DNS 返回 fake-IP 或超时：进程内兜底走 DoH（CHECKIN_DNS_DOH=0 可关）
  installDnsFallback();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  const configPath = flagValue(args, '--config') ?? process.env.CHECKIN_CONFIG ?? 'config.json';
  const providerFilter = flagValue(args, '--provider');
  const accountFilter = flagValue(args, '--account');

  let config = loadConfig(configPath);
  if (providerFilter || accountFilter) {
    const accounts = config.accounts.filter(
      (a) => (!providerFilter || a.provider === providerFilter) && (!accountFilter || a.name === accountFilter),
    );
    if (accounts.length === 0) {
      throw new Error(
        `配置中没有匹配的账号: provider=${providerFilter ?? '*'} account=${accountFilter ?? '*'}`,
      );
    }
    config = { ...config, accounts };
  }

  if (dryRun) {
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

  const accounts = resolveAccounts(config);
  const timeoutMs = Number(process.env.CHECKIN_REQUEST_TIMEOUT_MS ?? '30000');
  // 每完成一个账号立即打印：桌面壳里不必等整轮跑完才看到进度
  const result = await runCheckins(accounts, { now: new Date(), fetch: fetchWithTimeout(timeoutMs) }, (r) => {
    console.log(`${r.ok ? '[OK]' : '[FAIL]'} ${r.provider}/${r.account}: ${r.message} (${r.durationMs}ms)`);
    if (verbose) {
      const detailJson = JSON.stringify(r.detail ?? null);
      // GitHub 日志会吞掉超长单行：按 8000 字符分块，拼接后仍是完整 JSON
      const CHUNK = 8000;
      for (let i = 0; i < detailJson.length; i += CHUNK) {
        console.log(`  detail[${i}]: ${detailJson.slice(i, i + CHUNK)}`);
      }
    }
  });
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
