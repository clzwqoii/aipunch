import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from './registry.ts';
import { runCheckins } from './executor.ts';
import type { Account, Provider, RunContext } from './types.ts';

const ctx: RunContext = {
  now: new Date(),
  fetch: (async () => new Response('{}')) as typeof fetch,
};

test('只执行启用账号，跳过 enabled=false', async () => {
  const calls: string[] = [];
  const provider: Provider = {
    id: 'p1',
    name: 'P1',
    async checkin(account: Account) {
      calls.push(account.name);
      return { ok: true, message: 'ok' };
    },
  };
  register(provider);
  const result = await runCheckins(
    [
      { provider: 'p1', name: 'on', token: 't' },
      { provider: 'p1', name: 'off', token: 't', enabled: false },
    ],
    ctx,
  );
  assert.deepEqual(calls, ['on']);
  assert.equal(result.total, 1);
  assert.equal(result.succeeded, 1);
});

test('provider 抛异常记录为失败，且不中断后续账号', async () => {
  register({
    id: 'boom',
    name: 'Boom',
    async checkin(account: Account) {
      if (account.name === 'x') throw new Error('network down');
      return { ok: true, message: 'ok' };
    },
  });
  const result = await runCheckins(
    [
      { provider: 'boom', name: 'x', token: 't' },
      { provider: 'boom', name: 'y', token: 't' },
    ],
    ctx,
  );
  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].message, /network down/);
});

test('provider 返回 skipped 时透传到 AccountResult（幂等已签与真签到区分）', async () => {
  register({
    id: 'idem',
    name: 'Idem',
    async checkin(account: Account) {
      return account.name === 'done'
        ? { ok: true, message: '今日已签', skipped: true }
        : { ok: true, message: '签到成功' };
    },
  });
  const result = await runCheckins(
    [
      { provider: 'idem', name: 'done', token: 't' },
      { provider: 'idem', name: 'fresh', token: 't' },
    ],
    ctx,
  );
  assert.equal(result.results[0].skipped, true);
  assert.notEqual(result.results[1].skipped, true);
});

test('账号引用未注册 provider 时该账号记为失败', async () => {
  const result = await runCheckins([{ provider: 'ghost', name: 'g', token: 't' }], ctx);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].message, /未注册/);
});
