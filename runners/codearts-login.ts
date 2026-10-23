import { createServer } from 'node:http';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { newDpopKeyPair, signProof } from '../core/codearts-dpop.ts';
import {
  LOGIN_CONFIG,
  buildAuthorizeUrl,
  hasCredentials,
  newTicketIdentity,
  pkcePair,
  redirectUri,
} from '../core/codearts-auth.ts';
import { setEnvValue } from '../core/dotenv.ts';
import { installDnsFallback } from '../core/dns-fallback.ts';

// 码道登录（OAuth PKCE + DPoP，浏览器授权）：与 `npm run login`（WorkBuddy）同用途。
// 流程：本地回调服务器（ ephemeral 端口）→ 打开门户授权页 → 用户登录后回调带 code
// （或轮询 ticket 兜底）→ POST {sts}/v1/oauth2/tokens 换 STS 临时凭据 → 写 .env。
// DPoP 私钥与 refresh_token 绑定，必须一并落盘（CODEARTS_DPOP_KEY）。
// 用法：npm run codearts-login [-- --print]
const TOKEN_URL = `${LOGIN_CONFIG.stsHost}/v1/oauth2/tokens`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* 打不开就手动复制，runner 已打印 URL */
  });
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  port: number,
  dpopKey: ReturnType<typeof newDpopKeyPair>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    client_id: LOGIN_CONFIG.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(LOGIN_CONFIG, port),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: signProof(dpopKey, TOKEN_URL, { htm: 'POST' }),
    },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`换 token 失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  installDnsFallback();
  const [codeVerifier, codeChallenge] = pkcePair();
  const { ticketId, secret } = newTicketIdentity();
  const dpopKey = newDpopKeyPair();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const authUrl = buildAuthorizeUrl(LOGIN_CONFIG, { ticketId, codeChallenge, port });

  console.log('请在打开的浏览器中登录华为云账号并授权码道：');
  console.log(authUrl);
  openBrowser(authUrl);

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('登录超时（5 分钟），请重试'));
    }, LOGIN_TIMEOUT_MS);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith(LOGIN_CONFIG.redirectPath)) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif;padding:40px"><h3>授权完成，请返回终端查看结果。</h3></body></html>');
      if (!code) {
        clearTimeout(timer);
        server.close();
        reject(new Error('回调缺少 code 参数'));
        return;
      }
      clearTimeout(timer);
      server.close();
      exchangeCode(code, codeVerifier, port, dpopKey).then(resolve, reject);
    });

    // 兜底通道：轮询 ticket（回调被防火墙拦住时仍能拿到凭证）
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(
          `${LOGIN_CONFIG.snapManager}/v1/login/ticket?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`,
          { headers: { 'plugin-name': LOGIN_CONFIG.pluginName, 'plugin-version': LOGIN_CONFIG.pluginVersion } },
        );
        const data = (await res.json()) as Record<string, unknown>;
        if (hasCredentials(data)) {
          clearTimeout(timer);
          server.close();
          resolve(data);
        }
      } catch {
        /* 网络抖动：下一轮再试 */
        return;
      }
      if (!timer.hasRef()) return;
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  });

  const credentials = (result.credentials ?? result.credential ?? {}) as Record<string, unknown>;
  const refreshToken = (credentials.refresh_token ?? result.refresh_token ?? '') as string;
  if (!refreshToken) {
    console.error('登录响应中没有 refresh_token，无法自动续期（SDK 每次调用都会刷新，仍可使用但需定期重新登录）');
    process.exitCode = 1;
    return;
  }
  const dpopKeyJson = JSON.stringify(dpopKey);
  const verifier = codeVerifier;
  if (process.argv.includes('--print')) {
    console.log(`CODEARTS_REFRESH_TOKEN=${refreshToken}`);
    console.log(`CODEARTS_DPOP_KEY=${dpopKeyJson}`);
    console.log(`CODEARTS_CODE_VERIFIER=${verifier}`);
    return;
  }
  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, 'CODEARTS_REFRESH_TOKEN', refreshToken);
  setEnvValue(envFile, 'CODEARTS_DPOP_KEY', dpopKeyJson);
  setEnvValue(envFile, 'CODEARTS_CODE_VERIFIER', verifier);
  console.log(`\n登录成功：CODEARTS_REFRESH_TOKEN=${mask(refreshToken)} + DPoP 私钥已写入 ${envFile}（token 不明文显示）`);
  console.log('config.json 加账号：{ "provider": "codearts", "name": "main", "refreshTokenEnv": "CODEARTS_REFRESH_TOKEN", "enabled": true }');
}

main().catch((err: unknown) => {
  console.error(`登录失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
