// 单请求超时：顺序执行时任一账号网络挂起会拖住整轮签到（shell 里表现为「卡住」）。
// 默认 30s，可用 CHECKIN_REQUEST_TIMEOUT_MS 覆盖；<=0 表示不设超时。
export function fetchWithTimeout(timeoutMs: number, fetchImpl: typeof fetch = fetch): typeof fetch {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl;
  return (input, init) =>
    fetchImpl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
}
