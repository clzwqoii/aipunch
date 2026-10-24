// Cloudflare REST API 封装（ADR 0004 P2）：桌面端代部署/状态/触发全走 api.cloudflare.com，
// 无需 wrangler/git；worker 自回写 Secrets 复用同一端点（worker.ts 内联实现，仅 PUT 一条）。
// 所有请求构造为 Request 返回（可测），执行统一走 cfFetch（fetch 全局，Node 18+ / Workers 通用）。

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = 'https://api.cloudflare.com/client/v4';

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

// CF 信封错误消息提取（cfFetch 与 runRequest 共用）
async function envelopeError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { errors?: Array<{ message?: string }> };
    return body.errors?.map((e) => e.message).join('; ') || text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

// CF 信封 {success, errors, result}：失败抛出错误消息，成功返回 result
export async function cfFetch<T>(fetchLike: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchLike(url, init);
  if (!res.ok) throw new Error(`CF API ${res.status}: ${await envelopeError(res)}`);
  const body = JSON.parse(await res.text()) as { success: boolean; errors?: Array<{ message?: string }>; result: T };
  if (!body.success) throw new Error(`CF API: ${body.errors?.map((e) => e.message).join('; ')}`);
  return body.result;
}

// 执行预构造的 Request（multipart/secret/kv 写入）：body 读出后转发（幂等可重试）
export async function runRequest(fetchLike: FetchLike, req: Request): Promise<void> {
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const res = await fetchLike(req.url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? await req.clone().text() : undefined,
  });
  if (!res.ok) throw new Error(`CF API ${res.status}: ${await envelopeError(res)}`);
}

// 「立即执行」（ADR 0004）：不走 workers.dev（国内被墙），临时把 cron 改到下一分钟
export function nextMinuteCron(now: Date): string {
  const next = new Date(now.getTime() + 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `0 ${pad(next.getUTCMinutes())} ${pad(next.getUTCHours())} ${pad(next.getUTCDate())} ${pad(next.getUTCMonth() + 1)} *`;
}

// 每日整点（UTC）的 6 段 cron
export function dailyCron(utcHour: string): string {
  return `0 0 ${utcHour} * * *`;
}

// KV namespace：按 title 找，没有则创建（幂等，重复部署复用同一 namespace）
export async function ensureKvNamespace(
  fetchLike: FetchLike,
  accountId: string,
  token: string,
  title: string,
): Promise<string> {
  const list = await cfFetch<Array<{ id: string; title: string }>>(
    fetchLike,
    `${BASE}/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
    { headers: authHeaders(token) },
  );
  const existing = list.find((ns) => ns.title === title);
  if (existing) return existing.id;
  const created = await cfFetch<{ id: string }>(fetchLike, `${BASE}/accounts/${accountId}/storage/kv/namespaces`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return created.id;
}

// KV 读值：404 返回 null（尚未有结果）
export async function readKvValue(
  fetchLike: FetchLike,
  accountId: string,
  token: string,
  namespaceId: string,
  key: string,
): Promise<string | null> {
  const res = await fetchLike(
    `${BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    { headers: authHeaders(token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CF API ${res.status}: KV 读值失败`);
  return res.text();
}

// KV 写值（部署时上传 config）
export function putKvValueRequest(
  accountId: string,
  token: string,
  namespaceId: string,
  key: string,
  value: string,
): Request {
  return new Request(
    `${BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'text/plain' },
      body: value,
    },
  );
}

// 单条 Secret 写入（部署写凭证 / worker 自回写轮换票 共用端点）
export function putSecretRequest(
  accountId: string,
  token: string,
  scriptName: string,
  name: string,
  value: string,
): Request {
  return new Request(`${BASE}/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text: value, type: 'secret_text' }),
  });
}

// cron 触发器（全量覆盖语义）
export function putSchedulesRequest(
  accountId: string,
  token: string,
  scriptName: string,
  crons: string[],
): Request {
  return new Request(`${BASE}/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(crons.map((cron) => ({ cron }))),
  });
}

// 部署 worker 脚本（multipart）：KV 绑定 + 管理凭证占位 Secret + cron 触发器 + 兼容日期。
// 凭证 Secret 的值走 putSecretRequest 单独写入（multipart 只声明绑定名，避免脚本内容携带明文）。
export async function deployWorkerRequest(
  accountId: string,
  token: string,
  scriptName: string,
  kvNamespaceId: string,
  crons: string[],
  scriptCode: string,
): Promise<Request> {
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      main_module: 'worker.mjs',
      compatibility_date: '2026-10-01',
      bindings: [
        { type: 'kv_namespace', name: 'AIPUNCH_KV', namespace_id: kvNamespaceId },
        { type: 'secret_text', name: 'CF_ACCOUNT_ID' },
        { type: 'secret_text', name: 'CF_API_TOKEN' },
      ],
      triggers: { crons },
    }),
  );
  form.set('worker.mjs', new File([scriptCode], 'worker.mjs', { type: 'text/javascript' }));
  return new Request(`${BASE}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: form,
  });
}
