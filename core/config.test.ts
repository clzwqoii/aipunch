import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveAccounts } from './config.ts';

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'checkin-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('缺少 accounts 数组抛错', () => {
  assert.throws(() => loadConfig(writeConfig({})), /accounts/);
});

test('非合法 JSON 抛错', () => {
  assert.throws(() => loadConfig(writeConfig('{oops')), /合法 JSON/);
});

test('账号缺少 tokenEnv 抛错（token 禁止写入配置）', () => {
  const path = writeConfig({ accounts: [{ provider: 'workbuddy', name: 'main' }] });
  assert.throws(() => resolveAccounts(loadConfig(path)), /tokenEnv/);
});

test('tokenEnv 指向的环境变量未设置时抛错', () => {
  delete process.env.MISSING_TOKEN_VAR;
  const path = writeConfig({
    accounts: [{ provider: 'workbuddy', name: 'main', tokenEnv: 'MISSING_TOKEN_VAR' }],
  });
  assert.throws(() => resolveAccounts(loadConfig(path)), /MISSING_TOKEN_VAR/);
});

test('tokenEnv 指向的环境变量值注入为 account.token', () => {
  process.env.TEST_TOKEN_VAR = 'secret-token';
  const path = writeConfig({
    accounts: [{ provider: 'workbuddy', name: 'main', tokenEnv: 'TEST_TOKEN_VAR' }],
  });
  const [account] = resolveAccounts(loadConfig(path));
  assert.equal(account.token, 'secret-token');
});

test('refreshTokenEnv 指向的环境变量值注入为 account.refreshToken', () => {
  process.env.TEST_REFRESH_VAR = 'rt-value';
  const path = writeConfig({
    accounts: [{ provider: 'workbuddy', name: 'main', refreshTokenEnv: 'TEST_REFRESH_VAR' }],
  });
  const [account] = resolveAccounts(loadConfig(path));
  assert.equal(account.refreshToken, 'rt-value');
  assert.equal(account.token, '');
});

test('refreshTokenEnv 指向的环境变量未设置时抛错', () => {
  delete process.env.MISSING_REFRESH_VAR;
  const path = writeConfig({
    accounts: [{ provider: 'workbuddy', name: 'main', refreshTokenEnv: 'MISSING_REFRESH_VAR' }],
  });
  assert.throws(() => resolveAccounts(loadConfig(path)), /MISSING_REFRESH_VAR/);
});

test('resolveAccounts 支持注入 env 源（Workers 的 Secrets 走 env 参数而非 process.env）', () => {
  const accounts = [{ provider: 'trae', name: 'main', refreshTokenEnv: 'TRAE_REFRESH_TOKEN' }];
  const [account] = resolveAccounts({ accounts }, { TRAE_REFRESH_TOKEN: 'tok' });
  assert.equal(account.refreshToken, 'tok');
  assert.throws(() => resolveAccounts({ accounts }, {}), /TRAE_REFRESH_TOKEN 未设置/);
});
