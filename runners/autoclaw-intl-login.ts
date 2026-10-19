import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { autoclawIntlBase, signedHeaders } from '../providers/autoclaw.ts';
import {
  callbackPath,
  captchaPageHtml,
  normalizeCaptchaConfig,
  oauthLoginPath,
  oauthUrlPath,
  parseCallbackQuery,
  pinnedPorts,
  type OauthVendor,
} from '../core/autoclaw-oauth.ts';
import { candidateDbPaths, findIntlAccount } from '../core/autoclaw-intl-import.ts';
import { setEnvValue } from '../core/dotenv.ts';

// AutoClaw 国际版凭证获取（浏览器官方授权为主路径）：
//   ① oauth-captcha-config → ② 本地页跑官方阿里云 SDK 过滑块 → ③ oauth-url（带验证串）
//   → ④ 浏览器登录、本地回调收 code → ⑤ oauth-login 换 refreshToken → 写 .env
// 兜底：--from-agent2api（从 Agent2API 账号库只读导入）/ --token（已有 token）。
// 用法：npm run autoclaw-intl-login [-- --oauth [--vendor zai|google] | --from-agent2api [--db <path>] | --token <rt> | --print]
const CAPTCHA_TIMEOUT_MS = 120_000; // 与官方 SDK 侧验证码超时一致
const LOGIN_TIMEOUT_MS = 5 * 60_000;

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* 打不开就手动复制，终端已打印 URL */
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

async function listenOnPinnedPorts(server: ReturnType<typeof createServer>): Promise<number> {
  for (const port of pinnedPorts()) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch {
      /* 端口被占（常见：官方客户端占 18432），试下一个 */
    }
  }
  throw new Error('Zai 白名单端口（19654/19723/53699/18432）全部被占用，请关闭占用进程后重试');
}

async function signedPost(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: signedHeaders(''),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`HTTP ${res.status}，响应非 JSON: ${text.slice(0, 120)}`);
  }
}

async function runOauth(vendor: OauthVendor): Promise<string> {
  const base = autoclawIntlBase();
  const deviceId = randomUUID();

  // ① 取验证码配置（国际版 enabled=true；国内版 false 表示不支持网页登录）
  const configRaw = await signedPost(base, '/userapi/overseasv1/oauth-captcha-config', {});
  const captchaConfig = normalizeCaptchaConfig(configRaw);
  if (!captchaConfig.enabled || !captchaConfig.sceneId) {
    throw new Error('该版本未启用网页登录（captcha-config enabled=false），请改用 --from-agent2api 或 --token');
  }
  console.log(`人机验证配置就绪（region=${captchaConfig.region}）`);

  // ② 本地服务：验证码页 + 参数回传 + OAuth 回调
  const server = createServer();
  const port = await listenOnPinnedPorts(server);
  const navigateUri = `http://localhost:${port}${callbackPath(vendor)}`;
  console.log(`本地回调已监听：${navigateUri}`);

  let resolveCaptcha: (param: string) => void = () => {};
  let rejectCaptcha: (error: Error) => void = () => {};
  const captchaParam = new Promise<string>((resolve, reject) => {
    resolveCaptcha = resolve;
    rejectCaptcha = reject;
  });
  let resolveCallback: (value: { code: string; state: string }) => void = () => {};
  let rejectCallback: (error: Error) => void = () => {};
  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === '/captcha') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        captchaPageHtml({
          region: captchaConfig.region,
          prefix: captchaConfig.prefix,
          sceneId: captchaConfig.sceneId,
          postPath: '/captcha-param',
        }),
      );
      return;
    }
    if (url.pathname === '/captcha-param' && req.method === 'POST') {
      readBody(req)
        .then((body) => {
          const param = body.trim();
          if (param.length < 100) {
            json(400, { ok: false, error: 'invalid captcha param' });
            rejectCaptcha(new Error('验证码参数不完整，请刷新页面重试'));
            return;
          }
          json(200, { ok: true });
          resolveCaptcha(param);
        })
        .catch((error: unknown) => json(500, { ok: false, error: String(error) }));
      return;
    }
    if (url.pathname === callbackPath(vendor)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body style="font-family:-apple-system,sans-serif;padding:48px"><h3>授权完成，请返回终端查看结果。</h3></body></html>',
      );
      const parsed = parseCallbackQuery(req.url ?? '');
      if (parsed) resolveCallback(parsed);
      else rejectCallback(new Error('回调缺少 code 参数（可能授权被取消）'));
      return;
    }
    res.writeHead(404).end();
  });

  openBrowser(`http://localhost:${port}/captcha`);
  console.log('已打开浏览器：请在页面中点击「开始验证」并完成滑块。');
  const verifyParam = await withTimeout(captchaParam, CAPTCHA_TIMEOUT_MS, '人机验证超时（120 秒），请重试');

  // ③ 验证码换授权地址
  const urlRaw = await signedPost(base, oauthUrlPath(vendor), {
    source_id: 'autoclaw',
    device_id: deviceId,
    navigate_uri: navigateUri,
    ali_captcha_verify_param: verifyParam,
  });
  const oauthUrl = ((urlRaw.data as Record<string, unknown> | undefined)?.oauth_url ?? '') as string;
  if (!oauthUrl) {
    server.close();
    throw new Error(`获取授权地址失败: ${String((urlRaw as { msg?: string }).msg ?? JSON.stringify(urlRaw).slice(0, 120))}`);
  }

  // ④ 浏览器登录，等待本地回调
  console.log('已打开官方授权页，请在浏览器中完成登录…');
  openBrowser(oauthUrl);
  const { code, state } = await withTimeout(callback, LOGIN_TIMEOUT_MS, '登录等待超时（5 分钟），请重试');
  server.close();

  // ⑤ 一次性 code 换 token
  const loginRaw = await signedPost(base, oauthLoginPath(vendor), {
    source_id: 'autoclaw',
    device_id: deviceId,
    code,
    state,
    navigate_uri: navigateUri,
  });
  const data = (loginRaw.data as Record<string, unknown> | undefined) ?? {};
  const refreshToken = (data.refresh_token ?? '') as string;
  if (!refreshToken) {
    throw new Error(`登录成功但未返回 refreshToken: ${JSON.stringify(loginRaw).slice(0, 160)}`);
  }
  if (typeof data.user_name === 'string' && data.user_name) {
    console.log(`账号：${data.user_name}`);
  }
  return refreshToken;
}

function findDbRecursively(roots: string[], depth = 3): string | null {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack: Array<{ dir: string; level: number }> = [{ dir: root, level: 0 }];
    while (stack.length > 0) {
      const { dir, level } = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      if (entries.includes('agent2api.db')) return join(dir, 'agent2api.db');
      if (level + 1 <= depth) {
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          stack.push({ dir: join(dir, entry), level: level + 1 });
        }
      }
    }
  }
  return null;
}

async function readFromAgent2Api(dbPath?: string): Promise<string> {
  let dbFile = dbPath ?? '';
  if (!dbFile) {
    const candidates = candidateDbPaths(homedir(), process.platform, process.env.APPDATA);
    dbFile = candidates.find((p) => existsSync(p)) ?? '';
    if (!dbFile) {
      const roots =
        process.platform === 'darwin'
          ? [join(homedir(), 'Library', 'Application Support')]
          : process.platform === 'win32'
            ? [process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')]
            : [join(homedir(), '.config')];
      dbFile = findDbRecursively(roots) ?? '';
    }
  }
  if (!dbFile) {
    throw new Error('未找到 Agent2API 数据库（agent2api.db）；请改用 --oauth，或用 --db 指定路径');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (db.prepare('SELECT * FROM accounts').all() as unknown[]).map((row) => row as Record<string, unknown>);
  } finally {
    db.close();
  }
  const account = findIntlAccount(rows);
  if (!account) {
    throw new Error(
      '库中没有带 refreshToken 的 autoclaw-intl 账号：请用 Agent2API 的登录窗口完成国际版授权（「导入桌面客户端」的记录不含 token）',
    );
  }
  console.log(`从 ${dbFile} 读取到国际版账号${account.name ? `「${account.name}」` : ''}`);
  return account.refreshToken;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const vendor = (argValue('--vendor') ?? 'zai') as OauthVendor;
  if (vendor !== 'zai' && vendor !== 'google') {
    throw new Error('--vendor 只支持 zai 或 google');
  }

  let refreshToken = argValue('--token') ?? '';
  if (!refreshToken && args.includes('--oauth')) {
    refreshToken = await runOauth(vendor);
  }
  if (!refreshToken && args.includes('--from-agent2api')) {
    refreshToken = await readFromAgent2Api(argValue('--db'));
  }
  if (!refreshToken && (args.includes('--oauth') || args.includes('--from-agent2api'))) {
    throw new Error('未获取到 refreshToken');
  }
  if (!refreshToken) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    refreshToken = await new Promise<string>((resolve) => {
      rl.question('粘贴 AutoClaw 国际版 refreshToken：', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
  if (!refreshToken) {
    console.error('未提供 refreshToken。主路径：--oauth（浏览器官方授权）');
    process.exitCode = 1;
    return;
  }

  if (args.includes('--print')) {
    console.log(`AUTOCLAW_INTL_REFRESH_TOKEN=${refreshToken}`);
    return;
  }
  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, 'AUTOCLAW_INTL_REFRESH_TOKEN', refreshToken);
  console.log(`AUTOCLAW_INTL_REFRESH_TOKEN=${mask(refreshToken)} 已写入 ${envFile}（token 不明文显示）`);
  console.log('config.json 加账号：{ "provider": "autoclaw-intl", "name": "main", "refreshTokenEnv": "AUTOCLAW_INTL_REFRESH_TOKEN", "enabled": true }');
}

main().catch((err: unknown) => {
  console.error(`获取失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
