import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCredential, parseLoginArgs } from './login-args.ts';

test('--send-sms 解析出手机号', () => {
  assert.deepEqual(parseLoginArgs(['--send-sms', ' 13800138000 ']), {
    mode: 'send-sms',
    phone: '13800138000',
  });
});

test('--send-sms 手机号非法时报错', () => {
  assert.throws(() => parseLoginArgs(['--send-sms', '123']), /手机号格式不正确/);
  assert.throws(() => parseLoginArgs(['--send-sms']), /缺少手机号/);
});

test('--phone/--code 解析出登录参数', () => {
  assert.deepEqual(parseLoginArgs(['--phone', '13800138000', '--code', '123456']), {
    mode: 'login',
    phone: '13800138000',
    code: '123456',
    print: false,
  });
  assert.deepEqual(parseLoginArgs(['--phone', '13800138000', '--code', '123456', '--print']), {
    mode: 'login',
    phone: '13800138000',
    code: '123456',
    print: true,
  });
});

test('--phone/--code 缺一项或格式非法时报错', () => {
  assert.throws(() => parseLoginArgs(['--phone', '13800138000']), /需同时提供/);
  assert.throws(() => parseLoginArgs(['--phone', '123', '--code', '123456']), /手机号格式不正确/);
  assert.throws(() => parseLoginArgs(['--phone', '13800138000', '--code', '12']), /验证码格式不正确/);
});

test('无参数进入交互模式，--print 透传', () => {
  assert.deepEqual(parseLoginArgs([]), { mode: 'interactive', print: false });
  assert.deepEqual(parseLoginArgs(['--print']), { mode: 'interactive', print: true });
});

test('下一个 flag 不会被当成缺值参数的值', () => {
  assert.throws(() => parseLoginArgs(['--send-sms', '--phone', '13800138000']), /缺少手机号/);
  assert.throws(() => parseLoginArgs(['--phone', '--code', '123456']), /需同时提供/);
});

test('flag 无值时从环境变量取手机号/验证码（避免出现在命令行）', () => {
  const env = { AIPUNCH_LOGIN_PHONE: '13800138000', AIPUNCH_LOGIN_CODE: '123456' };
  assert.deepEqual(parseLoginArgs(['--send-sms'], env), {
    mode: 'send-sms',
    phone: '13800138000',
  });
  assert.deepEqual(parseLoginArgs(['--phone', '--code'], env), {
    mode: 'login',
    phone: '13800138000',
    code: '123456',
    print: false,
  });
  assert.throws(() => parseLoginArgs(['--send-sms'], {}), /缺少手机号/);
});

test('缺少 refreshToken 时回退 accessToken 并给出警告', () => {
  assert.deepEqual(chooseCredential('refresh-1', 'access-1'), { value: 'refresh-1' });
  const fallback = chooseCredential('', 'access-1');
  assert.equal(fallback.value, 'access-1');
  assert.match(fallback.warning ?? '', /refreshToken/);
});
