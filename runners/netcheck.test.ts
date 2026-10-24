import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netLine, NET_TARGETS } from './netcheck.ts';

test('NET_TARGETS 覆盖两大云端平台（GitHub 与 Cloudflare 的 API 域）', () => {
  assert.deepEqual(
    NET_TARGETS.map((t) => t.name),
    ['GitHub', 'Cloudflare'],
  );
  assert.ok(NET_TARGETS[0].url.startsWith('https://api.github.com'));
  assert.ok(NET_TARGETS[1].url.startsWith('https://api.cloudflare.com'));
});

test('netLine 输出稳定可解析的 [NET] 行：可达带延迟与状态码，不可达带原因', () => {
  assert.equal(netLine('GitHub', { ok: true, ms: 230, status: 200 }), '[NET] GitHub: ok 230ms HTTP 200');
  assert.equal(netLine('Cloudflare', { ok: false, reason: '超时' }), '[NET] Cloudflare: fail 超时');
});
