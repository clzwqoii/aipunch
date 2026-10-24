// 云端平台可达性检查（ADR 0003：国内可达性是平台选型的真实约束）。
// 输出稳定格式的 [NET] 行，桌面端据 stdout 解析更新「网络状态」展示；退出码恒 0（纯诊断不报错）。
export const NET_TARGETS = [
  // zen：免认证轻量端点；gh 触发/同步/仓库走同一 api.github.com 域
  { name: 'GitHub', url: 'https://api.github.com/zen' },
  // 根路径返回 4xx 信封也证明 TCP/TLS/HTTP 通（CF 部署/定时/同步走该域）
  { name: 'Cloudflare', url: 'https://api.cloudflare.com/client/v4/' },
] as const;

export interface NetResult {
  ok: boolean;
  ms?: number;
  status?: number;
  reason?: string;
}

export function netLine(name: string, result: NetResult): string {
  if (result.ok) return `[NET] ${name}: ok ${result.ms}ms HTTP ${result.status}`;
  return `[NET] ${name}: fail ${result.reason ?? '未知错误'}`;
}

async function main(): Promise<void> {
  await Promise.all(
    NET_TARGETS.map(async (target) => {
      const started = Date.now();
      try {
        const res = await fetch(target.url, { signal: AbortSignal.timeout(8000) });
        console.log(netLine(target.name, { ok: true, ms: Date.now() - started, status: res.status }));
      } catch (err) {
        const cause = err as Error;
        const reason = cause.name === 'TimeoutError' || cause.name === 'AbortError' ? '超时' : cause.message.slice(0, 80);
        console.log(netLine(target.name, { ok: false, reason }));
      }
    }),
  );
  console.log('[NET] 提示：不可达时国内网络可配置代理，或选择可达的执行平台');
}

// 仅直接执行时运行；被测试 import 时不发请求
if (/netcheck\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  void main();
}
