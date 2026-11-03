import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryAsync } from '../src/retry.ts';

test('前两次失败第三次成功：返回结果且共调用三次', async () => {
  let calls = 0;
  const result = await retryAsync(async () => {
    calls += 1;
    if (calls < 3) throw new Error('boom');
    return 'ok';
  }, [0, 0]);
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('持续失败：抛出最后一次错误且重试耗尽', async () => {
  let calls = 0;
  await assert.rejects(
    retryAsync(async () => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    }, [0, 0]),
    /fail-3/,
  );
  assert.equal(calls, 3);
});

test('一次成功不重试', async () => {
  let calls = 0;
  await retryAsync(async () => {
    calls += 1;
    return 1;
  }, [0, 0]);
  assert.equal(calls, 1);
});
