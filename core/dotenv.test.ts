import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, setEnvValue, updateEnvValue } from './dotenv.ts';

function tmpWith(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
  if (content !== null) {
    writeFileSync(join(dir, '.env'), content);
  }
  return dir;
}

test('.env 中的变量注入 process.env', () => {
  delete process.env.DOTENV_TEST_VAR;
  loadDotEnv(tmpWith('DOTENV_TEST_VAR=hello\n'));
  assert.equal(process.env.DOTENV_TEST_VAR, 'hello');
  delete process.env.DOTENV_TEST_VAR;
});

test('.env 不覆盖已有环境变量（shell/CI 优先）', () => {
  process.env.DOTENV_TEST_VAR2 = 'from-shell';
  loadDotEnv(tmpWith('DOTENV_TEST_VAR2=from-file\n'));
  assert.equal(process.env.DOTENV_TEST_VAR2, 'from-shell');
  delete process.env.DOTENV_TEST_VAR2;
});

test('.env 不存在时静默跳过', () => {
  loadDotEnv(tmpWith(null));
});

test('updateEnvValue 替换已存在的变量行，保留注释与其他行', () => {
  const content = '# 注释\nWORKBUDDY_REFRESH_TOKEN=old\nOTHER=1\n';
  assert.equal(
    updateEnvValue(content, 'WORKBUDDY_REFRESH_TOKEN', 'new'),
    '# 注释\nWORKBUDDY_REFRESH_TOKEN=new\nOTHER=1\n',
  );
});

test('updateEnvValue 变量不存在时追加到末尾', () => {
  assert.equal(
    updateEnvValue('OTHER=1\n', 'WORKBUDDY_REFRESH_TOKEN', 'new'),
    'OTHER=1\nWORKBUDDY_REFRESH_TOKEN=new\n',
  );
});

test('updateEnvValue 替换带引号的旧值', () => {
  assert.equal(
    updateEnvValue('WORKBUDDY_REFRESH_TOKEN="old"\n', 'WORKBUDDY_REFRESH_TOKEN', 'new'),
    'WORKBUDDY_REFRESH_TOKEN=new\n',
  );
});

test('updateEnvValue 空内容直接写入一行', () => {
  assert.equal(updateEnvValue('', 'WORKBUDDY_REFRESH_TOKEN', 'new'), 'WORKBUDDY_REFRESH_TOKEN=new\n');
});

test('updateEnvValue 不误改同名前缀的变量', () => {
  const out = updateEnvValue(
    'WORKBUDDY_REFRESH_TOKEN_X=keep\nWORKBUDDY_REFRESH_TOKEN=old\n',
    'WORKBUDDY_REFRESH_TOKEN',
    'new',
  );
  assert.match(out, /WORKBUDDY_REFRESH_TOKEN_X=keep/);
  assert.match(out, /WORKBUDDY_REFRESH_TOKEN=new/);
});

test('setEnvValue 读写文件（不存在则创建）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dotenv-')), '.env');
  setEnvValue(file, 'WORKBUDDY_REFRESH_TOKEN', 'v1');
  assert.equal(readFileSync(file, 'utf-8'), 'WORKBUDDY_REFRESH_TOKEN=v1\n');
  setEnvValue(file, 'WORKBUDDY_REFRESH_TOKEN', 'v2');
  assert.equal(readFileSync(file, 'utf-8'), 'WORKBUDDY_REFRESH_TOKEN=v2\n');
});

test('setEnvValue 新建 .env 为 0600（文件里有 token）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dotenv-')), '.env');
  setEnvValue(file, 'WORKBUDDY_REFRESH_TOKEN', 'v1');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('setEnvValue 把已存在的宽松权限 .env 收紧到 0600', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dotenv-')), '.env');
  writeFileSync(file, 'A=1\n');
  chmodSync(file, 0o644);
  setEnvValue(file, 'WORKBUDDY_REFRESH_TOKEN', 'v2');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('多 Provider .env 轮换回写：只改目标变量，其他 Provider 的值原样保留', () => {
  const before = [
    'WORKBUDDY_REFRESH_TOKEN=wb-1',
    'QODER_REFRESH_TOKEN=qoder-1',
    'TRAE_REFRESH_TOKEN=trae-old',
    'TRAE_DEVICE_ID=626064396416234',
    'GH_PAT=ghp_x',
  ];
  const out = updateEnvValue(`${before.join('\n')}\n`, 'TRAE_REFRESH_TOKEN', 'trae-new');
  assert.equal(out, `${[...before.slice(0, 2), 'TRAE_REFRESH_TOKEN=trae-new', ...before.slice(3)].join('\n')}\n`);
});
