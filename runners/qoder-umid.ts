import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findUmidBinary, isStale, parseRuntimeInfo } from '../core/umid.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { putSecretRequest, runRequest } from '../cloudflare/cf-api.ts';

// 生成 Qoder 国际版签到所需的设备身份三件套（Cosy-MachineToken/Type/Code）。
// 身份由本机 Qoder 客户端自带的 UMID 组件现场指纹，无法跨机复制，且有时效（实测约 3 天）；
// 桌面端每次启动调 `--if-stale 24 --push-cf` 补刷，CF 的每日 cron 用 Secrets 里的最新值。
// 用法：
//   npm run qoder-umid                             立即生成并写 .env
//   npm run qoder-umid -- --print                   只打印到终端
//   npm run qoder-umid -- --if-stale 24 --push-cf   启动补刷：未满 24h 跳过，否则生成并推 CF
// Linux/Windows 需 QODER_UMID_PATH 指向客户端 resources/umid/runtime-info[.exe]
const CF_SCRIPT = 'aipunch-checkin'; // 与 runners/cf-deploy.ts 的 SCRIPT 一致
const REFRESHED_AT_KEY = 'QODER_INTL_UMID_REFRESHED_AT';

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

// 只拿得到本机 .env 里的 CF 凭证；推送失败必须抛错，否则「补刷成功」是假象
async function pushToCf(entries: Array<[string, string]>): Promise<void> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId || !token) throw new Error('缺少 CF_ACCOUNT_ID / CF_API_TOKEN，无法推送到 CF');
  for (const [name, value] of entries) {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runRequest(fetch, putSecretRequest(accountId, token, CF_SCRIPT, name, value));
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }
    if (lastError) throw new Error(`推送 ${name} 失败: ${lastError.message}`);
  }
}

async function main(): Promise<void> {
  // 桌面端把数据目录经 AIPUNCH_WORK_DIR 注入子进程（与 cf-deploy 一致）；
  // 直接在仓库跑时回落到 cwd
  const workDir = process.env.AIPUNCH_WORK_DIR ?? process.cwd();
  loadDotEnv(workDir);
  const args = process.argv.slice(2);
  const staleIdx = args.indexOf('--if-stale');
  const maxAge = staleIdx >= 0 ? Number(args[staleIdx + 1]) : NaN;
  const lastRefreshed = process.env[REFRESHED_AT_KEY];
  if (Number.isFinite(maxAge) && !isStale(lastRefreshed, new Date(), maxAge)) {
    console.log(`[UMID] 跳过：上次刷新 ${lastRefreshed}（未满 ${maxAge} 小时）`);
    return;
  }

  const bin = findUmidBinary(existsSync);
  if (!bin) {
    throw new Error('未找到 Qoder 客户端的 umid/runtime-info 组件：请安装 Qoder 国际版客户端，或用 QODER_UMID_PATH 指定路径');
  }

  const raw = execFileSync(bin, ['--account-stdin'], {
    input: '{"account":""}\n',
    encoding: 'utf-8',
    timeout: 20_000,
  });
  const identity = parseRuntimeInfo(raw);
  if (!identity) throw new Error(`无法解析设备身份输出: ${raw.slice(0, 200)}`);

  const entries: Array<[string, string]> = [
    ['QODER_INTL_COSY_MACHINE_TOKEN', identity.machineToken],
    ['QODER_INTL_COSY_MACHINE_TYPE', identity.machineType],
    ['QODER_INTL_COSY_MACHINE_CODE', identity.machineCode],
  ];

  if (args.includes('--print')) {
    for (const [key, value] of entries) console.log(`${key}=${value}`);
    return;
  }

  const envFile = join(workDir, '.env');
  for (const [key, value] of entries) setEnvValue(envFile, key, value);
  setEnvValue(envFile, REFRESHED_AT_KEY, new Date().toISOString());
  console.log(`已写入 ${envFile}：QODER_INTL_COSY_MACHINE_TOKEN=${mask(identity.machineToken)}`);

  if (args.includes('--push-cf')) {
    try {
      await pushToCf(entries);
      console.log(`[UMID] 已推送设备头到 CF（${CF_SCRIPT}）`);
    } catch (err) {
      console.error(`[UMID] 推送失败：${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log('设备身份与区域绑定：国际版必须用 Qoder 国际版客户端生成，CN 客户端的三件套会被风控拒绝。');
}

main().catch((err: unknown) => {
  console.error(`生成失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
