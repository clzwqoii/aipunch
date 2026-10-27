// 桌面端「部署到 Cloudflare Workers」（ADR 0004 P2）：粘贴 API Token + Account ID，
// 全 REST 代部署（KV namespace + worker 脚本 + 凭证 Secrets + cron），无需 wrangler/git。
// 一键幂等：凭证必写；脚本按内容指纹比对，相同则跳过上传（不触发脚本上传频控）。
// 用法：
//   npm run cf-deploy -- --token <t> --account <id> [--hour 11] [--tz Asia/Shanghai] [--script <worker.mjs>]
//   npm run cf-deploy -- --trigger-now   # 立即执行：临时把 cron 改到下一分钟，KV 出结果后恢复（workers.dev 国内被墙不走 HTTP）
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigFile } from '../core/config.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { cronHourFor } from './ci-checkin.ts';
import {
  dailyCron,
  deployWorkerRequest,
  ensureKvNamespace,
  putKvValueRequest,
  putSecretRequest,
  putSchedulesRequest,
  readKvValue,
  runRequest,
} from '../cloudflare/cf-api.ts';

const SCRIPT = 'aipunch-checkin';
const KV_TITLE = 'aipunch';
// KV 里记录已上传脚本的指纹：重复部署比对相同则跳过上传
const KV_KEY_WORKER_SHA = 'worker_sha';

// 数据目录定位：Rust 注入的 AIPUNCH_WORK_DIR 是唯一事实源；直接终端跑时回退 cwd
// （此前按 process.cwd() 定位 .env，dev/安装模式下 cwd 错位导致 CF 配置回写丢失）
export function workDirRoot(): string {
  return process.env.AIPUNCH_WORK_DIR ?? process.cwd();
}

export function workerSha(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface DeployArgs {
  token: string;
  account: string;
  hour: string; // 两位 00-23
  tz: string;
  cronOnly: boolean; // 只更新 cron 触发器（CF 平台的「保存定时」）
  triggerNow: boolean;
}

export function parseDeployArgs(
  argv: string[],
  env: Record<string, string | undefined> = {},
): DeployArgs {
  const value = (flag: string): string | undefined => {
    const idx = argv.indexOf(`--${flag}`);
    const v = idx === -1 ? undefined : argv[idx + 1]?.trim();
    return v && !v.startsWith('--') ? v : undefined;
  };
  // env 兜底：部署时写回 .env 的 CF_ACCOUNT_ID / CF_API_TOKEN（重复部署、触发、改定时不必重贴）
  const token = value('token') ?? env.CF_API_TOKEN;
  if (!token) {
    throw new Error('缺少 --token（Cloudflare API Token，权限需含 Workers Scripts:Edit 与 Workers KV Storage:Edit）');
  }
  const account = value('account') ?? env.CF_ACCOUNT_ID;
  if (!account) throw new Error('缺少 --account（Cloudflare Account ID，控制台右侧栏可复制）');
  const hourRaw = value('hour') ?? '11';
  if (!/^(?:[01]?\d|2[0-3])$/.test(hourRaw)) throw new Error('--hour 须为 0-23');
  return {
    token,
    account,
    hour: String(Number(hourRaw)).padStart(2, '0'),
    tz: value('tz') ?? 'Asia/Shanghai',
    cronOnly: argv.includes('--cron-only'),
    triggerNow: argv.includes('--trigger-now'),
  };
}

// providers 经 process.env 读取的辅助凭证（设备/风控/签名材料，与账号 refreshToken 配套）。
// CF nodejs_compat 会把 Secrets 注入 process.env，部署时一并上传；缺了对应 provider 会失败
// （实测：codearts 缺 DPOP_KEY 直接 FAIL）。清单与 providers/ 的 process.env 引用保持同步。
const EXTRA_SECRET_KEYS = [
  'CODEARTS_DPOP_KEY',
  'CODEARTS_CODE_VERIFIER',
  'CODEARTS_CLIENT_ID',
  'TRAE_DEVICE_ID',
  'TRAE_MACHINE_ID',
  'TRAE_USER_ID',
  'TRAE_CLIENT_ID',
  'TRAE_CLIENT_VERSION',
  'TRAE_CLIENT_VERSION_CODE',
  'TRAE_APPVERSION',
  'TRAE_REQ_SOURCE',
  'AUTOCLAW_DEVICE_ID',
  'AUTOCLAW_INTL_DEVICE_ID',
  'QODER_COSY_MACHINE_TOKEN',
] as const;

// 部署计划：KV config（只含 accounts，platform 是桌面端概念不下发）、Secrets 清单（CF 管理凭证 + 账号凭证 + 辅助凭证）、cron
export function buildDeployPlan(
  config: ConfigFile,
  env: Record<string, string | undefined>,
  args: Pick<DeployArgs, 'token' | 'account' | 'hour' | 'tz'>,
): { kvConfig: string; secrets: Array<{ name: string; value: string }>; crons: string[] } {
  const accountKeys = config.accounts.flatMap((a) => [a.tokenEnv, a.refreshTokenEnv].filter((n): n is string => !!n));
  const extraKeys = EXTRA_SECRET_KEYS.filter((k) => env[k]);
  const missing = [...accountKeys, ...extraKeys].filter((n) => !env[n]);
  // 辅助键缺失不阻断（有默认值/可选），账号凭证缺失才整体报错
  const missingAccount = accountKeys.filter((n) => !env[n]);
  if (missingAccount.length > 0) {
    throw new Error(`以下凭证未在 .env/环境中配置，无法部署：${missingAccount.join(', ')}（请先在桌面端完成凭证导入）`);
  }
  void missing;
  return {
    kvConfig: JSON.stringify({ accounts: config.accounts }),
    secrets: [
      { name: 'CF_ACCOUNT_ID', value: args.account },
      { name: 'CF_API_TOKEN', value: args.token },
      ...[...new Set([...accountKeys, ...extraKeys])].map((n) => ({ name: n, value: env[n] as string })),
    ],
    crons: [dailyCron(cronHourFor(args.hour, args.tz))],
  };
}

// 立即执行（ADR 0004）：不走 workers.dev（国内被墙）。CF cron 调度有分钟级延迟（实测
// 单分钟窗口经常错过），临时 cron 设为每分钟；worker 端签到幂等，多次触发无害；
// 轮询 result/error 任一出现即为终态，立即恢复每日 cron
async function triggerNow(args: DeployArgs): Promise<void> {
  const nsId = process.env.CF_KV_NAMESPACE;
  if (!nsId) throw new Error('尚未部署（缺 CF_KV_NAMESPACE）：请先完整部署一次');
  const before = await readKvValue(fetch, args.account, args.token, nsId, 'result');
  const beforeAt = before ? (JSON.parse(before) as { finishedAt?: string }).finishedAt : '';
  // 上一轮失败的 error 键会一直留着：只有「本轮新写的」错误才算终态，
  // 否则上次失败的残留会让这次触发直接提前退出（实测踩中）
  const errorBefore = (await readKvValue(fetch, args.account, args.token, nsId, 'error')) ?? '';
  console.log('[CF] 立即执行：临时 cron 每分钟触发（CF 调度有分钟级延迟，最长等待 8 分钟）');
  await runRequest(fetch, putSchedulesRequest(args.account, args.token, SCRIPT, ['* * * * *']));
  const deadline = Date.now() + 8 * 60_000;
  let result: string | null = null;
  let error: string | null = null;
  const read = async (key: string): Promise<string | null> => {
    try {
      return await readKvValue(fetch, args.account, args.token, nsId, key);
    } catch {
      return null; // 国内网络抖动：轮询重试即可
    }
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    [result, error] = await Promise.all([read('result'), read('error')]);
    const at = result ? (JSON.parse(result) as { finishedAt?: string }).finishedAt ?? '' : '';
    console.log(`[CF] 等待执行结果（${at && at !== beforeAt ? '有新结果' : at ? '结果未更新' : '暂无'}${error ? ' · 有错误' : ''}）…`);
    if ((at && at !== beforeAt) || (error && error !== errorBefore)) break;
  }
  // 恢复每日定时（无论成败都恢复，避免 cron 停在每分钟）
  await runRequest(fetch, putSchedulesRequest(args.account, args.token, SCRIPT, [dailyCron(cronHourFor(args.hour, args.tz))]));
  if (error && error !== errorBefore) {
    const detail = (JSON.parse(error) as { message?: string }).message ?? error;
    throw new Error(`执行失败：${detail.slice(0, 200)}`);
  }
  if (!result) throw new Error('等待超时：未观察到新结果，请到 Cloudflare 面板查看 worker 日志');
  const entry = JSON.parse(result) as { finishedAt?: string; succeeded: number; total: number };
  if ((entry.finishedAt ?? '') === beforeAt) throw new Error('等待超时：结果未更新');
  console.log(`[CF] 执行完成：${entry.succeeded}/${entry.total} 成功（结果将由 ci-sync 同步到本地）`);
  if (entry.succeeded < entry.total) process.exitCode = 1;
}

// worker.mjs 定位：--script 显式指定 > 数据目录 > 内置引擎目录（execPath 旁）> 引擎源目录（仓库直跑）
export function findWorkerBundle(explicit?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = explicit
    ? [explicit]
    : [
        join(process.cwd(), 'worker.mjs'),
        join(dirname(process.execPath), 'engine', 'worker.mjs'),
        join(here, 'worker.mjs'),
        join(here, '..', 'shell', 'src-tauri', 'resources', 'engine', 'worker.mjs'),
      ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error('找不到 worker.mjs（开发模式先 npm run build:engine；安装包内置于引擎目录）');
}

async function main(): Promise<void> {
  loadDotEnv(workDirRoot()); // env 兜底读数据目录 .env（部署时写回的 CF_*）
  const args = parseDeployArgs(process.argv.slice(2), process.env);
  if (args.triggerNow) return triggerNow(args);
  const cron = dailyCron(cronHourFor(args.hour, args.tz));
  if (args.cronOnly) {
    // CF 平台的「保存定时」：只改 cron 触发器
    await runRequest(fetch, putSchedulesRequest(args.account, args.token, SCRIPT, [cron]));
    console.log(`[CF] 定时已更新：${args.tz} ${args.hour}:00（cron ${cron} UTC）`);
    return;
  }

  const root = workDirRoot();
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as ConfigFile;
  const plan = buildDeployPlan(config, process.env, args);
  const scriptIdx = process.argv.indexOf('--script');
  const code = readFileSync(
    findWorkerBundle(scriptIdx === -1 ? undefined : process.argv[scriptIdx + 1]),
    'utf8',
  );

  const nsId = await ensureKvNamespace(fetch, args.account, args.token, KV_TITLE);
  // 一键幂等：KV 配置随时可写（独立于 worker）；脚本按指纹比对，相同跳过上传（省频控），
  // 不同则先上传——Secrets/Schedules 端点要求 worker 已存在，必须排在脚本之后
  await runRequest(fetch, putKvValueRequest(args.account, args.token, nsId, 'config', plan.kvConfig));
  const sha = workerSha(code);
  const remoteSha = await readKvValue(fetch, args.account, args.token, nsId, KV_KEY_WORKER_SHA);
  if (remoteSha === sha) {
    console.log(`[CF] worker 已是最新（${sha.slice(0, 8)}），跳过脚本上传`);
  } else {
    await runRequest(fetch, await deployWorkerRequest(args.account, args.token, SCRIPT, nsId, plan.crons, code));
    await runRequest(fetch, putKvValueRequest(args.account, args.token, nsId, KV_KEY_WORKER_SHA, sha));
    console.log(`[CF] worker 脚本已上传（${sha.slice(0, 8)}）`);
  }
  for (const secret of plan.secrets) {
    await runRequest(fetch, putSecretRequest(args.account, args.token, SCRIPT, secret.name, secret.value));
  }
  await runRequest(fetch, putSchedulesRequest(args.account, args.token, SCRIPT, plan.crons));
  // 部署元信息写回 .env：ci-sync 的 KV 分支与 --trigger-now 都从这里读；写回后自检防静默丢失
  const envFile = join(root, '.env');
  setEnvValue(envFile, 'CF_ACCOUNT_ID', args.account);
  setEnvValue(envFile, 'CF_API_TOKEN', args.token);
  setEnvValue(envFile, 'CF_KV_NAMESPACE', nsId);
  if (!readFileSync(envFile, 'utf8').includes(`CF_KV_NAMESPACE=${nsId}`)) {
    throw new Error(`CF 配置回写 .env 未生效（${envFile}），同步将报配置不完整`);
  }
  console.log(`[CF] 部署完成：worker ${SCRIPT} · KV ${KV_TITLE}（${nsId.slice(0, 8)}…）· 定时 ${args.tz} ${args.hour}:00`);
}

// 仅直接执行时运行；被测试 import 时不能发起真实请求
if (/cf-deploy\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    console.error(`[CF] ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
