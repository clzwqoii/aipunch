import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEnvWrites } from './raccoon-extract.ts';

test('客户端同时给出 access/refresh：两个变量都写，无警告', () => {
  const plan = planEnvWrites({ access_token: 'at-new', refresh_token: 'rt-new' }, {});
  assert.deepEqual(plan.writes, [
    { key: 'RACCOON_ACCESS_TOKEN', value: 'at-new' },
    { key: 'RACCOON_REFRESH_TOKEN', value: 'rt-new' },
  ]);
  assert.equal(plan.warning, undefined);
});

test('客户端只给 access（2026-10-25 后实测形态）：只写 access，refresh 沿用 .env 现値', () => {
  const plan = planEnvWrites({ access_token: 'at-only' }, { refresh: 'rt-in-env' });
  assert.deepEqual(plan.writes, [{ key: 'RACCOON_ACCESS_TOKEN', value: 'at-only' }]);
  assert.match(String(plan.warning), /refresh_token/);
});

test('客户端只给 access 且 .env 无 refresh：仍写 access，但提示到期后需重新登录', () => {
  const plan = planEnvWrites({ access_token: 'at-only' }, {});
  assert.deepEqual(plan.writes, [{ key: 'RACCOON_ACCESS_TOKEN', value: 'at-only' }]);
  assert.match(String(plan.warning), /重新登录/);
});

test('客户端只给 refresh：写 refresh（provider 会先刷新）', () => {
  const plan = planEnvWrites({ refresh_token: 'rt-only' }, {});
  assert.deepEqual(plan.writes, [{ key: 'RACCOON_REFRESH_TOKEN', value: 'rt-only' }]);
});

test('两者都没有：抛错，不写半截配置', () => {
  assert.throws(() => planEnvWrites({}, { refresh: 'rt-in-env' }), /未登录|缺少/);
});
