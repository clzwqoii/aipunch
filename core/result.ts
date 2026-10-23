import type { RunResult } from './types.ts';

// 结构化回传：CI 产物里的精简结果，桌面端据此在卡片上展示余额
export interface Balance {
  remain: number;
  limit?: number;
  unlimited?: boolean;
}

export interface ResultEntry {
  provider: string;
  account: string;
  ok: boolean;
  message: string;
  balance: Balance | null;
}

export interface ResultFile {
  finishedAt: string;
  runUrl?: string; // ci-checkin 补写，桌面端点击状态环可跳转
  total: number;
  succeeded: number;
  results: ResultEntry[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// 各 Provider 的 detail 形状不同，这里统一成 { remain, limit? }
export function extractBalance(detail: unknown): Balance | null {
  const d = (detail ?? {}) as Record<string, unknown>;
  const usage = d.usage as Record<string, unknown> | undefined;
  if (usage && Number.isFinite(Number(usage.remain))) {
    return {
      remain: round2(Number(usage.remain)),
      ...(Number.isFinite(Number(usage.limit)) ? { limit: round2(Number(usage.limit)) } : {}),
      ...(usage.unlimited === true ? { unlimited: true } : {}),
    };
  }
  const balance = d.balance as Record<string, unknown> | undefined;
  if (balance && Number.isFinite(Number(balance.remain))) {
    return { remain: round2(Number(balance.remain)) };
  }
  const after = d.balanceAfter as Record<string, unknown> | undefined;
  if (after && Number.isFinite(Number(after.remain))) {
    return { remain: round2(Number(after.remain)) };
  }
  return null;
}

export function toResultFile(result: RunResult): ResultFile {
  return {
    finishedAt: result.finishedAt,
    total: result.total,
    succeeded: result.succeeded,
    results: result.results.map((r) => ({
      provider: r.provider,
      account: r.account,
      ok: r.ok,
      message: r.message,
      balance: extractBalance(r.detail),
    })),
  };
}
