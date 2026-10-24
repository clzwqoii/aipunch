import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cfFetch,
  dailyCron,
  deployWorkerRequest,
  ensureKvNamespace,
  putKvValueRequest,
  putSecretRequest,
  putSchedulesRequest,
  readKvValue,
  runRequest,
} from './cf-api.ts';

function ok(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, errors: [], result }), { status });
}

test('dailyCron 生成每日整点的 5 字段 cron（UTC，分钟粒度无秒位）', () => {
  assert.equal(dailyCron('03'), '0 03 * * *');
});

test('cfFetch 提取 result，CF 信封失败时抛出 errors', async () => {
  const res = await cfFetch(async () => ok({ id: 'x' }), 'http://x');
  assert.deepEqual(res, { id: 'x' });
  await assert.rejects(
    cfFetch(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'denied' }], result: null }), { status: 403 }), 'http://x'),
    /denied/,
  );
});

test('ensureKvNamespace 已存在直接复用，不存在才创建', async () => {
  const reused = await ensureKvNamespace(
    async (url, init) => {
      assert.equal(init?.method, undefined); // 只读 list，不创建
      assert.ok(String(url).includes('/storage/kv/namespaces?'));
      return ok([{ id: 'ns-old', title: 'aipunch' }]);
    },
    'acct',
    'tok',
    'aipunch',
  );
  assert.equal(reused, 'ns-old');

  let created = false;
  const fresh = await ensureKvNamespace(
    async (url, init) => {
      if (String(url).includes('namespaces?')) return ok([]);
      created = true;
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { title: 'aipunch' });
      return ok({ id: 'ns-new' });
    },
    'acct',
    'tok',
    'aipunch',
  );
  assert.ok(created);
  assert.equal(fresh, 'ns-new');
});

test('putSecretRequest 构造单条 Secret 写入请求（worker 自回写与部署共用端点）', async () => {
  const req = putSecretRequest('acct', 'tok', 'aipunch-checkin', 'TRAE_REFRESH_TOKEN', 'tok-val');
  assert.equal(req.method, 'PUT');
  assert.ok(req.url.endsWith('/accounts/acct/workers/scripts/aipunch-checkin/secrets'));
  assert.equal(req.headers.get('Authorization'), 'Bearer tok');
  assert.deepEqual(JSON.parse(await req.text()), { name: 'TRAE_REFRESH_TOKEN', text: 'tok-val', type: 'secret_text' });
});

test('putSchedulesRequest 构造 cron 触发器请求', async () => {
  const req = putSchedulesRequest('acct', 'tok', 'aipunch-checkin', ['0 3 * * *']);
  assert.equal(req.method, 'PUT');
  assert.ok(req.url.endsWith('/workers/scripts/aipunch-checkin/schedules'));
  assert.deepEqual(JSON.parse(await req.text()), [{ cron: '0 3 * * *' }]);
});

test('readKvValue 返回值，404 返回 null', async () => {
  const val = await readKvValue(
    async () => new Response('{"a":1}', { status: 200 }),
    'acct',
    'tok',
    'ns1',
    'result',
  );
  assert.equal(val, '{"a":1}');
  const none = await readKvValue(async () => new Response('', { status: 404 }), 'acct', 'tok', 'ns1', 'result');
  assert.equal(none, null);
});

test('putKvValue 构造 KV 写入请求（部署时上传 config）', async () => {
  const req = putKvValueRequest('acct', 'tok', 'ns1', 'config', '{"accounts":[]}');
  assert.equal(req.method, 'PUT');
  assert.ok(req.url.endsWith('/accounts/acct/storage/kv/namespaces/ns1/values/config'));
  assert.equal(await req.text(), '{"accounts":[]}');
});

test('runRequest 转发 method/body 并解析信封失败', async () => {
  const seen: Array<{ method?: string; body?: string }> = [];
  await runRequest(async (url, init) => {
    seen.push({ method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
    assert.ok(String(url).endsWith('/secrets'));
    return ok({ name: 'x' });
  }, putSecretRequest('acct', 'tok', 's', 'X', 'v'));
  assert.deepEqual(seen, [{ method: 'PUT', body: JSON.stringify({ name: 'X', text: 'v', type: 'secret_text' }) }]);
  await assert.rejects(
    runRequest(
      async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'bad token' }], result: null }), { status: 401 }),
      putSecretRequest('acct', 'tok', 's', 'X', 'v'),
    ),
    /bad token/,
  );
});

test('deployWorkerRequest 组装 multipart：metadata 含 main_module/KV 绑定/compat 日期', async () => {
  const req = await deployWorkerRequest('acct', 'tok', 'aipunch-checkin', 'ns1', ['0 3 * * *'], 'export default {}');
  assert.equal(req.method, 'PUT');
  assert.ok(req.url.endsWith('/accounts/acct/workers/scripts/aipunch-checkin'));
  const form = await req.clone().formData();
  const metadata = JSON.parse(String(form.get('metadata')));
  assert.equal(metadata.main_module, 'worker.mjs');
  assert.equal(metadata.compatibility_date, '2026-10-01');
  // secret_text 不在 metadata 声明（CF 会要求同请求带值）；凭证走独立 PUT secrets 端点
  assert.deepEqual(metadata.bindings, [{ type: 'kv_namespace', name: 'AIPUNCH_KV', namespace_id: 'ns1' }]);
  assert.deepEqual(metadata.triggers?.crons, ['0 3 * * *']);
  assert.ok(String(await (form.get('worker.mjs') as File).text()).includes('export default'));
});
