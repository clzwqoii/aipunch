import { createHash, randomBytes } from 'node:crypto';

// 码道登录链的纯函数部分（契约来源 RobbsLuo/Coding2API auth.py，逆向记录 §3）：
// PKCE + ticket 轮询 + 门户授权 URL。HTTP 编排（浏览器/回调服务器/轮询）在
// runners/codearts-login.ts，这里只留可测的构造与判定。

export const LOGIN_CONFIG = {
  clientId: 'codearts-agent',
  portalHost: 'https://codearts.huaweicloud.com/portal',
  snapManager: 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager',
  stsHost: 'https://sts.cn-north-4.myhuaweicloud.com',
  redirectPath: '/oauth/callback',
  pluginName: 'huaweicloud.authentication',
  pluginVersion: '1.0.0',
  // portal 只认插件实际使用的方法名，'S256' 会被拒
  codeChallengeMethod: 'SHA-256',
} as const;

export function pkcePair(verifier?: string): [string, string] {
  const value = verifier ?? randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(value).digest('base64url');
  return [value, challenge];
}

export function newTicketIdentity(): { ticketId: string; secret: string } {
  return { ticketId: randomBytes(16).toString('hex'), secret: randomBytes(16).toString('hex') };
}

export function redirectUri(config: typeof LOGIN_CONFIG, port: number): string {
  return `http://127.0.0.1:${port}${config.redirectPath}`;
}

// 门户授权链接（参数集与官方插件逐项对齐，勿增删）
export function buildAuthorizeUrl(
  config: typeof LOGIN_CONFIG,
  opts: { ticketId: string; codeChallenge: string; port: number },
): string {
  const query = new URLSearchParams({
    theme: '2',
    locale: 'zh-cn',
    uri_scheme: config.clientId,
    client_id: config.clientId,
    port: String(opts.port),
    code_challenge: opts.codeChallenge,
    code_challenge_method: config.codeChallengeMethod,
    ticket_id: opts.ticketId,
    'plugin-name': config.pluginName,
    'plugin-version': config.pluginVersion,
  });
  return `${config.portalHost}/authorize?${query.toString()}`;
}

// ticket 轮询响应是否已带凭证（新 credentials / 旧 credential 两种形态）
export function hasCredentials(tokens: Record<string, unknown>): boolean {
  const credentials = (tokens.credentials ?? {}) as Record<string, unknown>;
  const legacy = (tokens.credential ?? {}) as Record<string, unknown>;
  return Boolean(credentials.security_token || legacy.securitytoken);
}
