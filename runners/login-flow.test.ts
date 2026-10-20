import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoginFlow, type LoginApi } from './login-flow.ts';

const calls: string[] = [];
const okApi: LoginApi = {
  async sendSmsCode(phone) {
    calls.push(`sms:${phone}`);
  },
  async loginWithSms(phone, code) {
    calls.push(`login:${phone}:${code}`);
    return { accessToken: 'at-1', refreshToken: 'rt-1' };
  },
};

function withTempDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'login-flow-'));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  '参数化登录把 refreshToken 写进指定目录的 .env',
  withTempDir(async (dir) => {
    const code = await runLoginFlow('WORKBUDDY_REFRESH_TOKEN', okApi, {
      argv: ['--phone', '13800138000', '--code', '123456'],
      cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, '.env'), 'utf-8'), 'WORKBUDDY_REFRESH_TOKEN=rt-1\n');
    assert.deepEqual(calls, ['login:13800138000:123456']);
  }),
);

test(
  '发送验证码模式只发短信，不写 .env',
  withTempDir(async (dir) => {
    const code = await runLoginFlow('WORKBUDDY_REFRESH_TOKEN', okApi, {
      argv: ['--send-sms', '13800138000'],
      cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, '.env')), false);
    assert.deepEqual(calls.at(-1), 'sms:13800138000');
  }),
);

test(
  '登录失败返回退出码 1 且不写 .env',
  withTempDir(async (dir) => {
    const failing: LoginApi = {
      async sendSmsCode() {},
      async loginWithSms() {
        throw new Error('验证码错误');
      },
    };
    const code = await runLoginFlow('WORKBUDDY_REFRESH_TOKEN', failing, {
      argv: ['--phone', '13800138000', '--code', '123456'],
      cwd: dir,
    });
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, '.env')), false);
  }),
);

test(
  '参数化登录加 --print 只打印 token，不落盘',
  withTempDir(async (dir) => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void logs.push(parts.join(' '));
    let code: number;
    try {
      code = await runLoginFlow('WORKBUDDY_REFRESH_TOKEN', okApi, {
        argv: ['--phone', '13800138000', '--code', '123456', '--print'],
        cwd: dir,
      });
    } finally {
      console.log = original;
    }
    assert.equal(code, 0);
    assert.ok(logs.includes('rt-1'));
    assert.equal(existsSync(join(dir, '.env')), false);
  }),
);

test(
  '参数非法返回退出码 1',
  withTempDir(async (dir) => {
    const code = await runLoginFlow('WORKBUDDY_REFRESH_TOKEN', okApi, {
      argv: ['--phone', '13800138000'],
      cwd: dir,
    });
    assert.equal(code, 1);
  }),
);
