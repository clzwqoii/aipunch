import { createHash, createHmac } from 'node:crypto';

// 华为云 SDK-HMAC-SHA256 请求签名（契约来源 RobbsLuo/Coding2API，逐行对照官方 AKSKSigner）：
//   CanonicalURI：每段 percent-encode 且末尾补 `/`（漏尾斜杠是 APIG.0301 常见原因）
//   CanonicalQuery：key/value 编码后按键字典序排列
//   CanonicalHeaders：全部头小写排序，`k:v\n`
//   SignedHeaders = 全部头（分号串）；payload hash 取 X-Sdk-Content-Sha256 的值
//   CanonicalRequest = METHOD\nCanonicalURI\nCanonicalQuery\nCanonicalHeaders\nSignedHeaders\npayloadHash
//   StringToSign = SDK-HMAC-SHA256\nX-Sdk-Date\nsha256(CanonicalRequest)
//   Signature = HMAC-SHA256(SK, StringToSign) hex
//   Authorization = `SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=<...>, Signature=<...>`
// 凭据是 STS 临时 AK/SK（+X-Security-Token），不是 bearer。

const SIGNING_ALGORITHM = 'SDK-HMAC-SHA256';

export interface SignCredential {
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
}

function sha256Hex(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function canonicalUri(path: string): string {
  const joined = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return joined.endsWith('/') ? joined : `${joined}/`;
}

export function canonicalQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  const pairs: Array<[string, string]> = [];
  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const value = eq >= 0 ? part.slice(eq + 1) : '';
    pairs.push([encodeURIComponent(key), encodeURIComponent(value)]);
  }
  pairs.sort();
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function canonicalHeaders(headers: Record<string, string>): { text: string; signed: string } {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = String(value).replace(/\r/g, '').replace(/\n/g, '').trim();
  }
  const keys = Object.keys(lowered).sort();
  return {
    text: keys.map((key) => `${key}:${lowered[key]}\n`).join(''),
    signed: keys.join(';'),
  };
}

export function canonicalRequest(
  method: string,
  path: string,
  rawQuery: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const { text, signed } = canonicalHeaders(headers);
  return [
    method.toUpperCase(),
    canonicalUri(path),
    canonicalQuery(rawQuery),
    text,
    signed,
    payloadHash,
  ].join('\n');
}

export function stringToSign(canonicalRequestText: string, xSdkDate: string): string {
  return [SIGNING_ALGORITHM, xSdkDate, sha256Hex(canonicalRequestText)].join('\n');
}

// X-Sdk-Date 格式：UTC `YYYYMMDDTHHMMSSZ`
export function sdkDate(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export interface SignOptions {
  method: string;
  path: string;
  rawQuery?: string;
  headers: Record<string, string>;
  payload?: Buffer;
  xSdkDate: string;
  traceId?: string;
}

// 给一次请求补齐签名头（返回合并后的完整头，不改入参）
export function signHeaders(credential: SignCredential, options: SignOptions): Record<string, string> {
  const merged: Record<string, string> = { ...options.headers };
  merged['X-Sdk-Date'] = options.xSdkDate;
  if (credential.securityToken) {
    merged['X-Security-Token'] = credential.securityToken;
  }
  const payloadHash = sha256Hex(options.payload ?? Buffer.from(''));
  merged['X-Sdk-Content-Sha256'] = payloadHash;
  if (options.traceId) {
    merged['x-snap-traceid'] = options.traceId;
  }
  const request = canonicalRequest(options.method, options.path, options.rawQuery ?? '', merged, payloadHash);
  const { signed } = canonicalHeaders(merged);
  const signature = createHmac('sha256', credential.secretAccessKey).update(stringToSign(request, options.xSdkDate)).digest('hex');
  merged.Authorization = `${SIGNING_ALGORITHM} Access=${credential.accessKeyId}, SignedHeaders=${signed}, Signature=${signature}`;
  return merged;
}
