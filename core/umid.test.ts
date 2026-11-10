import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeInfo, umidCandidates, findUmidBinary, isStale } from './umid.ts';

// Qoder 客户端自带 UMID 组件（阿里 securityguard 设备指纹）输出首行 JSON：
// {"machineToken":"...","machineType":"...","machineCode":"...","vmInfo":{...}}
test('parseRuntimeInfo 取首行 JSON 的设备三件套', () => {
  const raw = '{"machineToken":"mt-1","machineType":"ty-1","machineCode":"mc-1","vmInfo":{"isVm":false}}\r\n\r\n';
  assert.deepEqual(parseRuntimeInfo(raw), { machineToken: 'mt-1', machineType: 'ty-1', machineCode: 'mc-1' });
});

test('parseRuntimeInfo 缺 machineToken/machineType 返回 null', () => {
  assert.equal(parseRuntimeInfo('{"machineType":"ty-1"}'), null);
  assert.equal(parseRuntimeInfo('{"machineToken":"mt-1"}'), null);
  assert.equal(parseRuntimeInfo('not json'), null);
  assert.equal(parseRuntimeInfo(''), null);
});

test('umidCandidates 优先 QODER_UMID_PATH，macOS 补默认安装路径', () => {
  const list = umidCandidates('darwin', { QODER_UMID_PATH: '/custom/runtime-info' });
  assert.equal(list[0], '/custom/runtime-info');
  assert.ok(list.includes('/Applications/Qoder.app/Contents/Resources/umid/runtime-info'));
});

test('umidCandidates 非 macOS 且无 QODER_UMID_PATH 时为空（不猜路径）', () => {
  assert.deepEqual(umidCandidates('win32', {}), []);
  assert.deepEqual(umidCandidates('linux', {}), []);
});

test('findUmidBinary 返回第一个存在的候选', () => {
  const seen: string[] = [];
  const found = findUmidBinary(
    (p) => {
      seen.push(p);
      return p.startsWith('/Applications');
    },
    'darwin',
    { QODER_UMID_PATH: '/custom/runtime-info' },
  );
  assert.equal(found, '/Applications/Qoder.app/Contents/Resources/umid/runtime-info');
  assert.equal(seen.length, 2);
});

test('findUmidBinary 无候选或都不存在时返回 null', () => {
  assert.equal(findUmidBinary(() => false, 'linux', {}), null);
  assert.equal(findUmidBinary(() => true, 'linux', {}), null);
});

// 桌面端启动补刷：只按「距上次刷新是否超过 N 小时」决定，不依赖开机时间点
test('isStale：无记录/非法值视为需要刷新', () => {
  const now = new Date('2026-11-10T03:00:00Z');
  assert.equal(isStale(undefined, now, 24), true);
  assert.equal(isStale('', now, 24), true);
  assert.equal(isStale('not-a-date', now, 24), true);
});

test('isStale：未满 24 小时不刷新，满 24 小时刷新', () => {
  const now = new Date('2026-11-10T03:00:00Z');
  assert.equal(isStale('2026-11-09T04:00:00Z', now, 24), false); // 23h
  assert.equal(isStale('2026-11-09T03:00:00Z', now, 24), true); // 24h
  assert.equal(isStale('2026-11-10T09:00:00Z', now, 24), false); // 时钟漂移的未来值
});
