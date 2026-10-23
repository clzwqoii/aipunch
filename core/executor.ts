import { get } from './registry.ts';
import type { Account, CheckinResult, RunContext, RunResult } from './types.ts';

// ponytail: 顺序执行，账号量大（>20）需要时再改 Promise.all 分批
export async function runCheckins(
  accounts: Account[],
  ctx: RunContext,
  onResult?: (result: RunResult['results'][number]) => void,
): Promise<RunResult> {
  const startedAt = new Date();
  const results: RunResult['results'] = [];
  for (const account of accounts) {
    if (account.enabled === false) continue;
    const started = Date.now();
    let result: CheckinResult;
    try {
      const provider = get(account.provider);
      result = await provider.checkin(account, ctx);
    } catch (err) {
      result = { ok: false, message: `执行异常: ${(err as Error).message}` };
    }
    const entry = {
      account: account.name,
      provider: account.provider,
      ok: result.ok,
      message: result.message,
      durationMs: Date.now() - started,
      detail: result.detail,
      rotatedRefreshToken: result.rotatedRefreshToken,
      refreshTokenEnv: account.refreshTokenEnv,
    };
    results.push(entry);
    onResult?.(entry);
  }
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  };
}
