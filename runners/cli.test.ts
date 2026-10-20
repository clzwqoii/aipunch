import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aipunch-cli-'));
const configPath = join(dir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    accounts: [
      { provider: 'trae', name: 'main', refreshTokenEnv: 'TRAE_REFRESH_TOKEN', enabled: true },
      { provider: 'qoder', name: 'main', refreshTokenEnv: 'QODER_REFRESH_TOKEN', enabled: true },
      { provider: 'trae', name: 'alt', refreshTokenEnv: 'TRAE_ALT_REFRESH_TOKEN', enabled: true },
    ],
  }),
);
test.after(() => rmSync(dir, { recursive: true, force: true }));

function runCli(extra: string[]): { output: string; status: number } {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'runners/cli.ts', '--dry-run', '--config', configPath, ...extra],
    { encoding: 'utf-8' },
  );
  return { output: `${res.stdout}${res.stderr}`, status: res.status ?? 1 };
}

test('--provider 只跑该 Provider 的账号', () => {
  const { output, status } = runCli(['--provider', 'trae']);
  assert.equal(status, 0);
  assert.match(output, /trae\/main/);
  assert.match(output, /trae\/alt/);
  assert.doesNotMatch(output, /qoder\/main/);
});

test('--provider + --account 精确到单个账号', () => {
  const { output, status } = runCli(['--provider', 'trae', '--account', 'alt']);
  assert.equal(status, 0);
  assert.match(output, /trae\/alt/);
  assert.doesNotMatch(output, /trae\/main/);
});

test('无匹配账号时失败而不是静默跑全部', () => {
  const { output, status } = runCli(['--provider', 'trae', '--account', 'missing']);
  assert.equal(status, 1);
  assert.match(output, /没有匹配的账号/);
});

test('--provider 缺少值时失败', () => {
  const { output, status } = runCli(['--provider']);
  assert.equal(status, 1);
  assert.match(output, /--provider 后缺少值/);
});

test('--provider 后面跟另一个 flag 时按缺少值处理', () => {
  const { output, status } = runCli(['--provider', '--account']);
  assert.equal(status, 1);
  assert.match(output, /--provider 后缺少值/);
});
