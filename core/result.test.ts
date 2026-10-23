import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBalance } from './result.ts';

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
