import { createServer } from 'node:http';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { buildTraeAuthUrl, newTraeDevice, parseTraeCallback } from '../core/trae-auth.ts';
import { setEnvValue } from '../core/dotenv.ts';

// Trae CN 浏览器授权登录（与客户端互不影响）：打开官方授权页 → 本地回调拿
// refreshToken → 写 .env（refreshToken + 设备号 + machineId + uid）。
// 客户端仍可用自己的登录态，两条会话各有独立轮换链。
// 用法：npm run trae-login [-- --print]
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

async function main(): Promise<void> {
  const device = newTraeDevice();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const callback = `http://127.0.0.1:${port}/authorize`;
  const authUrl = buildTraeAuthUrl(device, callback);

  console.log('请在打开的浏览器中登录 Trae CN 账号并允许授权：');
  console.log(authUrl);
  openBrowser(authUrl);

  const signed = await new Promise<ReturnType<typeof parseTraeCallback>>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('登录超时（5 分钟），请重试'));
    }, LOGIN_TIMEOUT_MS);

    server.on('request', (req, res) => {
      // 授权页可能用脚本 fetch 回传，需允许跨域
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/authorize') {
        res.writeHead(404, cors).end();
        return;
      }
      const html = (body: string): void => {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px">${body}</body></html>`);
      };
      clearTimeout(timer);
      server.close();
      try {
        const parsed = parseTraeCallback(url.searchParams);
        html('<h3>授权完成，请返回终端查看结果。</h3>');
        resolve(parsed);
      } catch (err) {
        const message = (err as Error).message;
        html(`<h3>授权失败：${message.replace(/[<>&]/g, '')}</h3>`);
        reject(err);
      }
    });
  });

  if (!signed.token) console.warn('授权页未返回 JWT，将以 refreshToken 直接保存（provider 会自行刷新）。');
  const refreshToken = signed.refreshToken;

  console.log(`账号: ${signed.screenName || signed.userId || '(未知)'}`);
  console.log(`TRAE_DEVICE_ID=${device.deviceId}`);
  console.log(`TRAE_MACHINE_ID=${device.machineId}`);
  console.log(`TRAE_REFRESH_TOKEN=${mask(refreshToken)}`);
  if (signed.userId) console.log(`TRAE_USER_ID=${signed.userId}`);

  if (process.argv.includes('--print')) {
    console.log(`TRAE_REFRESH_TOKEN=${refreshToken}`);
    return;
  }
  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, 'TRAE_REFRESH_TOKEN', refreshToken);
  setEnvValue(envFile, 'TRAE_DEVICE_ID', device.deviceId);
  setEnvValue(envFile, 'TRAE_MACHINE_ID', device.machineId);
  if (signed.userId) setEnvValue(envFile, 'TRAE_USER_ID', signed.userId);
  console.log(`已写入 ${envFile}（token 不明文显示）`);
}

main().catch((err: unknown) => {
  console.error(`登录失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
