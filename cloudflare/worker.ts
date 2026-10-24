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

// KV result 条目：结构化结果 + 时间戳 runId（ci-sync 按 finishedAt 判新、runId 防重）
export function kvResultEntry(result: RunResult, now: Date) {
  return { ...toResultFile(result), runId: now.getTime(), finishedAt: now.toISOString() };
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

async function runScheduled(env: Env): Promise<void> {
  const raw = await env.AIPUNCH_KV.get('config');
  if (!raw) throw new Error('KV 缺少 config：请经桌面端部署写入');
  const config = JSON.parse(raw) as ConfigFile;
  const accounts = resolveAccounts(config, secretsView(env));
  const result = await runCheckins(accounts, { now: new Date(), fetch: fetchWithTimeout(30_000) });
  await env.AIPUNCH_KV.put('result', JSON.stringify(kvResultEntry(result, new Date())));
  // 轮换票只进 Secrets 不进 KV；单条失败不中断（下轮用旧票会失败并重试轮换）
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    for (const notice of rotationNotices(result)) {
      await putSecret(env, notice.name, notice.token).catch((err: unknown) => {
        console.log(`[ROTATE] ${(err as Error).message}`);
      });
    }
  }
  if (result.succeeded < result.total) {
    throw new Error(`签到 ${result.succeeded}/${result.total} 成功`); // 抛错让本次 cron 运行在面板显示失败
  }
}

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    await runScheduled(env);
  },
};
