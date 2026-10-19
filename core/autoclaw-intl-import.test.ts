import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIntlAccount, candidateDbPaths } from './autoclaw-intl-import.ts';

test('findIntlAccount：从 JSON 列中找 provider=autoclaw-intl 且有 refreshToken 的记录', () => {
  const rows = [
    { id: 'user-1', provider: 'autoclaw', data: JSON.stringify({ provider: 'autoclaw', refreshToken: 'rt-cn' }) },
    {
      id: 'intl-user-2',
      provider: 'autoclaw-intl',
      data: JSON.stringify({ provider: 'autoclaw-intl', refreshToken: 'rt-intl', accessToken: 'at-intl', userId: 'u2', deviceId: 'd2', name: 'intl' }),
    },
  ];
  const found = findIntlAccount(rows);
  assert.ok(found);
  assert.equal(found.refreshToken, 'rt-intl');
  assert.equal(found.accessToken, 'at-intl');
  assert.equal(found.userId, 'u2');
});

test('findIntlAccount：直接列形态（refreshToken 独立列）也能识别', () => {
  const found = findIntlAccount([{ provider: 'autoclaw-intl', refreshToken: 'rt-col' }]);
  assert.equal(found?.refreshToken, 'rt-col');
});

test('findIntlAccount：snake_case refresh_token 兼容', () => {
  const found = findIntlAccount([{ id: 'intl-user-3', provider: 'autoclaw-intl', blob: JSON.stringify({ provider: 'autoclaw-intl', refresh_token: 'rt-snake' }) }]);
  assert.equal(found?.refreshToken, 'rt-snake');
});

test('findIntlAccount：桌面导入记录（无 token）跳过，CN 账号跳过', () => {
  const rows = [
    { id: 'autoclaw-intl-desktop', provider: 'autoclaw-intl', data: JSON.stringify({ provider: 'autoclaw-intl', name: 'desktop' }) },
    { id: 'user-9', provider: 'autoclaw', data: JSON.stringify({ provider: 'autoclaw', refreshToken: 'rt-cn' }) },
  ];
  assert.equal(findIntlAccount(rows), null);
});

test('candidateDbPaths：三平台标准配置目录都覆盖', () => {
  const mac = candidateDbPaths('/Users/x', 'darwin');
  assert.ok(mac.every((p) => p.endsWith('/agent2api.db')));
  assert.ok(mac.some((p) => p.includes('Library/Application Support')));
  const win = candidateDbPaths('C:/Users/x', 'win32', 'C:/Users/x/AppData/Roaming');
  assert.ok(win.some((p) => p.includes('AppData/Roaming')));
  const linux = candidateDbPaths('/home/x', 'linux');
  assert.ok(linux.some((p) => p.includes('.config')));
});
