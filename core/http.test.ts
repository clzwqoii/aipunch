import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchWithTimeout } from './http.ts';

test('fetchWithTimeout 对挂起请求按超时中止', async () => {
  const server = createServer(() => {
    /* 永不响应：模拟网络挂起 */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const started = Date.now();
  await assert.rejects(fetchWithTimeout(100)(`http://127.0.0.1:${port}/hang`), /timeout|abort/i);
  assert.ok(Date.now() - started < 2000, '应在超时后立即返回');
  server.closeAllConnections();
  server.close();
});

test('fetchWithTimeout 正常响应不受影响', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const res = await fetchWithTimeout(1000)(`http://127.0.0.1:${port}/`);
  assert.equal(await res.text(), 'ok');
  server.close();
});
