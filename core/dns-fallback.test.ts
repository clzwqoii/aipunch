import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDohLookup, isFakeIp } from './dns-fallback.ts';

type Cb = (err: NodeJS.ErrnoException | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;
type Primary = (hostname: string, options: Record<string, unknown>, cb: Cb) => void;

function lookupOnce(primary: Primary, doh: (host: string) => Promise<Array<{ address: string; family: number }>>) {
  const fn = createDohLookup(primary, doh);
  return (hostname: string, options: Record<string, unknown> = {}) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: string | Array<{ address: string; family: number }>; family?: number }>(
      (resolve) => {
        (fn as unknown as (h: string, o: Record<string, unknown>, cb: Cb) => void)(hostname, options, (err, address, family) =>
          resolve({ err, address, family }),
        );
      },
    );
}

const real = [{ address: '43.159.104.94', family: 4 }];
const fake = [{ address: '198.18.0.77', family: 4 }];

test('isFakeIp 识别 Clash fake-IP 段', () => {
  assert.equal(isFakeIp('198.18.0.77'), true);
  assert.equal(isFakeIp('198.19.255.1'), true);
  assert.equal(isFakeIp('43.159.104.94'), false);
});

test('系统 DNS 返回 fake-IP 时改用 DoH 的真实地址', async () => {
  const lookup = lookupOnce(
    (_h, _o, cb) => cb(null, fake[0].address, 4),
    async () => real,
  );
  const r = await lookup('www.workbuddy.cn');
  assert.equal(r.err, null);
  assert.equal(r.address, '43.159.104.94');
});

test('系统 DNS 报错时用 DoH', async () => {
  const lookup = lookupOnce(
    (_h, _o, cb) => cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
    async () => real,
  );
  const r = await lookup('www.workbuddy.cn');
  assert.equal(r.err, null);
  assert.equal(r.address, '43.159.104.94');
});

test('系统 DNS 返回真实地址时直接使用', async () => {
  const lookup = lookupOnce(
    (_h, _o, cb) => cb(null, '43.159.104.94', 4),
    async () => [{ address: '1.2.3.4', family: 4 }],
  );
  const r = await lookup('www.workbuddy.cn');
  assert.equal(r.address, '43.159.104.94');
});

test('DoH 失败时回落到系统结果（即使是 fake-IP，也比直接报错强）', async () => {
  const lookup = lookupOnce(
    (_h, _o, cb) => cb(null, fake[0].address, 4),
    async () => {
      throw new Error('doh down');
    },
  );
  const r = await lookup('www.workbuddy.cn');
  assert.equal(r.err, null);
  assert.equal(r.address, '198.18.0.77');
});

test('两边都失败时回调 ENOTFOUND', async () => {
  const lookup = lookupOnce(
    (_h, _o, cb) => cb(Object.assign(new Error('boom'), { code: 'ENOTFOUND' })),
    async () => {
      throw new Error('doh down');
    },
  );
  const r = await lookup('www.workbuddy.cn');
  assert.equal(r.err?.code, 'ENOTFOUND');
});

test('options.all 时返回地址数组', async () => {
  const lookup = lookupOnce(
    (_h, _o, cb) => cb(null, fake[0].address, 4),
    async () => real,
  );
  const r = await lookup('www.workbuddy.cn', { all: true });
  assert.deepEqual(r.address, real);
});
