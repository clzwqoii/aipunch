import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, get, list, has } from './registry.ts';
import type { Provider } from './types.ts';

const fake = (id: string): Provider => ({
  id,
  name: id,
  async checkin() {
    return { ok: true, message: 'ok' };
  },
});

test('注册后可按 id 获取，has 返回 true', () => {
  register(fake('a'));
  assert.equal(get('a').id, 'a');
  assert.equal(has('a'), true);
});

test('重复注册同一 id 抛错', () => {
  register(fake('b'));
  assert.throws(() => register(fake('b')), /重复注册/);
});

test('list 返回全部已注册 provider', () => {
  register(fake('c'));
  const ids = list().map((p) => p.id);
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('b'));
  assert.ok(ids.includes('c'));
});

test('获取未注册 id 抛错', () => {
  assert.throws(() => get('nope'), /未注册/);
});
