import { appendFileSync } from 'node:fs';
import type { RunResult } from './types.ts';

// 轮换后的新 refreshToken 列表：[{ Secret 名（回落 provider/account）, 新 token }]
export function rotationNotices(result: RunResult): Array<{ name: string; token: string }> {
  return result.results
    .filter((r) => r.rotatedRefreshToken)
    .map((r) => ({
      name: r.refreshTokenEnv ?? `${r.provider}/${r.account}`,
      token: r.rotatedRefreshToken as string,
    }));
}

// 把轮换后的新 refreshToken 写入文件（CI 据此更新 Secret）。
// 每账号一行 `<refreshTokenEnv>=<token>`；多账号的 Secret 映射由调用方消费。
// ponytail: 只做文件落盘，不内置各 CI 平台的 Secret API；GitHub 场景由 workflow 用 gh CLI 消费
export function persistRotatedTokens(result: RunResult, filePath: string): string[] {
  const notices = rotationNotices(result);
  if (notices.length === 0) {
    return [];
  }
  const lines = notices.map((n) => `${n.name}=${n.token}`);
  appendFileSync(filePath, `${lines.join('\n')}\n`);
  return lines;
}
