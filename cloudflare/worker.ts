// deploy-marker: 2026-11-11 重新部署（排查 cron 停摆：schedules 为每分钟但无执行）
// Cloudflare Workers 签到执行端（ADR 0004 P2）：cron trigger 触发全量签到，
// 结果写 KV 供桌面端 ci-sync 拉取；轮换票经 CF API 自我回写 Secrets（KV 不落敏感 token）。
// providers/core 全部纯 fetch 逻辑，无 node:fs（node:crypto 走 nodejs_compat）；dns-fallback 不打包。
import { runCheckins } from '../core/executor.ts';
import { resolveAccounts, type ConfigFile } from '../core/config.ts';
import { fetchWithTimeout } from '../core/http.ts';
import { toResultFile } from '../core/result.ts';
import { rotationNotices } from '../core/token-rotation.ts';
import type { RunResult } from '../core/types.ts';
import '../providers/index.ts';

const SCRIPT_NAME = 'aipunch-checkin';

// Workers KV 绑定的最小形态（不引 @cloudflare/workers-types）
interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  // Secrets（凭证）与文本绑定都以字符串注入
  [secret: string]: string | undefined;
  AIPUNCH_KV: KVLike;
  // 自回写轮换票的管理凭证（部署时写入）
  // ponytail: 先直通用户粘贴的 API Token，受限 token 生成器（POST /user/tokens）后续加
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}

// Secrets 视图：剥离 KV namespace 等非字符串绑定，供 resolveAccounts 注入
export function secretsView(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

export const RUNS_KEY = 'runs';
export const RUNS_LIMIT = 30;

// KV 历史：新到旧、同 runId 覆盖、限 30 条（KV 值有大小上限，只保留结构化摘要）
export function pushRunHistory(prevRaw: string | null, entry: { runId?: number }, limit = RUNS_LIMIT): unknown[] {
  let prev: unknown[] = [];
  try {
    const parsed = prevRaw ? JSON.parse(prevRaw) : [];
    if (Array.isArray(parsed)) prev = parsed.filter((x) => x && typeof x === 'object');
  } catch {
    prev = [];
  }
  const rest = prev.filter((x) => (x as { runId?: number }).runId !== entry.runId);
  return [entry, ...rest].slice(0, limit);
}

// KV result 条目：结构化结果 + 时间戳 runId（ci-sync 按 finishedAt 判新、runId 防重）
export function kvResultEntry(result: RunResult, now: Date) {
  return { ...toResultFile(result), runId: now.getTime(), finishedAt: now.toISOString() };
}

// 热 isolate 的 env 绑定不会随 Secrets 更新：回写成功后同一 isolate 的下一轮仍读旧票，
// 拿已作废的一次性票刷新会连续 400（实测 12:20 成功、12:31 起失败）。模块级缓存记住本
// isolate 生命周期内的轮换结果；isolate 冷启动后自然回落到 Secrets 里的值。
const runtimeRotations = new Map<string, string>();

export function applyRotations(
  view: Record<string, string | undefined>,
  cache: ReadonlyMap<string, string>,
): Record<string, string | undefined> {
  if (cache.size === 0) return view;
  const merged = { ...view };
  for (const [name, value] of cache) merged[name] = value;
  return merged;
}

// trigger-now 会把 cron 临时改成每分钟；进程被杀或网络失败时恢复步骤不会执行，
// 残留的每分钟 cron 会每天烧掉约 4 倍 KV 写配额（3 次/执行 × 1440）。这里兜底自愈。
const CRON_GRACE_MS = 10 * 60_000;
const DEFAULT_DAILY_CRON = '0 03 * * *';

export function shouldSelfHealCron(
  cron: string | undefined,
  triggerAt: string | undefined,
  now: Date,
  graceMs: number,
): boolean {
  if (cron !== '* * * * *') return false;
  const at = Number(triggerAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now.getTime() - at > graceMs;
}

async function restoreDailyCron(env: Env): Promise<void> {
  // 部署时写入的 cron_spec 才是用户配置的时间；读不到才用默认
  const spec = (await env.AIPUNCH_KV.get('cron_spec').catch(() => null)) ?? DEFAULT_DAILY_CRON;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ cron: spec }]),
    },
  );
  if (!res.ok) throw new Error(`恢复每日 cron 失败: HTTP ${res.status}`);
}

// 轮换票自我回写：PUT secrets（单条端点，无需重传脚本）
async function putSecret(env: Env, name: string, value: string): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/secrets`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text: value, type: 'secret_text' }),
    },
  );
  if (!res.ok) throw new Error(`回写 Secret ${name} 失败: HTTP ${res.status}`);
}

// 轮换票回写：瞬时错误重试一次；仍失败必须返回失败说明，由调用方暴露（一次性票作废后没人知道就会永久断链）
export async function persistRotations(
  env: Env,
  result: RunResult,
  put: (env: Env, name: string, value: string) => Promise<void> = putSecret,
): Promise<string[]> {
  const failures: string[] = [];
  for (const notice of rotationNotices(result)) {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await put(env, notice.name, notice.token);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }
    if (lastError) failures.push(`${notice.name}: ${lastError.message}`);
  }
  return failures;
}

async function runScheduled(env: Env): Promise<void> {
  const raw = await env.AIPUNCH_KV.get('config');
  if (!raw) throw new Error('KV 缺少 config：请经桌面端部署写入');
  const config = JSON.parse(raw) as ConfigFile;
  const accounts = resolveAccounts(config, applyRotations(secretsView(env), runtimeRotations));
  const result = await runCheckins(accounts, { now: new Date(), fetch: fetchWithTimeout(30_000) });
  // 先记内存再回写：回写失败时本 isolate 的后续轮次仍能用新票，不至于当场断链
  for (const notice of rotationNotices(result)) runtimeRotations.set(notice.name, notice.token);
  const entry = kvResultEntry(result, new Date());
  await env.AIPUNCH_KV.put('result', JSON.stringify(entry));
  // 历史留着可回溯（KV 的 result 只存最新一条）；写失败不影响本次签到
  await env.AIPUNCH_KV.get(RUNS_KEY)
    .then((prev) => env.AIPUNCH_KV.put(RUNS_KEY, JSON.stringify(pushRunHistory(prev, entry))))
    .catch(() => {});
  // 轮换票只进 Secrets 不进 KV；单条失败不中断（下轮用旧票会失败并重试轮换）
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    const failures = await persistRotations(env, result);
    // 失败不能静默：旧票已作废，下一轮必失败；抛错让 error 落 KV 并在面板显示失败
    if (failures.length > 0) {
      throw new Error(`轮换票回写失败（${failures.join('; ')}）——下一轮将使用已作废的旧票，请重新导入凭证`);
    }
  }
  if (result.succeeded < result.total) {
    throw new Error(`签到 ${result.succeeded}/${result.total} 成功`); // 抛错让本次 cron 运行在面板显示失败
  }
}

export default {
  async scheduled(event: { cron?: string }, env: Env, _ctx: unknown): Promise<void> {
    try {
      // 兜底：上一次 trigger-now 中断导致 cron 停在每分钟时，恢复用户配置的每日时间
      const triggerAt = await env.AIPUNCH_KV.get('trigger_at').catch(() => null);
      if (shouldSelfHealCron(event.cron, triggerAt ?? undefined, new Date(), CRON_GRACE_MS)) {
        await restoreDailyCron(env);
      }
      await runScheduled(env);
      await env.AIPUNCH_KV.put('error', '').catch(() => {});
    } catch (err) {
      // 执行失败落 KV：桌面端与面板都无需 tail 日志即可诊断（CF tail 不支持 Token 认证）
      const message = (err as Error).message.slice(0, 2000);
      await env.AIPUNCH_KV.put('error', JSON.stringify({ at: new Date().toISOString(), message })).catch(() => {});
      throw err;
    }
  },
};
