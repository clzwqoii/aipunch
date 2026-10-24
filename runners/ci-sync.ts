import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultFile } from '../core/result.ts';
import { checkGh, configRepo, gh, mergeRunResults } from './ci-checkin.ts';
import { loadDotEnv } from '../core/dotenv.ts';
import { readKvValue } from '../cloudflare/cf-api.ts';

// 拉取云端最新完成运行的签到结果（不限触发来源：定时 / 网页 / 桌面端触发都算），
// 比本地新则按账号合并写 .aipunch-last-run.json 并追加 .aipunch-runs.json。
// 解决的缺口（ADR 0004）：定时 cron 跑完后桌面端看不到结果，「今日已签」永远只认本地触发的运行。
// 只读不触发：与 ci-checkin（触发+等待）互补，可安全在启动时静默执行。
const WORKFLOW = 'checkin.yml';

export interface SyncRunSummary {
  databaseId: number;
  event?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
}

// 最新一条已完成运行；定时/网页/手动触发的运行一视同仁（与 ci-checkin 的 pickRun 语义不同）
export function pickLatestCompleted<T extends SyncRunSummary>(runs: T[]): T | null {
  const done = runs.filter((r) => r.status === 'completed');
  return done.sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}

// 只有远端比本地新才同步：避免把较旧的云端结果合并覆盖本地更新的单跑结果
export function shouldSync(remoteUpdatedAt: string | undefined, localFinishedAt: string | undefined): boolean {
  if (!remoteUpdatedAt) return false;
  if (!localFinishedAt) return true;
  return Date.parse(remoteUpdatedAt) > Date.parse(localFinishedAt);
}

// 该运行是否已拉取过：artifact 的 finishedAt 早于运行的 updatedAt，时间比较挡不住重复同步，
// 用 runId 精确防重；旧格式历史条目无 runId 视为未同步（幂等合并，重拉无害）
export function isSynced(history: Array<{ runId?: number }>, runId: number): boolean {
  return history.some((h) => h.runId === runId);
}

// 执行平台来自 config.json（与桌面端「云端 CI」单选一致）；缺省视为 github-actions（向后兼容）
export function platformFromConfig(cwd: string = process.cwd()): string {
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')) as { platform?: unknown };
    return typeof cfg.platform === 'string' ? cfg.platform : '';
  } catch {
    return '';
  }
}

// KV 源同步计划（ADR 0004 cloudflare-workers）：无结果/已同步/不比本地新 → 跳过；否则放行
export function planKvSync(
  raw: string | null,
  prev: ResultFile | null,
  history: Array<{ runId?: number }>,
): { skip: true; reason: string } | { skip: false; entry: ResultFile } {
  if (!raw) return { skip: true, reason: 'KV 暂无结果' };
  const entry = JSON.parse(raw) as ResultFile;
  if (entry.runId !== undefined && isSynced(history, entry.runId)) {
    return { skip: true, reason: `运行 #${entry.runId} 已同步` };
  }
  if (!shouldSync(entry.finishedAt, prev?.finishedAt)) {
    return { skip: true, reason: '本地已是最新' };
  }
  return { skip: false, entry };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback; // 旧文件损坏时按无记录处理
  }
}

// cloudflare-workers 分支：KV result 键为事实源（cron 触发的结果写 KV），拉取合并语义与 GitHub 一致
async function mainKv(): Promise<void> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  const nsId = process.env.CF_KV_NAMESPACE;
  if (!accountId || !token || !nsId) {
    console.log('[SYNC] CF 配置不完整（CF_ACCOUNT_ID / CF_API_TOKEN / CF_KV_NAMESPACE），请先在桌面端部署 Cloudflare Workers');
    process.exitCode = 1;
    return;
  }
  const raw = await readKvValue(fetch, accountId, token, nsId, 'result');
  const cwd = process.cwd();
  const prev = readJson<ResultFile | null>(join(cwd, '.aipunch-last-run.json'), null);
  const history = readJson<ResultFile[]>(join(cwd, '.aipunch-runs.json'), []);
  const plan = planKvSync(raw, prev, history);
  if (plan.skip) {
    console.log(`[SYNC] ${plan.reason}`);
    return;
  }
  writeFileSync(join(cwd, '.aipunch-last-run.json'), JSON.stringify(mergeRunResults(prev, plan.entry, true), null, 1));
  writeFileSync(join(cwd, '.aipunch-runs.json'), JSON.stringify([plan.entry, ...history].slice(0, 50), null, 1));
  console.log(`[SYNC] 已同步 CF 运行 #${plan.entry.runId ?? '?'}：${plan.entry.succeeded}/${plan.entry.total} 成功`);
}

async function main(): Promise<void> {
  // CF 分支的 CF_* 配置在 .env（部署时写回）：与 cli/cf-deploy 同款，先注入再读
  loadDotEnv();
  if (platformFromConfig() === 'cloudflare-workers') return mainKv();
  const repo = configRepo();
  await checkGh(gh, repo);
  const raw = await gh([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    WORKFLOW,
    '--limit',
    '10',
    '--json',
    'databaseId,event,createdAt,updatedAt,status,conclusion,url',
  ]);
  const latest = pickLatestCompleted(JSON.parse(raw) as SyncRunSummary[]);
  if (!latest) {
    console.log('[SYNC] 云端暂无已完成的运行');
    return;
  }
  const cwd = process.cwd();
  const lastPath = join(cwd, '.aipunch-last-run.json');
  const historyPath = join(cwd, '.aipunch-runs.json');
  const prev = readJson<ResultFile | null>(lastPath, null);
  const history = readJson<ResultFile[]>(historyPath, []);

  if (isSynced(history, latest.databaseId) || !shouldSync(latest.updatedAt, prev?.finishedAt)) {
    console.log(`[SYNC] 本地已是最新（云端最新完成运行 #${latest.databaseId}，${latest.event ?? ''}）`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'aipunch-sync-'));
  try {
    await gh(['run', 'download', String(latest.databaseId), '--repo', repo, '-n', 'checkin-result', '-D', dir]);
    const data = JSON.parse(readFileSync(join(dir, 'checkin-result.json'), 'utf8')) as ResultFile;
    const entry: ResultFile = { ...data, runId: latest.databaseId, runUrl: latest.url };
    // 合并语义：云端结果按 provider/account 覆盖本地（完整运行=全量覆盖，过滤运行=只覆盖对应账号）
    writeFileSync(lastPath, JSON.stringify(mergeRunResults(prev, entry, true), null, 1));
    writeFileSync(historyPath, JSON.stringify([entry, ...history].slice(0, 50), null, 1));
    console.log(`[SYNC] 已同步云端运行 #${latest.databaseId}（${latest.event ?? ''}）：${entry.succeeded}/${entry.total} 成功`);
  } catch {
    // artifact 缺失（旧运行/上传失败）时跳过，下次启动或手动刷新再试
    console.log(`[SYNC] 运行 #${latest.databaseId} 无结果产物，跳过`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 仅直接执行时运行；被测试 import 时不能发起真实请求（与 ci-checkin 同款守卫）
if (/ci-sync\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    console.error(`[SYNC] ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
