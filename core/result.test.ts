import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBalance, toResultFile } from './result.ts';

test('toResultFile 传递 skipped 标志（幂等跳过与真签到区分）', () => {
  const file = toResultFile({
    startedAt: '2026-10-24T03:00:00Z',
    finishedAt: '2026-10-24T03:01:00Z',
    total: 2,
    succeeded: 2,
    results: [
      { account: 'a', provider: 'trae', ok: true, message: '今日已领取', durationMs: 1, skipped: true },
      { account: 'b', provider: 'workbuddy', ok: true, message: '签到成功', durationMs: 2 },
    ],
  });
  assert.equal(file.results[0].skipped, true);
  assert.equal(file.results[1].skipped, undefined);
});

test('extractBalance 支持 WorkBuddy 的 balanceAfter', () => {
  assert.deepEqual(extractBalance({ balanceAfter: { remain: 1177, total: 1761 } }), { remain: 1177 });
});

test('extractBalance 支持 Trae/Qoder 的 usage 形状', () => {
  assert.deepEqual(extractBalance({ usage: { limit: 2900, used: 770, remain: 2130 } }), {
    remain: 2130,
    limit: 2900,
  });
  assert.deepEqual(extractBalance({ usage: { limit: 0, used: 0, remain: 0, unlimited: true } }), {
    remain: 0,
    limit: 0,
    unlimited: true,
  });
});

test('extractBalance 支持 CodeArts/AutoClaw 的 balance 形状', () => {
  assert.deepEqual(extractBalance({ balance: { remain: 10748.26 } }), { remain: 10748.26 });
  assert.deepEqual(extractBalance({ balance: { remain: 2400 } }), { remain: 2400 });
});

test('extractBalance 无余额字段时返回 null', () => {
  assert.equal(extractBalance(null), null);
  assert.equal(extractBalance({}), null);
  assert.equal(extractBalance({ status: 200 }), null);
});
