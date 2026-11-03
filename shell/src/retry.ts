// 网络抖动重试：总尝试次数 = delaysMs.length + 1；每次重试前按 delaysMs 等待。
// 用于「检查更新」这类对 GitHub/系统代理链路敏感、且失败无副作用的请求。
export async function retryAsync<T>(fn: () => Promise<T>, delaysMs: number[] = [1000, 2000]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < delaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }
  }
  throw lastError;
}
