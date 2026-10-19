import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistRotatedTokens, rotationNotices } from './token-rotation.ts';
import type { AccountResult, RunResult } from './types.ts';

function runResult(results: AccountResult[]): RunResult {
  return { startedAt: '', finishedAt: '', total: results.length, succeeded: results.length, results };
}

test('轮换的 token 按 refreshTokenEnv=token 写入文件', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rot-')), 'tokens.txt');
  const lines = persistRotatedTokens(
    runResult([
      {
        account: 'main',
        provider: 'workbuddy',
        ok: true,
        message: '',
        durationMs: 1,
        refreshTokenEnv: 'WORKBUDDY_REFRESH_TOKEN',
        rotatedRefreshToken: 'rt-new',
      },
    ]),
    file,
  );
  assert.deepEqual(lines, ['WORKBUDDY_REFRESH_TOKEN=rt-new']);
  assert.equal(readFileSync(file, 'utf-8'), 'WORKBUDDY_REFRESH_TOKEN=rt-new\n');
});

test('无轮换时不创建文件', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rot-')), 'tokens.txt');
  const lines = persistRotatedTokens(
    runResult([{ account: 'main', provider: 'workbuddy', ok: true, message: '', durationMs: 1 }]),
    file,
  );
  assert.deepEqual(lines, []);
  assert.equal(existsSync(file), false);
});

test('rotationNotices 返回轮换账号的 Secret 名与新 token', () => {
  const notices = rotationNotices(
    runResult([
      {
        account: 'main',
        provider: 'workbuddy',
        ok: true,
        message: '',
        durationMs: 1,
        refreshTokenEnv: 'WORKBUDDY_REFRESH_TOKEN',
        rotatedRefreshToken: 'rt-new',
      },
      { account: 'second', provider: 'workbuddy', ok: true, message: '', durationMs: 1 },
    ]),
  );
  assert.deepEqual(notices, [{ name: 'WORKBUDDY_REFRESH_TOKEN', token: 'rt-new' }]);
});

test('rotationNotices 无 refreshTokenEnv 时回落 provider/account 名', () => {
  const notices = rotationNotices(
    runResult([
      {
        account: 'main',
        provider: 'workbuddy',
        ok: true,
        message: '',
        durationMs: 1,
        rotatedRefreshToken: 'rt-new',
      },
    ]),
  );
  assert.deepEqual(notices, [{ name: 'workbuddy/main', token: 'rt-new' }]);
});

test('rotationNotices 无轮换时返回空', () => {
  assert.deepEqual(
    rotationNotices(runResult([{ account: 'main', provider: 'workbuddy', ok: true, message: '', durationMs: 1 }])),
    [],
  );
});
