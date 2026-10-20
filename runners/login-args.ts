export type LoginArgs =
  | { mode: 'send-sms'; phone: string }
  | { mode: 'login'; phone: string; code: string; print: boolean }
  | { mode: 'interactive'; print: boolean };

const PHONE_RE = /^\d{11}$/;
const CODE_RE = /^\d{4,8}$/;

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1]?.trim();
  return value && !value.startsWith('--') ? value : undefined;
}

// 桌面壳用 flag 触发表意，手机号/验证码走环境变量，避免出现在 ps 的命令行里
const ENV_PHONE = 'AIPUNCH_LOGIN_PHONE';
const ENV_CODE = 'AIPUNCH_LOGIN_CODE';

// 参数化模式供桌面壳调用；无参数时回落到交互模式
export function parseLoginArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): LoginArgs {
  if (args.includes('--send-sms')) {
    const phone = flagValue(args, '--send-sms') ?? env[ENV_PHONE]?.trim();
    if (!phone) throw new Error('--send-sms 缺少手机号');
    if (!PHONE_RE.test(phone)) throw new Error('手机号格式不正确');
    return { mode: 'send-sms', phone };
  }
  const phone = flagValue(args, '--phone') ?? env[ENV_PHONE]?.trim();
  const code = flagValue(args, '--code') ?? env[ENV_CODE]?.trim();
  const print = args.includes('--print');
  if (args.includes('--phone') || args.includes('--code')) {
    if (!phone || !code) throw new Error('--phone 与 --code 需同时提供');
    if (!PHONE_RE.test(phone)) throw new Error('手机号格式不正确');
    if (!CODE_RE.test(code)) throw new Error('验证码格式不正确');
    return { mode: 'login', phone, code, print };
  }
  return { mode: 'interactive', print };
}

// 登录响应缺 refreshToken 时只能存短期 accessToken，必须让调用方看见警告
export function chooseCredential(
  refreshToken: string,
  accessToken: string,
): { value: string; warning?: string } {
  if (refreshToken) return { value: refreshToken };
  return {
    value: accessToken,
    warning: '警告：登录响应没有 refreshToken，已保存短期 accessToken，到期需重新登录。',
  };
}
