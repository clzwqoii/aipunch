// 桌面端「部署到 Cloudflare Workers」（ADR 0004 P2）：粘贴 API Token + Account ID，
// 全 REST 代部署（KV namespace + worker 脚本 + 凭证 Secrets + cron），无需 wrangler/git。
// 用法：
//   npm run cf-deploy -- --token <t> --account <id> [--hour 11] [--tz Asia/Shanghai] [--script <worker.mjs>]
//   npm run cf-deploy -- --trigger-now   # 立即执行：临时把 cron 改到下一分钟，KV 出结果后恢复（workers.dev 国内被墙不走 HTTP）
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 数据目录定位：Rust 注入的 AIPUNCH_WORK_DIR 是唯一事实源；直接终端跑时回退 cwd
// （此前按 process.cwd() 定位 .env，dev/安装模式下 cwd 错位导致 CF 配置回写丢失）
export function workDirRoot(): string {
  return process.env.AIPUNCH_WORK_DIR ?? process.cwd();
}
import type { ConfigFile } from '../core/config.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';
import { cronHourFor } from './ci-checkin.ts';
import {
  dailyCron,
  deployWorkerRequest,
  ensureKvNamespace,
  nextMinuteCron,
  putKvValueRequest,
  putSecretRequest,
  putSchedulesRequest,
  readKvValue,
  runRequest,
} from '../cloudflare/cf-api.ts';

const SCRIPT = 'aipunch-checkin';
const KV_TITLE = 'aipunch';

export interface DeployArgs {
  token: string;
  account: string;
  hour: string; // 两位 00-23
  tz: string;
  cronOnly: boolean; // 只更新 cron 触发器（CF 平台的「保存定时」）
  credsOnly: boolean; // 只保存凭证到 .env（已部署但回写丢失/换机场景；不重新上传脚本，无频控）
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
    credsOnly: argv.includes('--creds-only'),
    triggerNow: argv.includes('--trigger-now'),
  };
}

// 部署计划：KV config（只含 accounts，platform 是桌面端概念不下发）、Secrets 清单（CF 管理凭证 + 账号凭证）、cron
export function buildDeployPlan(
  config: ConfigFile,
  env: Record<string, string | undefined>,
  args: Pick<DeployArgs, 'token' | 'account' | 'hour' | 'tz'>,
): { kvConfig: string; secrets: Array<{ name: string; value: string }>; crons: string[] } {
  const missing = config.accounts.flatMap((a) =>
    [a.tokenEnv, a.refreshTokenEnv].filter((n): n is string => !!n && !env[n]),
  );
  if (missing.length > 0) {
    throw new Error(`以下凭证未在 .env/环境中配置，无法部署：${missing.join(', ')}（请先在桌面端完成凭证导入）`);
  }
  const accountSecrets = config.accounts.flatMap((a) =>
    [a.tokenEnv, a.refreshTokenEnv].filter((n): n is string => !!n).map((n) => ({ name: n, value: env[n] as string })),
  );
  return {
    kvConfig: JSON.stringify({ accounts: config.accounts }),
    secrets: [
      { name: 'CF_ACCOUNT_ID', value: args.account },
      { name: 'CF_API_TOKEN', value: args.token },
      ...accountSecrets,
    ],
    crons: [dailyCron(cronHourFor(args.hour, args.tz))],
  };
}

// 立即执行：cron 临时改到下一分钟 → 轮询 KV result 更新 → 恢复每日 cron（ADR 0004 不走 workers.dev）
async function triggerNow(args: DeployArgs): Promise<void> {
  const nsId = process.env.CF_KV_NAMESPACE;
  if (!nsId) throw new Error('尚未部署（缺 CF_KV_NAMESPACE）：请先完整部署一次');
  const before = await readKvValue(fetch, args.account, args.token, nsId, 'result');
  const beforeAt = before ? (JSON.parse(before) as { finishedAt?: string }).finishedAt : '';
  const temp = nextMinuteCron(new Date());
  console.log(`[CF] 立即执行：临时 cron ${temp}（UTC）`);
  await runRequest(fetch, putSchedulesRequest(args.account, args.token, SCRIPT, [temp]));
  const deadline = Date.now() + 5 * 60_000;
  let latestAt = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    const raw = await readKvValue(fetch, args.account, args.token, nsId, 'result');
    latestAt = raw ? (JSON.parse(raw) as { finishedAt?: string }).finishedAt ?? '' : '';
    console.log(`[CF] 等待执行结果（当前 ${latestAt || '无'}）…`);
    if (latestAt && latestAt !== beforeAt) break;
  }
  // 恢复每日定时（无论成功失败都恢复，避免 cron 停在一次性表达式上）
  await runRequest(fetch, putSchedulesRequest(args.account, args.token, SCRIPT, [dailyCron(cronHourFor(args.hour, args.tz))]));
  if (!latestAt || latestAt === beforeAt) throw new Error('等待超时：未观察到新结果，请到 Cloudflare 面板查看 worker 日志');
  const entry = JSON.parse((await readKvValue(fetch, args.account, args.token, nsId, 'result')) as string) as {
    succeeded: number;
    total: number;
  };
  console.log(`[CF] 执行完成：${entry.succeeded}/${entry.total} 成功（结果将由「立即刷新」同步到本地）`);
  if (entry.succeeded < entry.total) process.exitCode = 1;
}

// worker.mjs 定位：--script 显式指定 > 数据目录 > 内置引擎目录（execPath 旁的 engine/）
function findWorkerBundle(explicit?: string): string {
  const candidates = explicit
    ? [explicit]
    : [join(process.cwd(), 'worker.mjs'), join(dirname(process.execPath), 'engine', 'worker.mjs')];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error('找不到 worker.mjs（开发模式先 npm run build:engine；安装包内置于引擎目录）');
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseDeployArgs(process.argv.slice(2), process.env);
  if (args.triggerNow) return triggerNow(args);
  const cron = dailyCron(cronHourFor(args.hour, args.tz));
  if (args.credsOnly) {
    // 只保存凭证：查现有 KV namespace（已存在则纯读，不创建不上传，无频控），写回 .env
    const nsId = await ensureKvNamespace(fetch, args.account, args.token, KV_TITLE);
    const envFile = join(workDirRoot(), '.env');
    setEnvValue(envFile, 'CF_ACCOUNT_ID', args.account);
    setEnvValue(envFile, 'CF_API_TOKEN', args.token);
    setEnvValue(envFile, 'CF_KV_NAMESPACE', nsId);
    if (!readFileSync(envFile, 'utf8').includes(`CF_KV_NAMESPACE=${nsId}`)) {
      throw new Error('凭证写回 .env 未生效，请检查数据目录可写');
    }
    console.log('[CF] 凭证已保存到本机 .env（worker 与部署保持现状，未重新上传）');
    return;
  }
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
  await runRequest(fetch, putKvValueRequest(args.account, args.token, nsId, 'config', plan.kvConfig));
  await runRequest(fetch, await deployWorkerRequest(args.account, args.token, SCRIPT, nsId, plan.crons, code));
  for (const secret of plan.secrets) {
    await runRequest(fetch, putSecretRequest(args.account, args.token, SCRIPT, secret.name, secret.value));
  }
  // 部署元信息写回 .env：ci-sync 的 KV 分支与 --trigger-now 都从这里读；写回后自检防静默丢失
  const envFile = join(workDirRoot(), '.env');
  setEnvValue(envFile, 'CF_ACCOUNT_ID', args.account);
  setEnvValue(envFile, 'CF_API_TOKEN', args.token);
  setEnvValue(envFile, 'CF_KV_NAMESPACE', nsId);
  if (!readFileSync(envFile, 'utf8').includes(`CF_KV_NAMESPACE=${nsId}`)) {
    console.log(`[CF] 警告：CF 配置回写 .env 未生效（${envFile}），「立即刷新」同步将报配置不完整`);
  }
  console.log(`[CF] 部署完成：worker ${SCRIPT} · KV ${KV_TITLE}（${nsId.slice(0, 8)}…）`);
  console.log(`[CF] 定时 ${args.tz} ${args.hour}:00（cron ${plan.crons[0]} UTC）；凭证已入 Secrets，轮换票由 worker 自动回写`);
}

// 仅直接执行时运行；被测试 import 时不能发起真实请求
if (/cf-deploy\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    console.error(`[CF] ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
